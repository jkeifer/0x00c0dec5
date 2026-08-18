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

/**
 * Build a *positional* traceId for one fixed-width slot of a stage's bytes —
 * the unit a reader that ignored a byte-moving codec would decode (see
 * CodecDefinition.traceMode 'positional').
 *
 * Deliberately NOT `${variableName}:${coords}`: the slot's bytes are not that
 * element's bytes, so it must never cross-match a real value trace in another
 * pane. Hovering one highlights exactly its own bytes here and degrades to
 * the chunk wash everywhere else — which is the truth.
 *
 * Identity is the byte offset, which is unique within a stage but means
 * something different in every other stage's layout. `byteRangesForTrace`
 * (engine/layout.ts) therefore validates a slot id against the layout it's
 * given — it only resolves if that offset really is a positional chunk region
 * — so a slot id leaking into another stage's lookup yields no ranges rather
 * than an arbitrary byte range.
 */
export function makeSlotTraceId(startByte: number, byteCount: number): string {
  return `slot:${startByte}:${byteCount}`;
}

export type ParsedTraceId =
  | { kind: 'value'; variableName: string; coords: number[] }
  | { kind: 'chunk'; chunkId: string }
  | { kind: 'slot'; startByte: number; byteCount: number };

/**
 * Parse a traceId produced by `makeTraceId`/`makeChunkTraceId` (or any
 * equivalent raw string, e.g. the structural 'magic:start'/'metadata'
 * traceIds emitted by the write stage — these parse as a degenerate 'value'
 * with empty coords, since HoverBar/viewers key off `variableName === ''`
 * for those rather than off parseTraceId's kind).
 *
 * A chunk-kind id's `chunkId` is the full prefixed string (matching
 * `ByteTrace.chunkId` verbatim), NOT the raw suffix — this is what callers
 * pass to `byteRangesForTrace`/`elementInChunk` (engine/layout.ts).
 */
export function parseTraceId(id: string): ParsedTraceId {
  if (id.startsWith('chunk:')) {
    return { kind: 'chunk', chunkId: id };
  }
  if (id.startsWith('slot:')) {
    const [start, count] = id.slice('slot:'.length).split(':').map(Number);
    if (Number.isInteger(start) && Number.isInteger(count)) {
      return { kind: 'slot', startByte: start, byteCount: count };
    }
    // Malformed (or a variable literally named 'slot' — see the module doc's
    // ':'-in-names caveat): fall through to value parsing.
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

/** Check if a traceId indicates chunk-level (degraded) tracing. */
export function isChunkLevelTrace(traceId: string): boolean {
  return parseTraceId(traceId).kind === 'chunk';
}

/** Check if a traceId is a positional slot — a byte range that decodes as one
 *  value but is not one element's bytes (post byte-shuffle). */
export function isPositionalTrace(traceId: string): boolean {
  return parseTraceId(traceId).kind === 'slot';
}
