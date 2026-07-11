import type { ByteTrace } from '../types/pipeline.ts';
import type { DtypeKey, LogicalValue } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import { makeTraceId } from './trace.ts';
import { formatValue, formatLogicalValue } from './elements.ts';
import { flatIndexToCoords } from './chunk.ts';

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
  // 'chunk' and 'structural' regions: implemented in Tasks 3–5.
  return null;
}
