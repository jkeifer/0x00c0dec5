import type { ByteTrace, Chunk, ChunkRegion, LinearizedChunk } from '../types/pipeline.ts';
import type { DtypeKey, LogicalValue } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import type { CodecStep } from '../types/codecs.ts';
import { activeSteps, CODEC_REGISTRY, outputDtypeFor } from './codecs.ts';
import { makeTraceId, makeChunkTraceId, makeSlotTraceId, parseTraceId } from './trace.ts';
import { formatValue, formatLogicalValue, bytesToValues } from './elements.ts';
import { flatIndexToCoords, coordsToFlatIndex } from './chunk.ts';
import { orderCoordsOf, orderIndexOf, type LinearizationOrder } from './order.ts';

export type ValueArray = LogicalValue[] | Float64Array;

export interface ValueBlockRegion {
  kind: 'values';
  start: number;              // byte offset in stage bytes
  byteLength: number;
  variableName: string;
  variableColor: string;
  dtype: string;              // ByteTrace.dtype label: 'float64'/'text' (Values/Read) or storage dtype (Typed)
  stride?: number;            // fixed-width bytes per element; undefined => use offsets
  offsets?: Uint32Array;      // text only: length N+1, cumulative byte offsets relative to start
  elementCount: number;
}

export interface ChunkFieldLayout {
  variableName: string;
  variableColor: string;
  dtype: string;
  size: number;               // dtype byte size
  offset: number;             // column: field block offset within chunk; row: offset within record
}

export interface ChunkBlockRegion {
  kind: 'chunk';
  start: number;
  byteLength: number;
  chunkId: string;            // 'chunk:'-prefixed, matches linearize.ts
  variableName: string;       // single-var (column) chunks; '' otherwise
  variableColor: string;      // '' when variableName is ''
  // 'positional' == same fixed-width slot geometry as value-preserving, but
  // the codec pipeline moved bytes, so a slot is NOT its element's bytes.
  // See CodecDefinition.traceMode.
  mode: 'value-preserving' | 'positional' | 'chunk-level';
  interleaving: 'row' | 'column';
  byteOrder: 'little' | 'big'; // the order this chunk's values were written in
  fields: ChunkFieldLayout[]; // value-preserving only; [] for chunk-level
  origin: number[];           // element-space origin: chunkCoords[d] * chunkShape[d]
  elementDims: number[];      // this chunk's (edge-clipped) element dims
  // cl-6: linearization order of elements within the chunk. A STRING, never a
  // materialized permutation (PERF-1) — each side of the thread boundary
  // derives the permutation on demand via order.ts's orderPermutation cache.
  // 'c' means the pre-cl-6 closed-form flat-index math (identity permutation).
  order: LinearizationOrder;
}

export interface StructuralRegion {
  kind: 'structural';
  start: number;
  byteLength: number;
  traceId: string;            // 'magic:start' | 'magic:end' | 'metadata' | write.ts's chunk-index id
  label: string;              // ChunkRegion label (usually === traceId)
  byteInValueMode?: 'offset' | 'zero'; // reproduce the reference site's byteInValue rule (Task 5)
}

export type LayoutRegion = ValueBlockRegion | ChunkBlockRegion | StructuralRegion;

export interface StageLayout {
  byteLength: number;
  shape: number[];            // dataset shape (global flat index <-> coords)
  regions: LayoutRegion[];    // ordered, contiguous from byte 0
}

export interface ValueSources {
  values: Map<string, ValueArray>;   // per-variable arrays for displayValue
  format: 'logical' | 'typed';       // formatLogicalValue vs formatValue(v, dtype)
  /**
   * The stage's OWN bytes. When present, chunk-region display values are
   * decoded straight out of these instead of looked up in `values` — so the
   * Encoded stage shows what its bytes actually say (delta shows differences;
   * byte shuffle shows the garbage a naive reader would pull out) rather than
   * the pre-codec input values. Stages whose layouts hold no chunk regions
   * (Values/Typed/Read) never consult it.
   */
  bytes?: Uint8Array;
}

