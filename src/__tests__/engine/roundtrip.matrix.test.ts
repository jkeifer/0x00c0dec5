/**
 * End-to-end round-trip matrix (remediation plan Phase 1, task 1.1).
 *
 * Runs the full pipeline — generate → typeAssign → chunk → linearize → encode →
 * metadata → write → read — via `computePipelineStages` and compares
 * `readResult.reconstructedValues` against the original generated logical values.
 *
 * This is intentionally NOT a full cross-product. It covers each axis listed in
 * docs/remediation-plan.md (Phase 1, task 1.1) against a base config, plus a
 * hand-picked set of "nasty" combinations that are most likely to expose the
 * predicted-broken behaviors from Part 1 of the plan:
 *   - DC-1: multi-chunk 2-D read reassembly ignores chunk geometry
 *   - DC-2: delta codec is irreversible on unsigned dtypes with decreasing values
 *   - DC-3: per-chunk file ordering uses only the last number in the filename
 *   - RP-1: binary metadata + footer placement is unreadable
 *
 * Predicted-broken cases are pinned with `it.fails` (asserting the CORRECT
 * behavior) so this suite goes green today and turns red — as a signal to
 * flip to `it()` — the moment Phase 2 fixes land.
 *
 * The D1 (footerLocator) and D3 (includeChunkIndex) axes from the plan target
 * state fields that do not exist yet (`AppState.write.footerLocator`,
 * `AppState.metadata.includeChunkIndex`) and a `ReadFailureReason` taxonomy
 * that hasn't been implemented (`ReadFileResult` is still a two-shape
 * success/failure union with a plain `errorMessage`). Adding those fields to
 * fixtures here would not compile, so those cases are `it.todo`.
 */
