import type { ByteTrace } from '../types/pipeline.ts';
import { getDtype } from '../types/dtypes.ts';
import type { DtypeKey } from '../types/dtypes.ts';

/**
 * D8 (remediation-plan.md, Phase 3.4): the single source of truth for
 * traceId construction and parsing. Previously there were ~5 inline copies
 * (usePipeline.ts x3, TableView.tsx, GridView.tsx) of the `${name}:${coords}`
 * format, plus a chunk-level parser (TableView's traceIdToRowIndex) that
 * never checked for the 'chunk:' prefix before splitting on ':' — silently
 * "succeeding" at parsing a chunk id as element coordinates (UI-3).
 *
 * Design choice for the ':' delimiter (documented per the task): a value
 * traceId is built as `${variableName}:${coords.join(',')}` and parsed by
 * splitting on the FIRST ':' only (`indexOf`, not `split`). This means
 * variable names containing ':' are NOT supported — a name like "a:b" would
 * parse back with variableName "a" and the remainder "b:0" fed to coordinate
 * parsing (which will simply fail to produce valid coords, since "b:0" isn't
 * a clean comma-separated numeric list, so parseTraceId degrades gracefully
 * rather than silently mis-parsing). This mirrors the existing constraint
 * that variable names are also used verbatim as metadata/file-format keys
 * and chunk-id components (`chunk:${variableName}:${coords}`); disallowing
 * ':' in variable names is the simplest robust contract and is intentionally
 * not enforced elsewhere in this codebase (out of scope for Phase 3).
 */

/** Build a value-level traceId for a variable's element at `coords`. */
export function makeTraceId(variableName: string, coords: number[]): string {
  return `${variableName}:${coords.join(',')}`;
}

/**
 * Build a chunk-level traceId from a chunk identifier. `chunkId` is expected
 * to be the raw identifier (e.g. `0,1` or `temperature:0`, as produced by
 * chunk coords / per-variable chunk naming) — this function prefixes it with
 * `chunk:`. Idempotent: if `chunkId` already carries the `chunk:` prefix (as
 * `linearize.ts`'s chunk ids already do, since they're also used directly as
 * `ByteTrace.chunkId` map keys), it is returned unchanged rather than
 * double-prefixed.
 */
export function makeChunkTraceId(chunkId: string): string {
  return chunkId.startsWith('chunk:') ? chunkId : `chunk:${chunkId}`;
}

export type ParsedTraceId =
  | { kind: 'value'; variableName: string; coords: number[] }
  | { kind: 'chunk'; chunkId: string };

/**
 * Parse a traceId produced by `makeTraceId`/`makeChunkTraceId` (or any
 * equivalent raw string, e.g. the structural 'magic:start'/'metadata'
 * traceIds emitted by the write stage — these parse as a degenerate 'value'
 * with empty coords, since HoverBar/viewers key off `variableName === ''`
 * for those rather than off parseTraceId's kind).
 *
 * A chunk-kind id's `chunkId` is the full prefixed string (matching
 * `ByteTrace.chunkId` verbatim), NOT the raw suffix — this is what callers
 * need to look up `chunkTraceMap`/`traceChunkMap` entries.
 */
export function parseTraceId(id: string): ParsedTraceId {
  if (id.startsWith('chunk:')) {
    return { kind: 'chunk', chunkId: id };
  }
  // Split on the FIRST ':' only — see the module doc comment above for why
  // variable names containing ':' are out of scope.
  const colonIdx = id.indexOf(':');
  if (colonIdx < 0) {
    return { kind: 'value', variableName: id, coords: [] };
  }
  const variableName = id.slice(0, colonIdx);
  const coordStr = id.slice(colonIdx + 1);
  const coords = coordStr === '' ? [] : coordStr.split(',').map(Number);
  return { kind: 'value', variableName, coords };
}

/**
 * Propagate traces through a value-preserving codec (mapping or reordering).
 * Same-size dtypes: 1:1 trace copy with updated dtype.
 * Different-size dtypes: recompute byteInValue/byteCount per new dtype size.
 */
export function propagateTracesValuePreserving(
  inputTraces: ByteTrace[],
  inputDtype: DtypeKey,
  outputDtype: DtypeKey,
): ByteTrace[] {
  const inputSize = getDtype(inputDtype).size;
  const outputSize = getDtype(outputDtype).size;

  if (inputSize === outputSize) {
    return inputTraces.map((t) => ({ ...t, dtype: outputDtype }));
  }

  // Different sizes: group by traceId, then re-expand
  const outputTraces: ByteTrace[] = [];
  let i = 0;
  while (i < inputTraces.length) {
    const trace = inputTraces[i];
    // Skip over all bytes of the current value in the input
    const inputValueByteCount = trace.byteCount;
    for (let b = 0; b < outputSize; b++) {
      outputTraces.push({
        ...trace,
        dtype: outputDtype,
        byteInValue: b,
        byteCount: outputSize,
      });
    }
    i += inputValueByteCount;
  }

  return outputTraces;
}

/**
 * Degrade traces to chunk-level after entropy coding.
 * All output traces get traceId = chunkId from the input traces.
 * When all input traces share the same variableName (per-variable chunks),
 * preserve variableName and variableColor in the output.
 */
export function degradeTracesToChunkLevel(
  inputTraces: ByteTrace[],
  outputByteCount: number,
): ByteTrace[] {
  if (inputTraces.length === 0 || outputByteCount === 0) {
    return [];
  }

  const sample = inputTraces[0];
  const chunkTraceId = sample.chunkId;

  // Check if all traces share the same variable (true for per-variable chunks)
  const sharedVariable = sample.variableName !== '' &&
    inputTraces.every((t) => t.variableName === sample.variableName);

  return Array.from({ length: outputByteCount }, () => ({
    traceId: chunkTraceId,
    variableName: sharedVariable ? sample.variableName : '',
    variableColor: sharedVariable ? sample.variableColor : '',
    coords: [],
    displayValue: '',
    dtype: 'uint8',
    chunkId: sample.chunkId,
    byteInValue: 0,
    byteCount: 1,
  }));
}

/** Check if a traceId indicates chunk-level (degraded) tracing. */
export function isChunkLevelTrace(traceId: string): boolean {
  return parseTraceId(traceId).kind === 'chunk';
}