export function buildValueBlocksLayout(
  variables: { name: string; color: string }[],
  shape: number[],
  valuesByName: Map<string, ValueArray>,
  dtypeFor: (variableName: string) => string,   // 'float64'/'text' at Values/Read; storage dtype at Typed
): StageLayout {
  const regions: LayoutRegion[] = [];
  let cursor = 0;
  for (const v of variables) {
    const vals = valuesByName.get(v.name) ?? [];
    const dtype = dtypeFor(v.name);
    if (dtype === 'text') {
      // Variable stride: mirror buildLogicalValuesStage — byteCount = str.length.
      const offsets = new Uint32Array(vals.length + 1);
      let acc = 0;
      for (let i = 0; i < vals.length; i++) {
        acc += String(vals[i]).length;
        offsets[i + 1] = acc;
      }
      regions.push({
        kind: 'values', start: cursor, byteLength: acc,
        variableName: v.name, variableColor: v.color,
        dtype: 'text', offsets, elementCount: vals.length,
      });
      cursor += acc;
    } else {
      const stride = getDtype(dtype as DtypeKey).size;
      const byteLength = vals.length * stride;
      regions.push({
        kind: 'values', start: cursor, byteLength,
        variableName: v.name, variableColor: v.color,
        dtype, stride, elementCount: vals.length,
      });
      cursor += byteLength;
    }
  }
  return { byteLength: cursor, shape, regions };
}

/** Build the Linearized stage layout from the already-computed chunks.
 *  chunkShape is needed for origin computation; chunk element order must
 *  mirror chunkData/chunkDataPerVariable's sourceCoords enumeration. */
export function buildLinearizedLayout(
  chunks: Chunk[],
  linearizedChunks: LinearizedChunk[],
  interleaving: 'row' | 'column',
  shape: number[],
  chunkShape: number[],
  order: LinearizationOrder = 'c',
  byteOrder: 'little' | 'big' = 'little',
): StageLayout {
  const regions: LayoutRegion[] = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const lc = linearizedChunks[i];
    const elementDims = chunk.coords.map((c, d) =>
      Math.min(chunkShape[d], shape[d] - c * chunkShape[d]));
    const origin = chunk.coords.map((c, d) => c * chunkShape[d]);
    const fields: ChunkFieldLayout[] = [];
    if (interleaving === 'column') {
      let fieldOffset = 0;
      for (const cv of chunk.variables) {
        const size = getDtype(cv.dtype as DtypeKey).size;
        fields.push({ variableName: cv.variableName, variableColor: cv.variableColor, dtype: cv.dtype, size, offset: fieldOffset });
        fieldOffset += size * cv.values.length;
      }
    } else {
      let rec = 0;
      for (const cv of chunk.variables) {
        const size = getDtype(cv.dtype as DtypeKey).size;
        fields.push({ variableName: cv.variableName, variableColor: cv.variableColor, dtype: cv.dtype, size, offset: rec });
        rec += size;
      }
    }
    const isSingleVar = interleaving === 'column' && chunk.variables.length === 1;
    regions.push({
      kind: 'chunk', start: cursor, byteLength: lc.bytes.length,
      chunkId: lc.chunkId,
      variableName: isSingleVar ? chunk.variables[0].variableName : '',
      variableColor: isSingleVar ? chunk.variables[0].variableColor : '',
      mode: 'value-preserving', interleaving, byteOrder, fields, origin, elementDims, order,
    });
    cursor += lc.bytes.length;
  }
  return { byteLength: cursor, shape, regions };
}

export type ChunkTraceMode = ChunkBlockRegion['mode'];

export interface EncodedChunkMeta {
  /** What the bytes now ARE, per outputDtypeFor: uint8 once any step has
   *  destroyed element structure. This is what a following codec receives. */
  outputDtype: string;
  /** What the Encoded pane should draw one slot as — the dtype in force when
   *  structure was destroyed, i.e. what a reader ignoring the codec would try
   *  to decode at that offset. Equals `outputDtype` for a pipeline that never
   *  degrades. The two differ only for 'positional' chunks, which are exactly
   *  the ones whose slots are a counterfactual rather than a fact. */
  slotDtype: string;
  traceMode: ChunkTraceMode;
}

/** Degradation is monotone — once a pipeline has moved bytes it can't get
 *  them back — so a pipeline's trace mode is the worst any step declares. */
