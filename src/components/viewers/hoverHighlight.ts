import { elementInChunk } from '../../engine/layout.ts';

/** The local element/byte being classified for hover highlighting. `coords`
 *  empty means this local trace is itself chunk-level (post-entropy
 *  Encoded/Write regions, or structural magic/metadata traces) — it has no
 *  per-value mapping of its own. */
export interface HoverLocalTrace {
  traceId: string;
  chunkId: string;
  coords: number[];
  variableName: string;
}

export interface HoveredState {
  traceId: string | null;
  chunkId: string | null;
}

/**
 * Classify a rendered element/byte against the current hover state.
 *
 * - Exact traceId match -> 'value' (the strong highlight; made visually
 *   unmistakable by the accent-tinted --hover-strong).
 * - Every OTHER member of the hovered chunk -> 'chunk' (the weak wash),
 *   regardless of whether the hover was a value or a chunk-level trace:
 *   per-value locals match via elementInChunk, chunk-level locals (empty
 *   coords, e.g. post-entropy Encoded/Write regions) via direct chunkId
 *   comparison. The wash intentionally shows chunk membership even in panes
 *   with exact per-value tracing — that's part of the lesson (which values
 *   travel together), and the accent-tinted strong highlight keeps the
 *   hovered value distinguishable within it.
 * - No hover, or a structural local trace (empty coords AND empty chunkId,
 *   e.g. magic/metadata bytes): null.
 */
export function hoverHighlightFor(
  local: HoverLocalTrace,
  hovered: HoveredState,
  chunkShape: number[],
): 'value' | 'chunk' | null {
  const { traceId: hoveredTraceId, chunkId: hoveredChunkId } = hovered;
  if (!hoveredTraceId && !hoveredChunkId) return null;

  if (hoveredTraceId && local.traceId === hoveredTraceId) return 'value';

  if (!hoveredChunkId) return null;

  if (local.coords.length === 0) {
    // Chunk-level (post-entropy) or structural local trace — the only
    // mapping available is direct chunkId membership. Structural traces
    // carry chunkId '' and never match.
    return local.chunkId !== '' && local.chunkId === hoveredChunkId ? 'chunk' : null;
  }

  return elementInChunk(hoveredChunkId, local.variableName, local.coords, chunkShape) ? 'chunk' : null;
}
