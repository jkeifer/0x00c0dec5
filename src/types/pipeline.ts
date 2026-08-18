/**
 * Fixed 7-stage pipeline order (remediation-plan.md decision D5) — the single
 * source of truth for stage identity. `AppState.ui.leftPaneStage` /
 * `rightPaneStage` (types/state.ts) persist one of these names rather than a
 * numeric index (Phase 3.8, fixes SW-2/SW-6/SW-10): stage names survive the
 * stage list growing (it already has, twice — Typed, then Read), whereas a
 * persisted index silently points at the wrong stage after such a change.
 *
 * Placed here (not types/state.ts) because this file has zero imports of its
 * own and is never imported by state.ts's dependencies (dtypes.ts/codecs.ts),
 * so state.ts importing `StageName` from here cannot create a cycle; the
 * reverse (this file importing from state.ts) is never needed.
 */
import type { LogicalValue } from './dtypes.ts';
import type { StageLayout, ValueArray } from '../engine/layout.ts';

export type StageName =
  | 'values'
  | 'typed'
  | 'linearized'
  | 'encoded'
  | 'metadata'
  | 'write'
  | 'read';

export const STAGE_ORDER: StageName[] = [
  'values',
  'typed',
  'linearized',
  'encoded',
  'metadata',
  'write',
  'read',
];

export interface ByteTrace {
  traceId: string;
  variableName: string;
  variableColor: string;
  coords: number[];
  displayValue: string;
  dtype: string;
  chunkId: string;
  byteInValue: number;
  byteCount: number;
}

export interface ChunkRegion {
  label: string;      // chunkId (e.g., 'chunk:0') or structural label ('magic:start', 'metadata')
  startByte: number;  // inclusive offset into stage.bytes
  endByte: number;    // exclusive
  byteCount: number;
}

export interface PipelineStage {
  name: string;
  bytes: Uint8Array;
  // NO materialized chunkRegions (PERF-1): one region per element at 8M+
  // values was the bulk of the oversized worker result. Region info is
  // derived from `layout` on demand (chunkRegionsOf, or useHexData's
  // computeRegions for the per-byte fills).
  layout: StageLayout;
  stats: {
    byteCount: number;
    entropy: number;
  };
}

export interface Chunk {
  coords: number[];
  flatIndex: number;
  variables: ChunkVariable[];
}

export interface ChunkVariable {
  variableName: string;
  variableColor: string;
  dtype: string;
  values: LogicalValue[];
  sourceCoords: number[][];
}

export interface LinearizedChunk {
  chunkId: string;
  coords: number[];
  bytes: Uint8Array;
  variableName?: string;
}

export interface EncodedChunk {
  chunkId: string;
  coords: number[];
  bytes: Uint8Array;
  variableName?: string;
}

export interface VirtualFile {
  name: string;
  bytes: Uint8Array;
  layout: StageLayout;      // per-file regions (Task 5)
}

export interface VariableStats {
  min: number;
  max: number;
  mean: number;
  count: number;
  clipped: number;   // values clamped to dtype range
  rounded: number;   // values rounded during conversion
  isLossy: boolean;  // true if clipped > 0 || rounded > 0
  nanCount: number;  // count of NaN input values (always present; 0 when none).
                      // For integer storage dtypes, NaN silently becomes 0 on write
                      // (DataView.setIntN(NaN) => 0) — nanCount is what lets the UI
                      // / metadata distinguish that from a legitimate zero.
  truncated?: number; // text (charN) storage only: count of values longer than
                      // the dtype's width, cut to fit. truncated > 0 => isLossy.
}

/**
 * One step of the reader's narrated 8-step log (read plan Task 2) — mirrors
 * how a real-format reader proceeds: verify magic, locate metadata, parse
 * it, read the schema and layout it describes, locate chunks, decode them,
 * reassemble values. Attached to BOTH success and failure results so the UI
 * can show the same log either way — only the tail differs (all 'ok' vs a
 * 'failed' step followed by 'skipped' ones).
 */
export type ReadStepId =
  | 'verify-magic'
  | 'locate-metadata'
  | 'parse-metadata'
  | 'read-schema'
  | 'read-layout'
  | 'locate-chunks'
  | 'decode-chunks'
  | 'reassemble';

export interface ReadStep {
  id: ReadStepId;
  label: string;
  needed: string;
  found: string;
  outcome: 'ok' | 'failed' | 'skipped';
  detail?: string;
}

export interface ReadSuccess {
  success: true;
  reconstructedValues: Map<string, ValueArray>;
  lossyVariables: Set<string>;
  steps: ReadStep[];
}

/**
 * Read failure taxonomy (remediation-plan.md decision D4). Each reason has
 * its own educational message — `ReadStatus` and the pane failure display
 * render `message` verbatim rather than hardcoding pedagogical text.
 *
 * - 'no-metadata': metadata genuinely absent (metadata.enabled = false).
 * - 'metadata-not-found': metadata present but the locator/scanner failed
 *   (D1 footerLocator='none'). Wired up by a later agent (tasks 2.3/2.4).
 * - 'bad-magic': leading (or trailing, with a trailer) magic mismatch (D2).
 * - 'corrupt-metadata': metadata was located but failed to parse.
 * - 'no-chunk-index': variable-size chunks with no chunk index to locate
 *   them (D3). Wired up by a later agent (task 2.13).
 * - 'decode-error': codec reversal / deinterleave / reassembly failed after
 *   metadata was found and parsed successfully.
 * - 'missing-schema': metadata was found and parsed, but the `schema` key
 *   itself is absent (read plan Task 3 — `metadata.include.schema` off).
 *   Distinct from 'corrupt-metadata', which is for keys that ARE present but
 *   fail to parse.
 * - 'missing-layout': metadata was found and parsed, schema was present, but
 *   the `shape`/`chunk_shape` keys are absent (read plan Task 3 —
 *   `metadata.include.layout` off).
 */
export type ReadFailureReason =
  | 'no-metadata'
  | 'metadata-not-found'
  | 'bad-magic'
  | 'corrupt-metadata'
  | 'no-chunk-index'
  | 'decode-error'
  | 'missing-schema'
  | 'missing-layout';

export interface ReadFailure {
  success: false;
  reason: ReadFailureReason;
  message: string;
  byteCount: number;
  steps: ReadStep[];
}

export type ReadFileResult = ReadSuccess | ReadFailure;