const TRACE_MODE_RANK: Record<ChunkTraceMode, number> = {
  'value-preserving': 0, positional: 1, 'chunk-level': 2,
};

/** Single source of truth for what a codec pipeline does to a chunk's
 *  tracing: final output dtype (via outputDtypeFor, per CLAUDE.md pitfall 3)
 *  and how far per-value tracing survives (via CodecDefinition.traceMode;
 *  entropy codecs are always chunk-level). */
export function encodedChunkMeta(steps: CodecStep[], inputDtype: DtypeKey): EncodedChunkMeta {
  let dtype: DtypeKey = inputDtype;
  let traceMode: ChunkTraceMode = 'value-preserving';
  let slotDtype: DtypeKey | null = null;
  for (const step of activeSteps(steps)) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    const stepMode: ChunkTraceMode = codec.category === 'entropy'
      ? 'chunk-level'
      : codec.traceMode ?? 'value-preserving';
    if (TRACE_MODE_RANK[stepMode] > TRACE_MODE_RANK[traceMode]) {
      traceMode = stepMode;
      // Freeze the slot dtype at the *input* of the first step that destroyed
      // structure — after that point `dtype` is uint8 and no longer describes
      // anything a reader could decode as a value.
      slotDtype ??= dtype;
    }
    dtype = outputDtypeFor(codec, dtype);
  }
  return { outputDtype: dtype, slotDtype: slotDtype ?? dtype, traceMode };
}

/** Build the Encoded stage layout from the Linearized layout + computed
 *  encoded chunks, per each chunk's `traceMode` (from encodedChunkMeta):
 *
 *  - 'chunk-level' (entropy, bit shuffle): the whole region degrades to one
 *    opaque span.
 *  - 'value-preserving' / 'positional': the linearized region is re-based to
 *    the encoded offset with field dtypes relabeled to the pipeline's slot
 *    dtype (NOT its output dtype — see EncodedChunkMeta; a positional chunk's
 *    bytes are uint8 planes, but the slot it draws is the pre-shuffle element
 *    a naive reader would still try to decode) — byte-size-preserving codecs keep the slot geometry either way.
 *    The mode carries the difference that matters: whether a slot still
 *    identifies its element ('value-preserving') or is merely the byte range
 *    a naive reader would decode as one ('positional'). traceAt reads both
 *    slot kinds' values out of the stage bytes; only the traceId differs. */
export function buildEncodedLayout(
  linearizedLayout: StageLayout,
  encodedChunks: { chunkId: string; bytes: Uint8Array }[],
  slotDtypes: string[],
  traceModes: ChunkTraceMode[],
): StageLayout {
  const regions: LayoutRegion[] = [];
  let cursor = 0;
  linearizedLayout.regions.forEach((r, i) => {
    if (r.kind !== 'chunk') throw new Error('linearized layout must be all chunk regions');
    const encBytes = encodedChunks[i].bytes.length;
    if (traceModes[i] === 'chunk-level') {
      const sampleName = r.fields[0]?.variableName ?? '';
      const sharedVariable = sampleName !== '' && r.fields.every((f) => f.variableName === sampleName);
      regions.push({
        ...r, start: cursor, byteLength: encBytes,
        variableName: sharedVariable ? sampleName : '',
        variableColor: sharedVariable ? r.fields[0].variableColor : '',
        mode: 'chunk-level', fields: [],
      });
    } else {
      regions.push({
        ...r, start: cursor, byteLength: encBytes,
        mode: traceModes[i],
        fields: r.fields.map((f) => ({ ...f, dtype: slotDtypes[i] })),
      });
    }
    cursor += encBytes;
  });
  return { byteLength: cursor, shape: linearizedLayout.shape, regions };
}

/** Chunk-local flat element index (position in the linearized byte sequence)
 *  -> global coords. Must mirror the enumeration order
 *  chunkData/chunkDataPerVariable use for sourceCoords (orderCoordsOf over
 *  elementDims) — the equivalence tests are the check. Defaults to 'c'
 *  (flatIndexToCoords) so callers with no order get the pre-cl-6 behavior. */
