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
 *     — FIXED by Phase 2 task 2.1 (coords-based reassembly); cases flipped to `it()`.
 *   - DC-2: delta codec is irreversible on unsigned dtypes with decreasing values
 *     — FIXED by Phase 2 task 2.5 (clamp removed); cases flipped to plain `it()`.
 *   - DC-3: per-chunk file ordering uses only the last number in the filename
 *     — FIXED by Phase 2 task 2.1 (filename-number sort deleted); case flipped to `it()`.
 *   - RP-1: binary metadata + footer placement is unreadable
 *
 * Predicted-broken cases not yet fixed are pinned with `it.fails` (asserting the
 * CORRECT behavior) so this suite goes green today and turns red — as a signal to
 * flip to `it()` — the moment their Phase 2 fixes land.
 *
 * D4 (ReadFailureReason taxonomy) and D2 (magic verification) are implemented
 * (Phase 2 tasks 2.9/2.10) and covered below by real `it()` cases.
 *
 * The D1 (footerLocator) and D3 (includeChunkIndex) axes from the plan target
 * state fields that do not exist yet (`AppState.write.footerLocator`,
 * `AppState.metadata.includeChunkIndex`). Adding those fields to fixtures
 * here would not compile, so those cases remain `it.todo` until their owning
 * tasks (2.3/2.4/2.13) land.
 */
import { describe, it, expect } from 'vitest';
import { computePipelineStages } from '../../../src/hooks/usePipeline.ts';
import { generateValues } from '../../../src/engine/generate.ts';
import { readFile } from '../../../src/engine/read.ts';
import { hexToBytes } from '../../../src/engine/bytes.ts';
import { DEFAULT_STATE, DEFAULT_VARIABLES } from '../../../src/types/state.ts';
import type { AppState, Variable } from '../../../src/types/state.ts';
import type { CodecStep } from '../../../src/types/codecs.ts';

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
  logicalType: { type: 'continuous', min: -1000, max: 1000, significantFigures: 10, generation: 'random' },
  typeAssignment: { storageDtype: 'float64' },
};

/** A small uint16 variable for isolated codec-pipeline tests (mirrors humidity's dtype). */
function uintVar(name: string): Variable {
  return {
    id: name,
    name,
    color: '#98c379',
    logicalType: { type: 'integer', min: 0, max: 100, generation: 'random' },
    typeAssignment: { storageDtype: 'uint16' },
  };
}