import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../hooks/usePipeline.ts';
import { generateValues } from '../../engine/generate.ts';
import { DEFAULT_STATE, DEFAULT_VARIABLES } from '../../types/state.ts';
import type { AppState, Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Deep-enough merge for our nested AppState shape (shape/variables arrays replace, not merge). */
function stateWith(overrides: {
  shape?: number[];
  chunkShape?: number[];
  interleaving?: AppState['interleaving'];
  variables?: Variable[];
  fieldPipelines?: Record<string, CodecStep[]>;
  chunkPipeline?: CodecStep[];
  metadata?: Partial<AppState['metadata']>;
  write?: Partial<AppState['write']>;
}): AppState {
  return {
    ...DEFAULT_STATE,
    ...(overrides.shape ? { shape: overrides.shape } : {}),
    ...(overrides.chunkShape ? { chunkShape: overrides.chunkShape } : {}),
    ...(overrides.interleaving ? { interleaving: overrides.interleaving } : {}),
    ...(overrides.variables ? { variables: overrides.variables } : {}),
    ...(overrides.fieldPipelines ? { fieldPipelines: overrides.fieldPipelines } : {}),
    ...(overrides.chunkPipeline ? { chunkPipeline: overrides.chunkPipeline } : {}),
    metadata: { ...DEFAULT_STATE.metadata, ...overrides.metadata },
    write: { ...DEFAULT_STATE.write, includeMetadata: true, ...overrides.write },
  };
}

/** The default 3-variable schema (temperature float32, pressure float32, humidity uint16). */
function defaultVarsFieldPipelines(steps: CodecStep[] = []): Record<string, CodecStep[]> {
  return {
    temperature: steps,
    pressure: steps,
    humidity: steps,
  };
}

/** A float64 "continuous" variable — exercises the float64 dtype axis. */
const FLOAT64_VAR: Variable = {
  id: 'reading',
  name: 'reading',
  color: '#8899ff',
  logicalType: { type: 'continuous', min: -1000, max: 1000, significantFigures: 10 },
  typeAssignment: { storageDtype: 'float64' },
};

/** A small uint16 variable for isolated codec-pipeline tests (mirrors humidity's dtype). */
function uintVar(name: string): Variable {
  return {
    id: name,
    name,
    color: '#98c379',
    logicalType: { type: 'integer', min: 0, max: 100 },
    typeAssignment: { storageDtype: 'uint16' },
  };
}

interface RunResult {
  success: boolean;
  errorMessage?: string;
  expectedByVar: Map<string, number[]>;
  actualByVar: Map<string, number[]>;
  isLossyByVar: Map<string, boolean>;
}

/**
 * Run the full pipeline for a state and collect expected (regenerated logical
 * values) vs. actual (readResult.reconstructedValues) per variable, plus
 * lossiness info from variableStats.
 */
function runRoundTrip(state: AppState): RunResult {
  const { readResult, variableStats } = computePipelineStages(state);
  const totalElements = state.shape.reduce((a, b) => a * b, 1);

  const expectedByVar = new Map<string, number[]>();
  for (const v of state.variables) {
    expectedByVar.set(v.name, generateValues(v.name, v.logicalType, totalElements));
  }

  const actualByVar = new Map<string, number[]>();
  if (readResult.success) {
    for (const v of state.variables) {
      actualByVar.set(v.name, readResult.reconstructedValues.get(v.name) ?? []);
    }
  }

  const isLossyByVar = new Map<string, boolean>();
  for (const v of state.variables) {
    isLossyByVar.set(v.name, variableStats.get(v.name)?.isLossy ?? false);
  }

  return {
    success: readResult.success,
    errorMessage: readResult.success ? undefined : readResult.errorMessage,
    expectedByVar,
    actualByVar,
    isLossyByVar,
  };
}

/** Assert exact equality for every variable (lossless configs). */
function expectExactRoundTrip(result: RunResult, varNames: string[]): void {
  expect(result.success).toBe(true);
  for (const name of varNames) {
    const expected = result.expectedByVar.get(name)!;
    const actual = result.actualByVar.get(name)!;
    expect(actual.length).toBe(expected.length);
    expect(actual).toEqual(expected);
  }
}

/** Assert bounded-error equality for a lossy variable, and that lossyVariables/stats agree. */
function expectLossyRoundTrip(
  state: AppState,
  result: RunResult,
  varName: string,
  maxAbsError: number,
): void {
  expect(result.success).toBe(true);
  const { readResult } = computePipelineStages(state);
  expect(readResult.success).toBe(true);
  if (!readResult.success) return;
  expect(readResult.lossyVariables.has(varName)).toBe(true);
  expect(result.isLossyByVar.get(varName)).toBe(true);

  const expected = result.expectedByVar.get(varName)!;
  const actual = result.actualByVar.get(varName)!;
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(maxAbsError);
  }
}

// ─── Base config sanity (lossless, 1-D, single chunk) ──────────────────

/**
 * The default schema mixes a lossless dtype (humidity: uint16, exact integers)
 * with lossy dtypes (temperature/pressure: float32 storage of decimal logical
 * values — float32 cannot exactly represent every one-decimal-place value).
 * Assert exact equality for the lossless variable and bounded error + a
 * truthful lossyVariables flag for the lossy ones.
 */
function expectDefaultSchemaRoundTrip(state: AppState, result: RunResult): void {
  expect(result.success).toBe(true);
  const expectedHumidity = result.expectedByVar.get('humidity')!;
  const actualHumidity = result.actualByVar.get('humidity')!;
  expect(actualHumidity).toEqual(expectedHumidity);

  for (const name of ['temperature', 'pressure']) {
    expectLossyRoundTrip(state, result, name, 0.01);
  }
}

describe('roundtrip matrix — base config', () => {
  it('default state (1-D shape [32], column interleaving, no codecs) round-trips within contract', () => {
    const state = stateWith({});
    const result = runRoundTrip(state);
    expectDefaultSchemaRoundTrip(state, result);
  });

  it('base config in row interleaving round-trips within contract', () => {
    const state = stateWith({ interleaving: 'row' });
    const result = runRoundTrip(state);
    expectDefaultSchemaRoundTrip(state, result);
  });
});