export function chunkElementCoords(
  origin: number[],
  elementDims: number[],
  elemFlat: number,
  order: LinearizationOrder = 'c',
): number[] {
  const local = orderCoordsOf(elemFlat, elementDims, order);
  return local.map((l, d) => origin[d] + l);
}

/** Build the Metadata stage layout: a single structural region spanning the
 *  whole serialized metadata blob (matches computeMetadataStage's traces —
 *  byteInValue: i, i.e. offset within the region, byteCount: full length). */
export function buildMetadataLayout(byteLength: number): StageLayout {
  return {
    byteLength,
    shape: [],
    regions: byteLength > 0
      ? [{ kind: 'structural', start: 0, byteLength, traceId: 'metadata', label: 'metadata' }]
      : [],
  };
}

export function regionAt(layout: StageLayout, byteIndex: number): LayoutRegion | null {
  if (byteIndex < 0 || byteIndex >= layout.byteLength) return null;
  let lo = 0, hi = layout.regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = layout.regions[mid];
    if (byteIndex < r.start) hi = mid - 1;
    else if (byteIndex >= r.start + r.byteLength) lo = mid + 1;
    else return r;
  }
  return null;
}

function formatDisplay(value: LogicalValue | number, dtype: string, format: 'logical' | 'typed'): string {
  return format === 'logical' ? formatLogicalValue(value) : formatValue(value, dtype as DtypeKey);
}

/**
 * Display string for one fixed-width slot of a chunk region.
 *
 * Prefers decoding the slot straight out of the stage's own bytes
 * (`sources.bytes`) — that is what the stage's bytes at that offset actually
 * say, which is the only honest answer once a codec has rewritten them
 * (delta: the difference; byte shuffle: transposed garbage). Falls back to
 * the pre-codec `sources.values` lookup when a caller supplies no bytes.
 */
function chunkSlotDisplay(
  r: ChunkBlockRegion,
  field: ChunkFieldLayout,
  slotStart: number,
  coords: number[],
  layout: StageLayout,
  sources: ValueSources,
): string {
  if (sources.bytes && slotStart + field.size <= sources.bytes.length) {
    const dtype = field.dtype as DtypeKey;
    const decoded = bytesToValues(
      sources.bytes.subarray(slotStart, slotStart + field.size), dtype, r.byteOrder,
    );
    return formatValue(decoded[0], dtype);
  }
  const arr = sources.values.get(field.variableName) ?? [];
  return formatDisplay(arr[coordsToFlatIndex(coords, layout.shape)], field.dtype, sources.format);
}

