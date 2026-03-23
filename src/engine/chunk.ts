import type { Variable } from '../types/state.ts';
import type { Chunk, ChunkVariable } from '../types/pipeline.ts';

/** Compute the chunk grid dimensions: ceil(shape[d] / chunkShape[d]) per dimension. */
export function computeChunkGrid(shape: number[], chunkShape: number[]): number[] {
  return shape.map((s, d) => Math.ceil(s / Math.min(chunkShape[d], s)));
}

/** Total number of chunks (product of chunk grid dimensions). */
export function computeChunkCount(shape: number[], chunkShape: number[]): number {
  const grid = computeChunkGrid(shape, chunkShape);
  return grid.reduce((acc, g) => acc * g, 1);
}

/** Enumerate all chunk coordinates in row-major order. */
export function enumerateChunkCoords(chunkGrid: number[]): number[][] {
  const total = chunkGrid.reduce((acc, g) => acc * g, 1);
  const coords: number[][] = [];
  for (let i = 0; i < total; i++) {
    coords.push(flatIndexToCoords(i, chunkGrid));
  }
  return coords;
}

/** Convert a flat index to N-d coordinates (row-major). */
export function flatIndexToCoords(flatIndex: number, shape: number[]): number[] {
  const coords: number[] = new Array(shape.length);
  let remaining = flatIndex;
  for (let d = shape.length - 1; d >= 0; d--) {
    coords[d] = remaining % shape[d];
    remaining = Math.floor(remaining / shape[d]);
  }
  return coords;
}

/** Convert N-d coordinates to a flat index (row-major). */
export function coordsToFlatIndex(coords: number[], shape: number[]): number {
  let index = 0;
  for (let d = 0; d < shape.length; d++) {
    index = index * shape[d] + coords[d];
  }
  return index;
}

/**
 * Extract chunk data from generated values for all variables.
 * Each chunk contains sliced values for each variable, with source coordinate tracking.
 */
export function chunkData(
  shape: number[],
  chunkShape: number[],
  variables: Variable[],
  variableValues: Map<string, number[]>,
): Chunk[] {
  const clampedChunkShape = chunkShape.map((cs, d) => Math.min(cs, shape[d]));
  const chunkGrid = computeChunkGrid(shape, chunkShape);
  const chunkCoords = enumerateChunkCoords(chunkGrid);

  return chunkCoords.map((coords, flatIndex) => {
    const chunkVars: ChunkVariable[] = variables.map((v) => {
      const allValues = variableValues.get(v.name);
      if (!allValues) {
        return {
          variableName: v.name,
          variableColor: v.color,
          dtype: v.dtype,
          values: [],
          sourceCoords: [],
        };
      }

      const { values, sourceCoords } = extractChunkValues(
        allValues,
        shape,
        clampedChunkShape,
        coords,
      );

      return {
        variableName: v.name,
        variableColor: v.color,
        dtype: v.dtype,
        values,
        sourceCoords,
      };
    });

    return { coords, flatIndex, variables: chunkVars };
  });
}

/**
 * Produce one chunk per variable per spatial region (for column-oriented mode).
 * Each chunk has a single-element `variables` array.
 * Ordering: all spatial chunks for var A, then all spatial chunks for var B, etc.
 */
export function chunkDataPerVariable(
  shape: number[],
  chunkShape: number[],
  variables: Variable[],
  variableValues: Map<string, number[]>,
): Chunk[] {
  const clampedChunkShape = chunkShape.map((cs, d) => Math.min(cs, shape[d]));
  const chunkGrid = computeChunkGrid(shape, chunkShape);
  const chunkCoords = enumerateChunkCoords(chunkGrid);

  const result: Chunk[] = [];

  for (const v of variables) {
    for (let spatialIdx = 0; spatialIdx < chunkCoords.length; spatialIdx++) {
      const coords = chunkCoords[spatialIdx];
      const allValues = variableValues.get(v.name);

      const chunkVar: ChunkVariable = allValues
        ? (() => {
            const { values, sourceCoords } = extractChunkValues(
              allValues,
              shape,
              clampedChunkShape,
              coords,
            );
            return {
              variableName: v.name,
              variableColor: v.color,
              dtype: v.dtype,
              values,
              sourceCoords,
            };
          })()
        : {
            variableName: v.name,
            variableColor: v.color,
            dtype: v.dtype,
            values: [],
            sourceCoords: [],
          };

      result.push({
        coords,
        flatIndex: spatialIdx,
        variables: [chunkVar],
      });
    }
  }

  return result;
}

/** Extract values belonging to a specific chunk, returning values and their source coordinates. */
function extractChunkValues(
  allValues: number[],
  shape: number[],
  clampedChunkShape: number[],
  chunkCoords: number[],
): { values: number[]; sourceCoords: number[][] } {
  const startIndices = chunkCoords.map((c, d) => c * clampedChunkShape[d]);
  const endIndices = startIndices.map((s, d) => Math.min(s + clampedChunkShape[d], shape[d]));
  const chunkExtent = endIndices.map((e, d) => e - startIndices[d]);

  const totalElements = chunkExtent.reduce((acc, e) => acc * e, 1);
  const values: number[] = new Array(totalElements);
  const sourceCoords: number[][] = new Array(totalElements);

  for (let i = 0; i < totalElements; i++) {
    const localCoords = flatIndexToCoords(i, chunkExtent);
    const globalCoords = localCoords.map((lc, d) => lc + startIndices[d]);
    const globalFlatIndex = coordsToFlatIndex(globalCoords, shape);

    values[i] = allValues[globalFlatIndex];
    sourceCoords[i] = globalCoords;
  }

  return { values, sourceCoords };
}
