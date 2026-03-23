import type { Chunk, LinearizedChunk, ByteTrace } from '../types/pipeline.ts';
import { valuesToBytes } from './elements.ts';
import { formatValue } from './elements.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';

/**
 * Linearize a chunk's variables into a flat byte array with traces.
 * Column/BSQ: all bytes for var0, then var1, etc.
 * Row/BIP: for each element i, var0[i] then var1[i] then var2[i].
 */
export function linearizeChunk(
  chunk: Chunk,
  interleaving: 'row' | 'column',
): LinearizedChunk {
  // Per-variable chunks in column mode get variable-specific chunkIds
  const isSingleVarColumn = interleaving === 'column' && chunk.variables.length === 1;
  const chunkId = isSingleVarColumn
    ? `chunk:${chunk.variables[0].variableName}:${chunk.coords.join(',')}`
    : `chunk:${chunk.coords.join(',')}`;
  const variableName = isSingleVarColumn ? chunk.variables[0].variableName : undefined;
  const traces = buildTraces(chunk, interleaving, chunkId);
  const bytes = buildBytes(chunk, interleaving);

  return { chunkId, coords: chunk.coords, bytes, traces, variableName };
}

/** Build per-byte traces for the linearized chunk. */
export function buildTraces(
  chunk: Chunk,
  interleaving: 'row' | 'column',
  chunkId?: string,
): ByteTrace[] {
  const resolvedChunkId = chunkId ?? `chunk:${chunk.coords.join(',')}`;
  const traces: ByteTrace[] = [];

  if (interleaving === 'column') {
    for (const cv of chunk.variables) {
      const dtypeInfo = getDtype(cv.dtype as DtypeKey);
      for (let i = 0; i < cv.values.length; i++) {
        const traceId = `${cv.variableName}:${coordsToKey(cv.sourceCoords[i])}`;
        for (let b = 0; b < dtypeInfo.size; b++) {
          traces.push({
            traceId,
            variableName: cv.variableName,
            variableColor: cv.variableColor,
            coords: cv.sourceCoords[i],
            displayValue: formatValue(cv.values[i], cv.dtype as DtypeKey),
            dtype: cv.dtype,
            chunkId: resolvedChunkId,
            byteInValue: b,
            byteCount: dtypeInfo.size,
          });
        }
      }
    }
  } else {
    const elementCount = chunk.variables.length > 0 ? chunk.variables[0].values.length : 0;
    for (let i = 0; i < elementCount; i++) {
      for (const cv of chunk.variables) {
        const dtypeInfo = getDtype(cv.dtype as DtypeKey);
        const traceId = `${cv.variableName}:${coordsToKey(cv.sourceCoords[i])}`;
        for (let b = 0; b < dtypeInfo.size; b++) {
          traces.push({
            traceId,
            variableName: cv.variableName,
            variableColor: cv.variableColor,
            coords: cv.sourceCoords[i],
            displayValue: formatValue(cv.values[i], cv.dtype as DtypeKey),
            dtype: cv.dtype,
            chunkId: resolvedChunkId,
            byteInValue: b,
            byteCount: dtypeInfo.size,
          });
        }
      }
    }
  }

  return traces;
}

function buildBytes(chunk: Chunk, interleaving: 'row' | 'column'): Uint8Array {
  if (interleaving === 'column') {
    const parts: Uint8Array[] = chunk.variables.map((cv) =>
      valuesToBytes(cv.values, cv.dtype as DtypeKey),
    );
    return concatBytes(parts);
  } else {
    const elementCount = chunk.variables.length > 0 ? chunk.variables[0].values.length : 0;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < elementCount; i++) {
      for (const cv of chunk.variables) {
        parts.push(valuesToBytes([cv.values[i]], cv.dtype as DtypeKey));
      }
    }
    return concatBytes(parts);
  }
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function coordsToKey(coords: number[]): string {
  return coords.join(',');
}