/** Upper-bound binary search: largest i with offsets[i] <= rel. */
function offsetIndex(offsets: Uint32Array, rel: number): number {
  let lo = 0, hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= rel) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function traceAt(layout: StageLayout, byteIndex: number, sources: ValueSources): ByteTrace | null {
  const r = regionAt(layout, byteIndex);
  if (!r) return null;
  if (r.kind === 'values') {
    const rel = byteIndex - r.start;
    const arr = sources.values.get(r.variableName) ?? [];
    if (r.offsets) {
      const el = offsetIndex(r.offsets, rel);
      const coords = flatIndexToCoords(el, layout.shape);
      const str = String(arr[el]);
      return {
        traceId: makeTraceId(r.variableName, coords),
        variableName: r.variableName, variableColor: r.variableColor,
        coords, displayValue: str, dtype: r.dtype, chunkId: '',
        byteInValue: rel - r.offsets[el], byteCount: r.offsets[el + 1] - r.offsets[el],
      };
    }
    const stride = r.stride!;
    const el = Math.floor(rel / stride);
    const coords = flatIndexToCoords(el, layout.shape);
    return {
      traceId: makeTraceId(r.variableName, coords),
      variableName: r.variableName, variableColor: r.variableColor,
      coords, displayValue: formatDisplay(arr[el], r.dtype, sources.format),
      dtype: r.dtype, chunkId: '', byteInValue: rel % stride, byteCount: stride,
    };
  }
  if (r.kind === 'chunk' && r.mode !== 'chunk-level') {
    const rel = byteIndex - r.start;
    const elementCount = r.elementDims.reduce((a, b) => a * b, 1);
    let field: ChunkFieldLayout; let elemFlat: number; let byteInValue: number;
    if (r.interleaving === 'column') {
      // fields are consecutive blocks: find by offset range
      let f = r.fields.length - 1;
      while (f > 0 && rel < r.fields[f].offset) f--;
      field = r.fields[f];
      const fieldRel = rel - field.offset;
      elemFlat = Math.floor(fieldRel / field.size);
      byteInValue = fieldRel % field.size;
    } else {
      const recordSize = r.fields.reduce((a, f) => a + f.size, 0);
      elemFlat = Math.floor(rel / recordSize);
      const inRecord = rel % recordSize;
      let f = r.fields.length - 1;
      while (f > 0 && inRecord < r.fields[f].offset) f--;
      field = r.fields[f];
      byteInValue = inRecord - field.offset;
    }
    if (elemFlat >= elementCount) return null;
    const coords = chunkElementCoords(r.origin, r.elementDims, elemFlat, r.order);
    const slotStart = byteIndex - byteInValue;
    return {
      // A positional slot is not its element's data, so it gets an id that
      // deliberately matches nothing in another pane — see makeSlotTraceId.
      // `coords` is still the slot's *position*, i.e. what a reader ignoring
      // the codec would call this value; it drives the label, not identity.
      traceId: r.mode === 'positional'
        ? makeSlotTraceId(slotStart, field.size)
        : makeTraceId(field.variableName, coords),
      variableName: field.variableName, variableColor: field.variableColor,
      coords, displayValue: chunkSlotDisplay(r, field, slotStart, coords, layout, sources),
      dtype: field.dtype, chunkId: r.chunkId,
      byteInValue, byteCount: field.size,
    };
  }
  if (r.kind === 'chunk' && r.mode === 'chunk-level') {
    return {
      traceId: r.chunkId,
      variableName: r.variableName, variableColor: r.variableColor,
      coords: [], displayValue: '', dtype: 'uint8', chunkId: r.chunkId,
      byteInValue: 0, byteCount: 1,
    };
  }
  if (r.kind === 'structural') {
    const rel = byteIndex - r.start;
    return {
      traceId: r.traceId, variableName: '', variableColor: '',
      coords: [], displayValue: r.label, dtype: 'uint8', chunkId: '',
      byteInValue: r.byteInValueMode === 'zero' ? 0 : rel,
      byteCount: r.byteLength,
    };
  }
  return null;
}

export interface ByteRange { start: number; end: number } // end exclusive

/** All byte ranges in this stage belonging to traceId (value, chunk, or
 *  structural). Inverts traceAt: for every byte i, the range(s) returned for
 *  traceAt(layout, i, sources)!.traceId always include i (see
 *  layout.reverse.test.ts's inversion property test). */
