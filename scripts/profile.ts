// scripts/profile.ts — per-stage timing/heap harness (spec Phase 1).
// Run: npm run profile            (all sizes; 1M may OOM pre-lazy-traces — that IS the baseline finding)
//      npm run profile -- --sizes=10000,100000
//      npm run profile -- --lz     (every variable gets an LZ codec step — Phase 4-5 exit measurement)
// For heap numbers, prefix: NODE_OPTIONS=--expose-gc
import { DEFAULT_STATE } from '../src/types/state.ts';
import type { AppState } from '../src/types/state.ts';
import {
  computeValuesStage, computeTypedStage, computeLinearizedStage,
  computeEncodedStage, computeMetadataStage, computeFilesStage, computeReadStage,
} from '../src/hooks/usePipeline.ts';

const sizesArg = process.argv.find((a) => a.startsWith('--sizes='));
const SIZES = sizesArg
  ? sizesArg.slice('--sizes='.length).split(',').map(Number)
  : [10_000, 100_000, 1_000_000];
const USE_LZ = process.argv.includes('--lz');

function makeState(totalElements: number): AppState {
  // Square-ish 2D array shape; 3 variables from DEFAULT_STATE keep the run
  // representative (float dtypes, default pipelines).
  const side = Math.round(Math.sqrt(totalElements));
  const state: AppState = { ...DEFAULT_STATE, dataModel: 'array', shape: [side, side], chunkShape: [side, side] };
  if (USE_LZ) {
    state.fieldPipelines = Object.fromEntries(
      state.variables.map((v) => [v.id, [{ codec: 'lz', params: { windowSize: 4096 } }]]),
    );
  }
  return state;
}

function heap(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed;
}

function measure<T>(label: string, fn: () => T, rows: string[][]): T {
  const h0 = heap();
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  const dMB = (heap() - h0) / (1024 * 1024);
  rows.push([label, ms.toFixed(1), dMB.toFixed(1)]);
  return out;
}

for (const size of SIZES) {
  const state = makeState(size);
  const total = state.shape.reduce((a, b) => a * b, 1);
  console.log(`\n=== ${total.toLocaleString()} elements (shape ${state.shape.join('x')}, ${state.variables.length} variables) ===`);
  const rows: string[][] = [['stage', 'ms', 'heapΔ MB']];
  try {
    const values = measure('values', () => computeValuesStage(state.shape, state.variables), rows);
    const typed = measure('typed', () => computeTypedStage(state.shape, state.variables, values.variableValues), rows);
    const lin = measure('linearized', () => computeLinearizedStage(state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues), rows);
    const enc = measure('encoded', () => computeEncodedStage(lin.chunks, lin.linearizedChunks, state.interleaving, state.variables, state.fieldPipelines, state.chunkPipeline, lin.stage.layout), rows);
    measure('metadata', () => computeMetadataStage(state, enc.encodedChunks, typed.variableStats), rows);
    const files = measure('write', () => computeFilesStage(state, enc.encodedChunks, typed.variableStats, enc.stage.layout), rows);
    measure('read', () => computeReadStage(files.files, state.shape, state.variables, state.write.magicNumber), rows);
  } catch (err) {
    rows.push(['FAILED', String(err instanceof Error ? err.message : err), '']);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  for (const r of rows) console.log(r.map((cell, c) => (cell ?? '').padEnd(widths[c] + 2)).join(''));
}