interface RunResult {
  success: boolean;
  message?: string;
  reason?: import('../../../src/types/pipeline.ts').ReadFailureReason;
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
    expectedByVar.set(v.name, generateValues(v.name, v.logicalType, totalElements) as number[]);
  }

  const actualByVar = new Map<string, number[]>();
  if (readResult.success) {
    for (const v of state.variables) {
      actualByVar.set(v.name, (readResult.reconstructedValues.get(v.name) ?? []) as number[]);
    }
  }

  const isLossyByVar = new Map<string, boolean>();
  for (const v of state.variables) {
    isLossyByVar.set(v.name, variableStats.get(v.name)?.isLossy ?? false);
  }

  return {
    success: readResult.success,
    message: readResult.success ? undefined : readResult.message,
    reason: readResult.success ? undefined : readResult.reason,
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
  // FIXED DC-1 (Phase 2 task 2.1) — reconstructValues/reconstructFromChunkFiles
  // now reassemble by mapping each decoded chunk's chunk-local row-major
  // elements to their global row-major position via chunk_index coords x
  // chunkShape x shape, instead of concatenating decoded chunk streams in
  // file order and treating the result as flat row-major.
  it('shape [4,4] chunkShape [2,2] column mode reconstructs exact values', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // FIXED DC-1 — same fix, non-dividing chunk shape (ragged edge chunks),
  // row interleaving.
  it('shape [3,5] chunkShape [3,3] row mode reconstructs exact values (ragged chunks)', () => {
    const state = stateWith({
      shape: [3, 5],
      chunkShape: [3, 3],
      interleaving: 'row',
      variables: [uintVar('humidity')],
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // FIXED DC-1 — column-major chunkOrder: reassembly now keys entirely on
  // chunk_index coords, so the physical write order of chunks in the file
  // no longer matters for correctness.
  it('shape [4,4] chunkShape [2,2] column-major chunkOrder reconstructs exact values', () => {
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

  // FIXED DC-1 — non-dividing chunkShape [3,3] on shape [4,4] (both dims ragged).
  it('shape [4,4] chunkShape [3,3] reconstructs exact values (ragged both dims)', () => {
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
  // Signed dtype (int16); isolates the codec-pipeline plumbing from dtype-specific
  // concerns. DC-2 (delta's former clamp-on-encode corrupting decreasing sequences
  // on unsigned dtypes) is fixed as of Phase 2 task 2.5 — see the dedicated
  // "delta codec on unsigned dtype (DC-2)" describe block below.
  const signedVar: Variable = {
    id: 'x', name: 'x', color: '#fff',
    logicalType: { type: 'integer', min: -500, max: 500, generation: 'random' },
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
    { label: '[bit-shuffle]', steps: [{ codec: 'bit-shuffle', params: {} }] },
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
  // FIXED DC-2 (Phase 2 task 2.5) — delta encode/decode used to round-and-clamp
  // to the dtype range (codecs.ts), so any negative diff on an unsigned dtype
  // (uint16 humidity, the default variable) clamped to 0 instead of wrapping.
  // Verified: uint16 [50,32,67,25,...] (has decreasing steps) -> round-trip ->
  // [50,50,85,85,...]. The clamp is now removed — typed-array writes wrap
  // mod 2^N, so encode's wrap and decode's cumsum wrap back exactly.
  it('uint16 humidity with [delta] reconstructs exact values (decreasing sequence)', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [{ codec: 'delta', params: { order: 1 } }] },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  // FIXED DC-2 (Phase 2 task 2.5) — same former defect compounded with
  // byte-shuffle + rle in the pipeline (the full "nasty" combination from the
  // task list).
  it('uint16 humidity with [delta, byte-shuffle, rle] reconstructs exact values', () => {
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

  // FIXED DC-2 (Phase 2 task 2.5) — default 3-variable schema (the exact
  // scenario named in the plan: "on the default humidity variable") with delta
  // applied to all fields via the default field pipelines shape.
  it('default variables with delta on humidity reconstructs exact values', () => {
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
      const expected = generateValues(v.name, v.logicalType, totalElements) as number[];
      const actual = readResult.reconstructedValues.get(v.name)! as number[];
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
      const expected = generateValues(v.name, v.logicalType, totalElements) as number[];
      const actual = readResult.reconstructedValues.get(v.name)! as number[];
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
      const title = `serialization=${serialization} placement=${placement} round-trips`;

      // FIXED RP-1 (Phase 2 tasks 2.3/2.4) — footer + binary now round-trips:
      // `footerLocator` defaults to 'trailer' (D1), which appends a 4-byte LE
      // metadata length before the closing magic. The reader seeks straight
      // to it, working identically for JSON and binary. (The 'none' locator
      // fallback — best-effort scanning that legitimately can fail for
      // binary — is covered separately in the D1 axis below.)
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
          const expected = generateValues(v.name, v.logicalType, totalElements) as number[];
          const actual = readResult.reconstructedValues.get(v.name)! as number[];
          const isLossy = variableStats.get(v.name)?.isLossy ?? false;
          const tol = isLossy ? 0.01 : 1e-9;
          for (let i = 0; i < expected.length; i++) {
            expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tol);
          }
        }
      });
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

  // FIXED DC-3 (Phase 2 task 2.1) — extractChunkIndexFromName (filename-number
  // sorting) is deleted. Per-chunk files are now matched to chunk_index
  // entries by name derived from coords (and variableName in column mode),
  // never by parsing/sorting numbers out of the filename, so 2-D chunk files
  // reassemble correctly regardless of file enumeration order.
  it('partitioning=per-chunk with 2-D shape [4,4] chunkShape [2,2] round-trips exactly', () => {
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
  it('includeMetadata=false fails with reason "no-metadata" and the pedagogical message', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: false },
    };
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(false);
    if (!readResult.success) {
      expect(readResult.reason).toBe('no-metadata');
      expect(readResult.message).toContain('no metadata');
    }
  });
});

// ─── D4 taxonomy / D2 magic verification (Phase 2 tasks 2.9/2.10) ────────

describe('roundtrip matrix — D4 read failure taxonomy', () => {
  it('corrupting a sidecar metadata file\'s bytes fails with reason "corrupt-metadata"', () => {
    const state = stateWith({
      write: { metadataPlacement: 'sidecar' },
    });
    const { files } = computePipelineStages(state);
    const corruptedFiles = files.map((f) =>
      f.name === 'metadata'
        ? { ...f, bytes: new Uint8Array([0xff, 0xfe, 0x01, 0x02, 0x03, 0x9c, 0x00, 0x00]) }
        : f,
    );
    const result = readFile(corruptedFiles, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('corrupt-metadata');
    }
  });

  it('corrupting header-embedded metadata bytes fails with reason "corrupt-metadata"', () => {
    const state = stateWith({
      write: { metadataPlacement: 'header' },
    });
    const { files } = computePipelineStages(state);
    const magicBytes = hexToBytes(state.write.magicNumber);
    const corruptedFiles = files.map((f) => {
      if (f.name !== 'data') return f;
      // The header metadata is pretty-printed JSON: `{\n  "schema": "...",\n
      // ...}`. Locate the `"schema": "` value's opening quote in the actual
      // bytes and scramble characters just inside it — this keeps the outer
      // object's braces balanced (so the locator still finds and slices a
      // complete JSON span, and the outer JSON.parse succeeds), but makes
      // the *inner* `JSON.parse(schemaStr)` throw on the mangled value —
      // i.e. genuinely "located but failed to parse", not "not found".
      const bytes = new Uint8Array(f.bytes);
      const text = new TextDecoder().decode(bytes);
      // The header metadata's "schema" entry is a JSON-encoded array nested
      // inside the outer pretty-printed JSON object, so its embedded quotes
      // are backslash-escaped: `\"name\":\"temperature\",\"dtype\":...`.
      // Replace the comma between the "name" and "dtype" fields (a single
      // byte, not part of any escape sequence) with a letter — this can't
      // unbalance the OUTER JSON's string escaping (so the outer parse and
      // the header's brace-balance locator both still succeed and find a
      // complete, well-formed span), but it breaks the INNER
      // `JSON.parse(schemaStr)` once that string value has been extracted:
      // genuinely "metadata located and read, but its content doesn't
      // parse" rather than "metadata not found".
      const marker = '\\",\\"dtype';
      const markerIdx = text.indexOf(marker);
      expect(markerIdx).toBeGreaterThan(0);
      const commaOffset = markerIdx + 2; // marker = [backslash][quote][comma]...
      bytes[commaOffset] = 'x'.charCodeAt(0);
      return { ...f, bytes };
    });
    const result = readFile(corruptedFiles, { magic: magicBytes });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('corrupt-metadata');
    }
  });

  it('every failure path reports a reason from the pinned six-value taxonomy', () => {
    const validReasons = new Set([
      'no-metadata',
      'metadata-not-found',
      'bad-magic',
      'corrupt-metadata',
      'no-chunk-index',
      'decode-error',
    ]);

    const noMetaState: AppState = {
      ...DEFAULT_STATE,
      write: { ...DEFAULT_STATE.write, includeMetadata: false },
    };
    const { readResult: noMetaResult } = computePipelineStages(noMetaState);
    expect(noMetaResult.success).toBe(false);
    if (!noMetaResult.success) expect(validReasons.has(noMetaResult.reason)).toBe(true);

    const badMagicState = stateWith({});
    const { files } = computePipelineStages(badMagicState);
    const wrongMagic = readFile(files, { magic: hexToBytes('deadbeef') });
    expect(wrongMagic.success).toBe(false);
    if (!wrongMagic.success) expect(validReasons.has(wrongMagic.reason)).toBe(true);
  });
});

describe('roundtrip matrix — D2 magic verification', () => {
  it('wrong magic bytes on read fails with reason "bad-magic"', () => {
    const state = stateWith({});
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes('deadbeef') });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('bad-magic');
      expect(result.message).toContain('magic');
    }
  });

  it('correct magic bytes still round-trip successfully (sanity check for the verification path)', () => {
    const state = stateWith({});
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
  });

  it('zero-length magic (empty string) has nothing to verify and proceeds normally', () => {
    const state = stateWith({ write: { magicNumber: '' } });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    expect(result.success).toBe(true);
  });
});

// ─── D1 axis — footerLocator ──────────────────────────────────────────────

describe('roundtrip matrix — D1 footerLocator', () => {
  it('footerLocator="trailer" + binary + footer round-trips exactly (Parquet-style length trailer)', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
      metadata: { serialization: 'binary' },
      write: { metadataPlacement: 'footer', footerLocator: 'trailer' },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  it('footerLocator="trailer" + json + footer round-trips exactly', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
      metadata: { serialization: 'json' },
      write: { metadataPlacement: 'footer', footerLocator: 'trailer' },
    });
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  it(
    'footerLocator="none" + binary + footer fails with reason "metadata-not-found" ' +
    '(best-effort backward scan legitimately cannot locate binary metadata without a length trailer)',
    () => {
      const state = stateWith({
        write: { metadataPlacement: 'footer', footerLocator: 'none' },
        metadata: { serialization: 'binary' },
      });
      const { readResult } = computePipelineStages(state);
      expect(readResult.success).toBe(false);
      if (!readResult.success) {
        expect(readResult.reason).toBe('metadata-not-found');
        expect(readResult.message).toContain('trailer');
      }
    },
  );

  it(
    'footerLocator="none" + json + footer round-trips exactly via string-literal-aware brace scan ' +
    '(fixes RP-2 false positive on braces inside custom metadata string values)',
    () => {
      const state = stateWith({
        write: { metadataPlacement: 'footer', footerLocator: 'none' },
        metadata: {
          serialization: 'json',
          customEntries: [{ key: 'note', value: 'weird { value' }],
        },
      });
      const { readResult, variableStats } = computePipelineStages(state);
      expect(readResult.success).toBe(true);
      if (!readResult.success) return;
      const totalElements = state.shape.reduce((a, b) => a * b, 1);
      for (const v of state.variables) {
        const expected = generateValues(v.name, v.logicalType, totalElements) as number[];
        const actual = readResult.reconstructedValues.get(v.name)! as number[];
        const isLossy = variableStats.get(v.name)?.isLossy ?? false;
        const tol = isLossy ? 0.01 : 1e-9;
        for (let i = 0; i < expected.length; i++) {
          expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tol);
        }
      }
    },
  );
});

// ─── D3 axis — metadata.include.chunkIndex ─────────────────────────────────

describe('roundtrip matrix — D3 metadata.include.chunkIndex', () => {
  it('metadata.include.chunkIndex=true (default) round-trips exactly, chunk_index present in metadata', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
      metadata: { include: { ...DEFAULT_STATE.metadata.include, chunkIndex: true } },
    });
    expect(state.metadata.include.chunkIndex).toBe(true);
    const { files } = computePipelineStages(state);
    const metaFile = files.find((f) => f.name === 'data') ?? files.find((f) => f.name === 'metadata');
    const text = new TextDecoder().decode(metaFile!.bytes);
    expect(text).toContain('chunk_index');
    const result = runRoundTrip(state);
    expectExactRoundTrip(result, ['humidity']);
  });

  it(
    'metadata.include.chunkIndex=false with a size-preserving pipeline ([delta] or [byte-shuffle]) ' +
    'round-trips exactly via computed offsets (chunkShape x dtype size)',
    () => {
      const deltaState = stateWith({
        shape: [4, 4],
        chunkShape: [2, 2],
        variables: [uintVar('humidity')],
        fieldPipelines: { humidity: [{ codec: 'delta', params: { order: 1 } }] },
        metadata: { include: { ...DEFAULT_STATE.metadata.include, chunkIndex: false } },
      });
      expectExactRoundTrip(runRoundTrip(deltaState), ['humidity']);

      const shuffleState = stateWith({
        shape: [4, 4],
        chunkShape: [2, 2],
        variables: [uintVar('humidity')],
        fieldPipelines: { humidity: [{ codec: 'byte-shuffle', params: { elementSize: 2 } }] },
        metadata: { include: { ...DEFAULT_STATE.metadata.include, chunkIndex: false } },
      });
      expectExactRoundTrip(runRoundTrip(shuffleState), ['humidity']);
    },
  );

  it(
    'metadata.include.chunkIndex=false with a size-changing codec ([rle]) fails with reason ' +
    '"no-chunk-index" ("the chunks have variable size after compression and nothing in the file records ' +
    'where each one starts")',
    () => {
      const rleState = stateWith({
        shape: [4, 4],
        chunkShape: [2, 2],
        variables: [uintVar('humidity')],
        fieldPipelines: { humidity: [{ codec: 'rle', params: {} }] },
        metadata: { include: { ...DEFAULT_STATE.metadata.include, chunkIndex: false } },
      });
      const { readResult: rleResult } = computePipelineStages(rleState);
      expect(rleResult.success).toBe(false);
      if (!rleResult.success) {
        expect(rleResult.reason).toBe('no-chunk-index');
        expect(rleResult.message).toContain('chunk index');
      }
    },
  );
});