export function byteRangesForTrace(layout: StageLayout, traceId: string): ByteRange[] {
  const parsed = parseTraceId(traceId);

  if (parsed.kind === 'chunk') {
    const ranges: ByteRange[] = [];
    for (const r of layout.regions) {
      if (r.kind === 'chunk' && r.chunkId === parsed.chunkId) {
        ranges.push({ start: r.start, end: r.start + r.byteLength });
      }
    }
    return ranges;
  }

  if (parsed.kind === 'slot') {
    // Slot ids are byte offsets, which mean something different in every other
    // stage's layout — validate against THIS layout before trusting them (see
    // makeSlotTraceId). Only a positional chunk region can own a slot.
    const r = regionAt(layout, parsed.startByte);
    if (!r || r.kind !== 'chunk' || r.mode !== 'positional') return [];
    return [{ start: parsed.startByte, end: parsed.startByte + parsed.byteCount }];
  }

  // Structural ids ('magic:start', 'magic:end', 'metadata', ...) — matched
  // directly since parseTraceId degrades them to a degenerate 'value' kind
  // with variableName === the raw id and empty coords (see trace.ts's doc
  // comment). Try structural regions first; a real value traceId never
  // collides with a structural one (variable names can't contain ':' — see
  // trace.ts — but a structural id like 'metadata' has no ':' either, so it
  // parses as { variableName: 'metadata', coords: [] } and must be checked
  // as a structural id explicitly, not inferred from parse shape).
  const structural = layout.regions.filter(
    (r): r is StructuralRegion => r.kind === 'structural' && r.traceId === traceId,
  );
  if (structural.length > 0) {
    return structural.map((r) => ({ start: r.start, end: r.start + r.byteLength }));
  }

  const { variableName, coords } = parsed;
  const ranges: ByteRange[] = [];

  for (const r of layout.regions) {
    if (r.kind === 'values' && r.variableName === variableName) {
      const el = coordsToFlatIndex(coords, layout.shape);
      if (el < 0 || el >= r.elementCount) continue;
      if (r.offsets) {
        ranges.push({ start: r.start + r.offsets[el], end: r.start + r.offsets[el + 1] });
      } else {
        const stride = r.stride!;
        ranges.push({ start: r.start + el * stride, end: r.start + (el + 1) * stride });
      }
    } else if (r.kind === 'chunk' && r.mode === 'value-preserving') {
      const field = r.fields.find((f) => f.variableName === variableName);
      if (!field) continue;
      const inBounds = r.origin.every((o, d) => coords[d] >= o && coords[d] < o + r.elementDims[d]);
      if (!inBounds) continue;
      const local = coords.map((c, d) => c - r.origin[d]);
      const elemFlat = orderIndexOf(local, r.elementDims, r.order);
      let start: number;
      if (r.interleaving === 'column') {
        start = r.start + field.offset + elemFlat * field.size;
      } else {
        const recordSize = r.fields.reduce((a, f) => a + f.size, 0);
        start = r.start + elemFlat * recordSize + field.offset;
      }
      ranges.push({ start, end: start + field.size });
    }
  }

  return ranges;
}

/** Reproduces buildChunkRegions(traces) output from the layout alone: fold
 *  consecutive same-label spans into one ChunkRegion. Mirrors
 *  viewerUtils.ts's getRegionLabel: structural ids label by traceId; chunk
 *  regions (value-preserving or chunk-level) label by chunkId; values
 *  regions label per-element by that element's own traceId (`${variableName}
 *  :${coords}`), since buildChunkRegions operates per-byte-trace and each
 *  value's bytes carry a distinct traceId with chunkId === ''. */
export function chunkRegionsOf(layout: StageLayout): ChunkRegion[] {
  const spans: { label: string; start: number; end: number }[] = [];

  for (const r of layout.regions) {
    if (r.kind === 'structural') {
      spans.push({ label: r.traceId, start: r.start, end: r.start + r.byteLength });
    } else if (r.kind === 'chunk') {
      spans.push({ label: r.chunkId, start: r.start, end: r.start + r.byteLength });
    } else {
      // values: one span per element, labeled by that element's traceId.
      if (r.offsets) {
        for (let el = 0; el < r.elementCount; el++) {
          // Zero-width text elements (empty string: offsets[el] ===
          // offsets[el+1]) get no span — buildLogicalValuesStage emits zero
          // ByteTrace entries for an empty string, so buildChunkRegions
          // produces no region for it either; a zero-width span here would
          // diverge from that (see layout.reverse.test.ts's zero-width case).
          if (r.offsets[el] === r.offsets[el + 1]) continue;
          const coords = flatIndexToCoords(el, layout.shape);
          spans.push({
            label: makeTraceId(r.variableName, coords),
            start: r.start + r.offsets[el], end: r.start + r.offsets[el + 1],
          });
        }
      } else {
        const stride = r.stride!;
        for (let el = 0; el < r.elementCount; el++) {
          const coords = flatIndexToCoords(el, layout.shape);
          spans.push({
            label: makeTraceId(r.variableName, coords),
            start: r.start + el * stride, end: r.start + (el + 1) * stride,
          });
        }
      }
    }
  }

  const regions: ChunkRegion[] = [];
  if (spans.length === 0) return regions;

  let currentLabel = spans[0].label;
  let startByte = spans[0].start;
  let endByte = spans[0].end;

  for (let i = 1; i <= spans.length; i++) {
    const span = i < spans.length ? spans[i] : null;
    if (!span || span.label !== currentLabel) {
      regions.push({ label: currentLabel, startByte, endByte, byteCount: endByte - startByte });
      if (span) {
        currentLabel = span.label;
        startByte = span.start;
        endByte = span.end;
      }
    } else {
      endByte = span.end;
    }
  }

  return regions;
}

