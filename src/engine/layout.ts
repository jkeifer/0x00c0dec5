import type { ByteTrace, Chunk, LinearizedChunk } from '../types/pipeline.ts';
import type { DtypeKey, LogicalValue } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import type { CodecStep } from '../types/codecs.ts';
import { CODEC_REGISTRY, outputDtypeFor } from './codecs.ts';
import { makeTraceId } from './trace.ts';
import { formatValue, formatLogicalValue } from './elements.ts';
import { flatIndexToCoords, coordsToFlatIndex } from './chunk.ts';

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
  mode: 'value-preserving' | 'chunk-level';
  interleaving: 'row' | 'column';
  fields: ChunkFieldLayout[]; // value-preserving only; [] for chunk-level
  origin: number[];           // element-space origin: chunkCoords[d] * chunkShape[d]
  elementDims: number[];      // this chunk's (edge-clipped) element dims
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
      mode: 'value-preserving', interleaving, fields, origin, elementDims,
    });
    cursor += lc.bytes.length;
  }
  return { byteLength: cursor, shape, regions };
}

export interface EncodedChunkMeta { outputDtype: string; hasEntropy: boolean }

/** Single source of truth for what a codec pipeline does to a chunk's
 *  tracing: final output dtype (via outputDtypeFor, per CLAUDE.md pitfall 3)
 *  and whether any entropy step degrades traces to chunk level. */
export function encodedChunkMeta(steps: CodecStep[], inputDtype: DtypeKey): EncodedChunkMeta {
  let dtype: DtypeKey = inputDtype;
  let hasEntropy = false;
  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    if (codec.category === 'entropy') hasEntropy = true;
    dtype = outputDtypeFor(codec, dtype);
  }
  return { outputDtype: dtype, hasEntropy };
}

/** Build the Encoded stage layout from the Linearized layout + computed
 *  encoded chunks. Entropy anywhere in a chunk's pipeline degrades that
 *  chunk's region to chunk-level (mirroring degradeTracesToChunkLevel);
 *  otherwise the linearized region is re-based to the encoded offset with
 *  field dtypes relabeled to the pipeline's output dtype (non-entropy codecs
 *  preserve byte size, mirroring propagateTracesValuePreserving's 1:1 copy). */
export function buildEncodedLayout(
  linearizedLayout: StageLayout,
  encodedChunks: { chunkId: string; bytes: Uint8Array }[],
  outputDtypes: string[],
  chunkHasEntropy: boolean[],
): StageLayout {
  const regions: LayoutRegion[] = [];
  let cursor = 0;
  linearizedLayout.regions.forEach((r, i) => {
    if (r.kind !== 'chunk') throw new Error('linearized layout must be all chunk regions');
    const encBytes = encodedChunks[i].bytes.length;
    if (chunkHasEntropy[i]) {
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
        fields: r.fields.map((f) => ({ ...f, dtype: outputDtypes[i] })),
      });
    }
    cursor += encBytes;
  });
  return { byteLength: cursor, shape: linearizedLayout.shape, regions };
}

/** Chunk-local flat element index -> global coords. Must mirror the
 *  enumeration order chunkData/chunkDataPerVariable use for sourceCoords
 *  (row-major over elementDims) — the equivalence tests are the check. */
export function chunkElementCoords(origin: number[], elementDims: number[], elemFlat: number): number[] {
  const local = flatIndexToCoords(elemFlat, elementDims);
  return local.map((l, d) => origin[d] + l);
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
  if (r.kind === 'chunk' && r.mode === 'value-preserving') {
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
    const coords = chunkElementCoords(r.origin, r.elementDims, elemFlat);
    const arr = sources.values.get(field.variableName) ?? [];
    const globalFlat = coordsToFlatIndex(coords, layout.shape);
    return {
      traceId: makeTraceId(field.variableName, coords),
      variableName: field.variableName, variableColor: field.variableColor,
      coords, displayValue: formatDisplay(arr[globalFlat], field.dtype, sources.format),
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
  // 'structural' regions: implemented in Task 5.
  return null;
}