// ─── Shapes × chunkShapes ────────────────────────────────────────────────

describe('roundtrip matrix — shapes x chunkShapes (1-D, always fine)', () => {
  const shapes: number[][] = [[7], [4, 4], [3, 5]];

  for (const shape of shapes) {
    if (shape.length !== 1) continue;
    it(`shape ${JSON.stringify(shape)} with full-shape chunk round-trips exactly`, () => {
      const state = stateWith({
        shape,
        chunkShape: shape,
        variables: [uintVar('humidity')],
        fieldPipelines: { humidity: [] },
      });
      const result = runRoundTrip(state);
      expectExactRoundTrip(result, ['humidity']);
    });
  }
});

describe('roundtrip matrix — 2-D single-chunk (chunkShape = full shape) works today', () => {
  it('shape [4,4] chunkShape [4,4] column mode round-trips exactly', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [4, 4],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  it('shape [3,5] chunkShape [3,5] row mode round-trips exactly', () => {
    const state = stateWith({
      shape: [3, 5],
      chunkShape: [3, 5],
      interleaving: 'row',
      variables: [uintVar('humidity')],
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });
});

describe('roundtrip matrix — 2-D multi-chunk (DC-1)', () => {
  // KNOWN BUG DC-1 — reconstructValues/reconstructFromChunkFiles ignore chunk
  // geometry (_chunkShape/_shape are unused) and concatenate decoded chunk
  // streams in file order, treating them as flat row-major. Verified: reports
  // success:true with scrambled values. Flip to it() when Phase 2 (task 2.1)
  // lands chunk-coords-based reassembly.
  it.fails('shape [4,4] chunkShape [2,2] column mode reconstructs exact values', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // KNOWN BUG DC-1 — same defect, non-dividing chunk shape (ragged edge chunks),
  // row interleaving. Verified: success:true, scrambled values.
  it.fails('shape [3,5] chunkShape [3,3] row mode reconstructs exact values (ragged chunks)', () => {
    const state = stateWith({
      shape: [3, 5],
      chunkShape: [3, 3],
      interleaving: 'row',
      variables: [uintVar('humidity')],
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // KNOWN BUG DC-1 — column-major chunkOrder compounds the geometry bug since
  // the reader never consults chunk_index coords. Verified: success:true,
  // scrambled values (different scramble pattern than row-major).
  it.fails('shape [4,4] chunkShape [2,2] column-major chunkOrder reconstructs exact values', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
      write: { chunkOrder: 'column-major' },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // KNOWN BUG DC-1 — non-dividing chunkShape [3,3] on shape [4,4] (both dims ragged).
  it.fails('shape [4,4] chunkShape [3,3] reconstructs exact values (ragged both dims)', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [3, 3],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });
});

// ─── Codec pipelines ─────────────────────────────────────────────────────

describe('roundtrip matrix — codec pipelines (1-D single chunk, lossless dtype)', () => {
  // Use a signed dtype (int16) so delta's clamp-on-encode doesn't corrupt
  // decreasing sequences — isolates the codec-pipeline plumbing from DC-2.
  const signedVar: Variable = {
    id: 'x', name: 'x', color: '#fff',
    logicalType: { type: 'integer', min: -500, max: 500 },
    typeAssignment: { storageDtype: 'int16' },
  };

  const pipelines: { label: string; steps: CodecStep[] }[] = [
    { label: 'empty', steps: [] },
    { label: '[delta]', steps: [{ codec: 'delta', params: { order: 1 } }] },
    { label: '[byte-shuffle]', steps: [{ codec: 'byte-shuffle', params: { elementSize: 2 } }] },
    {
      label: '[delta, byte-shuffle, rle]',
      steps: [
        { codec: 'delta', params: { order: 1 } },
        { codec: 'byte-shuffle', params: { elementSize: 2 } },
        { codec: 'rle', params: {} },
      ],
    },
    { label: '[lz]', steps: [{ codec: 'lz', params: { windowSize: 256 } }] },
  ];

  for (const { label, steps } of pipelines) {
    it(`pipeline ${label} round-trips exactly on signed int16`, () => {
      const state = stateWith({
        shape: [7],
        chunkShape: [7],
        variables: [signedVar],
        fieldPipelines: { x: steps },
      });
      const result = runRoundTrip(state);
      expectExactRoundTrip(result, ['x']);
    });
  }

  it('[delta, byte-shuffle, rle] in row mode (chunkPipeline) round-trips exactly', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      interleaving: 'row',
      variables: [signedVar],
      chunkPipeline: [
        { codec: 'delta', params: { order: 1 } },
        { codec: 'byte-shuffle', params: { elementSize: 2 } },
        { codec: 'rle', params: {} },
      ],
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['x']);
  });
});

describe('roundtrip matrix — delta codec on unsigned dtype (DC-2)', () => {
  // KNOWN BUG DC-2 — delta encode/decode round-and-clamp to the dtype range
  // (codecs.ts), so any negative diff on an unsigned dtype (uint16 humidity,
  // the default variable) clamps to 0 instead of wrapping. Verified:
  // uint16 [50,32,67,25,...] (has decreasing steps) -> round-trip ->
  // [50,50,85,85,...]. lossyVariables does NOT flag this (the codec `lossy`
  // flag from the extension spec was never implemented) — so both the exact
  // value assertion AND the truthful-lossy assertion fail today.
  // Flip to it() when Phase 2 (task 2.5/2.6) removes the clamp and implements
  // CodecDefinition.lossy.
  it.fails('uint16 humidity with [delta] reconstructs exact values (decreasing sequence)', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [{ codec: 'delta', params: { order: 1 } }] },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // KNOWN BUG DC-2 — same defect compounded with byte-shuffle + rle in the
  // pipeline (the full "nasty" combination from the task list).
  it.fails('uint16 humidity with [delta, byte-shuffle, rle] reconstructs exact values', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      variables: [uintVar('humidity')],
      fieldPipelines: {
        humidity: [
          { codec: 'delta', params: { order: 1 } },
          { codec: 'byte-shuffle', params: { elementSize: 2 } },
          { codec: 'rle', params: {} },
        ],
      },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // KNOWN BUG DC-2 — default 3-variable schema (the exact scenario named in
  // the plan: "on the default humidity variable") with delta applied to all
  // fields via the default field pipelines shape.
  it.fails('default variables with delta on humidity reconstructs exact values', () => {
    const state = stateWith({
      variables: DEFAULT_VARIABLES,
      fieldPipelines: {
        temperature: [],
        pressure: [],
        humidity: [{ codec: 'delta', params: { order: 1 } }],
      },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });
});

// ─── Variables (dtype coverage) ──────────────────────────────────────────

describe('roundtrip matrix — variable dtype coverage', () => {
  it('default variables (float32 x2 + uint16) round-trip within tolerance, no codecs', () => {
    const state = stateWith({
      variables: DEFAULT_VARIABLES,
      fieldPipelines: defaultVarsFieldPipelines(),
    });
    const { readResult, variableStats } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    const totalElements = state.shape.reduce((a, b) => a * b, 1);
    for (const v of state.variables) {
      const expected = generateValues(v.name, v.logicalType, totalElements);
      const actual = readResult.reconstructedValues.get(v.name)!;
      expect(actual.length).toBe(expected.length);
      const isLossy = variableStats.get(v.name)?.isLossy ?? false;
      const tol = isLossy ? 0.01 : 1e-9;
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('float64 "continuous" variable round-trips exactly (lossless storage)', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      variables: [FLOAT64_VAR],
      fieldPipelines: { reading: [] },
    });
    const { variableStats } = computePipelineStages(state);
    expect(variableStats.get('reading')?.isLossy).toBe(false);
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['reading']);
  });

  it('float64 variable combined with default variables round-trips (mixed dtypes, column mode)', () => {
    const variables = [...DEFAULT_VARIABLES, FLOAT64_VAR];
    const state = stateWith({
      variables,
      fieldPipelines: { ...defaultVarsFieldPipelines(), reading: [] },
    });
    const { readResult, variableStats } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;
    const totalElements = state.shape.reduce((a, b) => a * b, 1);
    for (const v of variables) {
      const expected = generateValues(v.name, v.logicalType, totalElements);
      const actual = readResult.reconstructedValues.get(v.name)!;
      const isLossy = variableStats.get(v.name)?.isLossy ?? false;
      const tol = isLossy ? 0.01 : 1e-9;
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('lossy float32 storage of decimal values is flagged truthfully and bounded', () => {
    const state = stateWith({
      shape: [16],
      chunkShape: [16],
      variables: [DEFAULT_VARIABLES[0]], // temperature: decimal -> float32
      fieldPipelines: { temperature: [] },
    });
    const result = runRoundTrip(state);
    expectLossyRoundTrip(state, result, 'temperature', 0.01);
  });
});

// ─── Metadata serialization x placement ─────────────────────────────────

describe('roundtrip matrix — metadata serialization x placement', () => {
  const placements: AppState['write']['metadataPlacement'][] = ['header', 'footer', 'sidecar'];
  const serializations: AppState['metadata']['serialization'][] = ['json', 'binary'];

  for (const serialization of serializations) {
    for (const placement of placements) {
      const isBrokenBinaryFooter = serialization === 'binary' && placement === 'footer';

      const title = `serialization=${serialization} placement=${placement} round-trips`;

      if (isBrokenBinaryFooter) {
        // KNOWN BUG RP-1 — tryParseEmbeddedMetadata's footer branch only
        // searches for JSON braces; there is no binary path. Verified live:
        // footer+binary+includeMetadata -> success:false with the generic
        // "no metadata" message, even though metadata IS in the file.
        // Flip to it() when Phase 2 (task 2.3/2.4) adds the footer
        // locator/trailer and a binary backward scan.
        it.fails(title, () => {
          const state = stateWith({
            metadata: { serialization },
            write: { metadataPlacement: placement },
          });
          const result = runRoundTrip(state);
          expectExactRoundTrip(result, ['temperature', 'pressure', 'humidity']);
        });
      } else {
        it(title, () => {
          const state = stateWith({
            metadata: { serialization },
            write: { metadataPlacement: placement },
          });
          const { readResult, variableStats } = computePipelineStages(state);
          expect(readResult.success).toBe(true);
          if (!readResult.success) return;
          const totalElements = state.shape.reduce((a, b) => a * b, 1);
          for (const v of state.variables) {
            const expected = generateValues(v.name, v.logicalType, totalElements);
            const actual = readResult.reconstructedValues.get(v.name)!;
            const isLossy = variableStats.get(v.name)?.isLossy ?? false;
            const tol = isLossy ? 0.01 : 1e-9;
            for (let i = 0; i < expected.length; i++) {
              expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tol);
            }
          }
        });
      }
    }
  }
});

// ─── chunkOrder row/column-major (1-D, so DC-1 doesn't interfere) ──────────

describe('roundtrip matrix — chunkOrder row-major vs column-major (1-D multi-chunk)', () => {
  const orders: AppState['write']['chunkOrder'][] = ['row-major', 'column-major'];

  for (const chunkOrder of orders) {
    it(`chunkOrder=${chunkOrder} with shape [16] chunkShape [8] round-trips exactly`, () => {
      const state = stateWith({
        shape: [16],
        chunkShape: [8],
        variables: [uintVar('humidity')],
        fieldPipelines: { humidity: [] },
        write: { chunkOrder },
      });
      const result = runRoundTrip(state);
      expectExactRoundTrip(result, ['humidity']);
    });
  }
});

// ─── Partitioning: single vs per-chunk ───────────────────────────────────

describe('roundtrip matrix — partitioning single vs per-chunk', () => {
  it('partitioning=single with shape [16] chunkShape [8] round-trips exactly', () => {
    const state = stateWith({
      shape: [16],
      chunkShape: [8],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
      write: { partitioning: 'single' },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  it('partitioning=per-chunk with 1-D shape [16] chunkShape [8] round-trips exactly', () => {
    const state = stateWith({
      shape: [16],
      chunkShape: [8],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
      write: { partitioning: 'per-chunk' },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // KNOWN BUG DC-3 — extractChunkIndexFromName sorts per-chunk files by only
  // the LAST number in the filename, so 2-D chunk files named like
  // "humidity_chunk_0_0", "humidity_chunk_1_0", "humidity_chunk_0_1",
  // "humidity_chunk_1_1" sort as [0_0, 1_0, 0_1, 1_1] — wrong order for
  // row-major reassembly. The reader also ignores the sidecar's chunk_index
  // coords in per-chunk mode. Verified: success:true, scrambled values
  // (compounds DC-1). Flip to it() when Phase 2 (task 2.1) lands
  // coords-based reassembly for per-chunk files too.
  it.fails('partitioning=per-chunk with 2-D shape [4,4] chunkShape [2,2] round-trips exactly', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
      write: { partitioning: 'per-chunk' },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });
});

// ─── No-metadata failure path (explicit negative test) ──────────────────

describe('roundtrip matrix — no metadata means no read (explicit failure case)', () => {
  it('includeMetadata=false fails with the pedagogical no-metadata message', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: false },
    };
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(false);
    if (!readResult.success) {
      expect(readResult.errorMessage).toContain('no metadata');
    }
  });
});

// ─── D1 / D3 axes — state fields not yet implemented ─────────────────────
//
// These target Phase 2 state additions (write.footerLocator, D1;
// metadata.includeChunkIndex, D3) and the D4 ReadFailureReason taxonomy.
// None of these exist on AppState/ReadFileResult yet, so fixtures referencing
// them would fail to compile. Recorded as it.todo per the D1/D3/D4 contracts
// so the intent and acceptance shape is visible before Phase 2 lands.

it.todo('D1: footerLocator="trailer" + binary + footer round-trips exactly (Parquet-style length trailer)');
it.todo('D1: footerLocator="trailer" + json + footer round-trips exactly');
it.todo(
  'D1: footerLocator="none" + binary + footer fails with reason "metadata-not-found" ' +
  '(best-effort backward scan legitimately cannot locate binary metadata without a length trailer)',
);
it.todo(
  'D1: footerLocator="none" + json + footer round-trips exactly via string-literal-aware brace scan ' +
  '(fixes RP-2 false positive on braces inside custom metadata string values)',
);

it.todo('D3: metadata.includeChunkIndex=true (default) round-trips exactly, chunk_index present in metadata');
it.todo(
  'D3: metadata.includeChunkIndex=false with a size-preserving pipeline ([delta] or [byte-shuffle]) ' +
  'round-trips exactly via computed offsets (chunkShape x dtype size)',
);
it.todo(
  'D3: metadata.includeChunkIndex=false with a size-changing codec ([rle] or [lz]) fails with reason ' +
  '"no-chunk-index" ("the chunks have variable size after compression and nothing in the file records ' +
  'where each one starts")',
);

it.todo('D4: ReadFailureReason is one of the six pinned taxonomy values on every failure path');
it.todo('D2: bad magic number on read produces reason "bad-magic" (reader verifies leading magic per D2)');