/** The chunkId containing element coords (mirrors linearize.ts's id
 *  construction: column single-var chunks get `chunk:${variableName}:
 *  ${chunkCoords}`, everything else gets `chunk:${chunkCoords}`). Pure math
 *  — floor-divide each coordinate by the chunk shape to get the chunk's grid
 *  coordinates, exactly as buildLinearizedLayout derives `origin` from
 *  `chunk.coords`. Note: this always assumes a per-variable (single-var)
 *  chunk in column mode — callers doing row-interleaving or multi-variable
 *  column chunks pass the shared `chunk:${coords}` id regardless of which
 *  variableName is given, matching linearizeChunk's isSingleVarColumn rule. */
export function chunkIdForElement(
  variableName: string,
  coords: number[],
  chunkShape: number[],
  interleaving: 'row' | 'column',
): string {
  const chunkCoords = coords.map((c, d) => Math.floor(c / chunkShape[d]));
  if (interleaving === 'column') {
    return makeChunkTraceId(`${variableName}:${chunkCoords.join(',')}`);
  }
  return makeChunkTraceId(chunkCoords.join(','));
}

/** Parsed form of a `chunk:`-prefixed id: the chunk's grid coords, plus the
 *  single variableName a column single-var chunkId (`chunk:name:0,1`) is
 *  scoped to (undefined for the shared `chunk:0,1` form). Returns null for
 *  anything not chunk-shaped. Shared by `elementInChunk` and
 *  `chunkOriginForChunkId` so both agree on the id grammar. */
function parseChunkId(chunkId: string): { coords: number[]; variableName?: string } | null {
  if (!chunkId.startsWith('chunk:')) return null;
  const rest = chunkId.slice('chunk:'.length);
  const parts = rest.split(':');
  let coordsPart: string;
  let variableName: string | undefined;
  if (parts.length === 2) {
    // column single-var: 'name:coords'
    variableName = parts[0];
    coordsPart = parts[1];
  } else {
    coordsPart = parts[0];
  }
  const coords = coordsPart === '' ? [] : coordsPart.split(',').map(Number);
  return { coords, variableName };
}

/** Does element `coords` of `variableName` live in chunk `chunkId`? Pure
 *  math: parse the chunkId's trailing coordinate list and compare against
 *  floor(coords[d] / chunkShape[d]) per dimension. A column single-var
 *  chunkId (`chunk:name:0,1`) also requires the variableName to match. */
export function elementInChunk(
  chunkId: string,
  variableName: string,
  coords: number[],
  chunkShape: number[],
): boolean {
  const parsed = parseChunkId(chunkId);
  if (!parsed) return false;
  if (parsed.variableName !== undefined && parsed.variableName !== variableName) return false;
  if (parsed.coords.length !== coords.length) return false;
  return parsed.coords.every((cc, d) => cc === Math.floor(coords[d] / chunkShape[d]));
}

/** Inverse of `chunkIdForElement`: parse a chunkId directly into the coords
 *  of its origin element (chunk-local index 0 in every dimension — the
 *  lexicographically-first, i.e. lowest-flat-index, element the chunk
 *  contains) rather than scanning every element to find one that matches.
 *  `knownVariableNames` are the variables a caller actually has columns for;
 *  a column single-var chunkId scoped to a variable not in that set has no
 *  matching row for the caller, so this returns null (mirrors
 *  `elementInChunk`'s variableName check without needing a per-row loop).
 *  Returns null for a non-chunk id or a dimensionality mismatch. */
export function chunkOriginForChunkId(
  chunkId: string,
  chunkShape: number[],
  knownVariableNames: string[],
): number[] | null {
  const parsed = parseChunkId(chunkId);
  if (!parsed) return null;
  if (parsed.variableName !== undefined && !knownVariableNames.includes(parsed.variableName)) return null;
  if (parsed.coords.length !== chunkShape.length) return null;
  return parsed.coords.map((cc, d) => cc * chunkShape[d]);
}