// ─── Task 2.6 (surfacing half) — codec lossiness in read results ─────────

describe('roundtrip matrix — codec lossiness surfaced in lossyVariables (task 2.6)', () => {
  const float32Var: Variable = {
    id: 'reading', name: 'reading', color: '#e06c75',
    logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
    typeAssignment: { storageDtype: 'float32' },
  };

  it('float32 variable with [delta] is flagged lossy via the codec path', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      variables: [float32Var],
      fieldPipelines: { reading: [{ codec: 'delta', params: { order: 1 } }] },
    });
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.lossyVariables.has('reading')).toBe(true);
    }
  });

  it('uint16 variable with [delta] is NOT flagged lossy (integer delta is exact post-DC-2 fix)', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [{ codec: 'delta', params: { order: 1 } }] },
    });
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.lossyVariables.has('humidity')).toBe(false);
    }
  });

  it('row mode: chunk-pipeline codec lossiness applies to all variables', () => {
    const state = stateWith({
      shape: [7],
      chunkShape: [7],
      interleaving: 'row',
      variables: [float32Var, uintVar('humidity')],
      chunkPipeline: [{ codec: 'delta', params: { order: 1 } }],
    });
    const { readResult } = computePipelineStages(state);
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      // Row mode's shared chunk pipeline runs on a mixed-dtype byte stream
      // (uint8, since dtypes differ) — delta on uint8 is exact, so this
      // config is NOT expected to be flagged lossy via the codec path. This
      // test instead pins the "all variables share one verdict" contract:
      // isolate to a single float32 variable in row mode, which forces the
      // chunk pipeline's dtype to float32 and delta lossy.
      const soloState = stateWith({
        shape: [7],
        chunkShape: [7],
        interleaving: 'row',
        variables: [float32Var],
        chunkPipeline: [{ codec: 'delta', params: { order: 1 } }],
      });
      const { readResult: soloResult } = computePipelineStages(soloState);
      expect(soloResult.success).toBe(true);
      if (soloResult.success) {
        expect(soloResult.lossyVariables.has('reading')).toBe(true);
      }
    }
  });
});
