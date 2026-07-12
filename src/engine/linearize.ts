import type { Chunk, LinearizedChunk } from '../types/pipeline.ts';
import { valuesToBytes } from './elements.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { makeChunkTraceId } from './trace.ts';
import { concatBytes } from './bytes.ts';

/**
 * Linearize a chunk's variables into a flat byte array.
 * Column/BSQ: all bytes for var0, then var1, etc.
 * Row/BIP: for each element i, var0[i] then var1[i] then var2[i].
 *
 * Per-byte tracing for this stage is computed on demand from the Linearized
 * stage's StageLayout (buildLinearizedLayout in layout.ts), not materialized
 * here — see CLAUDE.md pitfall 1.
 */
export function linearizeChunk(
  chunk: Chunk,
  interleaving: 'row' | 'column',
  byteOrder: 'little' | 'big' = 'little',
): LinearizedChunk {
  // Per-variable chunks in column mode get variable-specific chunkIds
  const isSingleVarColumn = interleaving === 'column' && chunk.variables.length === 1;
  const chunkId = isSingleVarColumn
    ? makeChunkTraceId(`${chunk.variables[0].variableName}:${chunk.coords.join(',')}`)
    : makeChunkTraceId(chunk.coords.join(','));
  const variableName = isSingleVarColumn ? chunk.variables[0].variableName : undefined;
  const bytes = buildBytes(chunk, interleaving, byteOrder);

  return { chunkId, coords: chunk.coords, bytes, variableName };
}

function buildBytes(
  chunk: Chunk,
  interleaving: 'row' | 'column',
  byteOrder: 'little' | 'big',
): Uint8Array {
  if (interleaving === 'column') {
    const parts: Uint8Array[] = chunk.variables.map((cv) =>
      valuesToBytes(cv.values, cv.dtype as DtypeKey, byteOrder),
    );
    return concatBytes(parts);
  } else {
    const elementCount = chunk.variables.length > 0 ? chunk.variables[0].values.length : 0;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < elementCount; i++) {
      for (const cv of chunk.variables) {
        parts.push(valuesToBytes([cv.values[i]], cv.dtype as DtypeKey, byteOrder));
      }
    }
    return concatBytes(parts);
  }
}
