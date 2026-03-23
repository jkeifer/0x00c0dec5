import type { VirtualFile, ReadFileResult, VariableStats } from '../types/pipeline.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import type { CodecStep } from '../types/codecs.ts';
import type { TypeAssignment } from '../types/state.ts';
import { getDtype } from '../types/dtypes.ts';
import { bytesToValues } from './elements.ts';
import { deserializeMetadata, type MetadataEntry } from './metadata.ts';
import { reverseCodecPipeline } from './decode.ts';
import { reverseTypeAssignment } from './typeAssign.ts';

/**
 * Read a set of virtual files produced by the Write step and attempt
 * to reconstruct the original dataset values.
 */
export function readFile(
  files: VirtualFile[],
  magicNumber: string,
): ReadFileResult {
  // Parse magic number
  const magicBytes = magicNumber
    ? hexToBytes(magicNumber)
    : new Uint8Array(0);

  // Identify main data file vs sidecar metadata file
  const sidecarFile = files.find((f) => f.name === 'metadata');
  const dataFiles = files.filter((f) => f.name !== 'metadata');

  if (dataFiles.length === 0) {
    return makeFailure(0);
  }

  // Try to find metadata
  let metadataEntries: MetadataEntry[] | null = null;

  // 1. Check sidecar
  if (sidecarFile && sidecarFile.bytes.length > 0) {
    try {
      metadataEntries = deserializeMetadata(sidecarFile.bytes);
    } catch {
      // sidecar parse failed, continue
    }
  }

  // 2. Check embedded in main file (only for single-file mode)
  if (!metadataEntries && dataFiles.length === 1) {
    const mainBytes = dataFiles[0].bytes;
    const dataBytes = stripMagic(mainBytes, magicBytes);

    // Try header: right after start magic
    metadataEntries = tryParseEmbeddedMetadata(dataBytes, 'header');

    // Try footer: before end magic
    if (!metadataEntries) {
      metadataEntries = tryParseEmbeddedMetadata(dataBytes, 'footer');
    }
  }

  // If no metadata found → failure
  if (!metadataEntries || metadataEntries.length === 0) {
    const totalBytes = dataFiles.reduce((sum, f) => sum + f.bytes.length, 0);
    return makeFailure(totalBytes);
  }

  // Extract structural info from metadata
  const metaMap = new Map(metadataEntries.map((e) => [e.key, e.value]));

  const schemaStr = metaMap.get('schema');
  const shapeStr = metaMap.get('shape');
  const chunkShapeStr = metaMap.get('chunk_shape');
  const interleavingStr = metaMap.get('interleaving') ?? 'column';
  const codecPipelinesStr = metaMap.get('codec_pipelines');
  const chunkIndexStr = metaMap.get('chunk_index');
  const typeAssignmentsStr = metaMap.get('type_assignments');
  const variableStatisticsStr = metaMap.get('variable_statistics');

  if (!schemaStr || !shapeStr || !chunkShapeStr) {
    const totalBytes = dataFiles.reduce((sum, f) => sum + f.bytes.length, 0);
    return makeFailure(totalBytes);
  }

  try {
    const schema: { name: string; dtype: DtypeKey }[] = JSON.parse(schemaStr);
    const shape: number[] = JSON.parse(shapeStr);
    const chunkShape: number[] = JSON.parse(chunkShapeStr);
    const interleaving = interleavingStr as 'row' | 'column';
    const totalElements = shape.reduce((a, b) => a * b, 1);

    // Parse codec pipelines
    let fieldPipelines: Record<string, CodecStep[]> | null = null;
    let chunkPipeline: CodecStep[] | null = null;
    if (codecPipelinesStr) {
      const parsed = JSON.parse(codecPipelinesStr);
      if (Array.isArray(parsed)) {
        chunkPipeline = parsed;
      } else {
        fieldPipelines = parsed;
      }
    }

    // Parse chunk index
    let chunkIndex: { coords: number[]; offset: number; size: number }[] | null = null;
    if (chunkIndexStr) {
      chunkIndex = JSON.parse(chunkIndexStr);
    }

    // Parse type assignments (if present)
    let typeAssignments: Record<string, TypeAssignment> | null = null;
    if (typeAssignmentsStr) {
      typeAssignments = JSON.parse(typeAssignmentsStr);
    }

    // Parse variable statistics for lossy detection
    let variableStatistics: Record<string, VariableStats> | null = null;
    if (variableStatisticsStr) {
      variableStatistics = JSON.parse(variableStatisticsStr);
    }

    // Determine which variables are lossy based on statistics
    const lossyVariables = new Set<string>();
    if (variableStatistics) {
      for (const [varName, stats] of Object.entries(variableStatistics)) {
        if (stats.isLossy) {
          lossyVariables.add(varName);
        }
      }
    }

    // Reconstruct values
    let reconstructedValues: Map<string, number[]>;
    if (dataFiles.length === 1) {
      // Single file mode
      const mainBytes = dataFiles[0].bytes;

      reconstructedValues = reconstructValues(
        mainBytes,
        schema,
        totalElements,
        interleaving,
        fieldPipelines,
        chunkPipeline,
        chunkIndex,
        chunkShape,
        shape,
      );
    } else {
      // Per-chunk file mode
      reconstructedValues = reconstructFromChunkFiles(
        dataFiles,
        magicBytes,
        schema,
        totalElements,
        interleaving,
        fieldPipelines,
        chunkPipeline,
        chunkIndex,
        chunkShape,
        shape,
      );
    }

    // Reverse type assignments to get back to logical values
    if (typeAssignments) {
      for (const [varName, assignment] of Object.entries(typeAssignments)) {
        const values = reconstructedValues.get(varName);
        if (values) {
          const typedAssignment: TypeAssignment = {
            storageDtype: assignment.storageDtype as DtypeKey,
            scale: assignment.scale,
            offset: assignment.offset,
            keepBits: assignment.keepBits,
          };
          // The reconstructed values are already in the storage dtype's value space
          // (they were read from bytes using the storage dtype).
          // We need to reverse the scale/offset to get back to logical values.
          const hasScaleOffset = (typedAssignment.scale !== undefined && typedAssignment.scale !== 1) ||
            (typedAssignment.offset !== undefined && typedAssignment.offset !== 0);
          if (hasScaleOffset) {
            const scale = typedAssignment.scale ?? 1;
            const offset = typedAssignment.offset ?? 0;
            const reversed = values.map((v) => v / scale + offset);
            reconstructedValues.set(varName, reversed);
          }
        }
      }
    }

    return {
      success: true,
      reconstructedValues,
      lossyVariables,
    };
  } catch {
    const totalBytes = dataFiles.reduce((sum, f) => sum + f.bytes.length, 0);
    return makeFailure(totalBytes);
  }
}

function makeFailure(totalBytes: number): ReadFileResult {
  return {
    success: false,
    errorMessage:
      `Cannot read file.\n\n` +
      `The file contains ${totalBytes} bytes of data but no metadata describing how to interpret them. ` +
      `A reader needs to know: the variable names and types, the data shape, how the data was chunked ` +
      `and interleaved, and what codecs were applied — in order to reverse the encoding and reconstruct values.\n\n` +
      `Enable "Include metadata" in the Write step to make this file self-describing.`,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s/g, '');
  if (cleaned.length % 2 !== 0 || cleaned.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return bytes;
}

function stripMagic(fileBytes: Uint8Array, magic: Uint8Array): Uint8Array {
  if (magic.length === 0) return fileBytes;
  const start = magic.length;
  const end = fileBytes.length - magic.length;
  if (end <= start) return new Uint8Array(0);
  return fileBytes.slice(start, end);
}

function tryParseEmbeddedMetadata(
  dataBytes: Uint8Array,
  position: 'header' | 'footer',
): MetadataEntry[] | null {
  if (dataBytes.length === 0) return null;

  try {
    if (position === 'header') {
      // Try JSON: starts with `{`
      if (dataBytes[0] === 0x7b) {
        // Find the end of JSON by looking for the matching `}`
        const text = new TextDecoder().decode(dataBytes);
        let braceCount = 0;
        let endIdx = -1;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '{') braceCount++;
          else if (text[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIdx = i + 1;
              break;
            }
          }
        }
        if (endIdx > 0) {
          const jsonBytes = dataBytes.slice(0, new TextEncoder().encode(text.slice(0, endIdx)).length);
          const entries = deserializeMetadata(jsonBytes);
          if (entries.length > 0) return entries;
        }
      }
      // Try binary: first 4 bytes are uint32 count
      if (dataBytes.length >= 4) {
        const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
        const count = view.getUint32(0, true);
        if (count > 0 && count < 1000) {
          try {
            const entries = deserializeMetadata(dataBytes);
            if (entries.length > 0) return entries;
          } catch {
            // not valid binary metadata
          }
        }
      }
    } else {
      // Footer: try to find JSON or binary at end
      // Try JSON: find last `}` and work backwards to find matching `{`
      const text = new TextDecoder().decode(dataBytes);
      const lastBrace = text.lastIndexOf('}');
      if (lastBrace >= 0) {
        let braceCount = 0;
        let startIdx = -1;
        for (let i = lastBrace; i >= 0; i--) {
          if (text[i] === '}') braceCount++;
          else if (text[i] === '{') {
            braceCount--;
            if (braceCount === 0) {
              startIdx = i;
              break;
            }
          }
        }
        if (startIdx >= 0) {
          const jsonStr = text.slice(startIdx, lastBrace + 1);
          const jsonBytes = new TextEncoder().encode(jsonStr);
          try {
            const entries = deserializeMetadata(jsonBytes);
            if (entries.length > 0) return entries;
          } catch {
            // not valid JSON
          }
        }
      }
    }
  } catch {
    // parse failed
  }

  return null;
}

function reconstructValues(
  fileBytes: Uint8Array,
  schema: { name: string; dtype: DtypeKey }[],
  totalElements: number,
  interleaving: 'row' | 'column',
  fieldPipelines: Record<string, CodecStep[]> | null,
  chunkPipeline: CodecStep[] | null,
  chunkIndex: { coords: number[]; offset: number; size: number }[] | null,
  _chunkShape: number[],
  _shape: number[],
): Map<string, number[]> {
  const reconstructedValues = new Map<string, number[]>();

  if (interleaving === 'column') {
    // Column mode: chunks are per-variable, ordered by variable then spatially
    const chunksPerVariable = chunkIndex
      ? Math.floor(chunkIndex.length / schema.length)
      : 1;

    if (chunkIndex && chunkIndex.length > 0) {
      // Use chunk index offsets directly — they are relative to file start
      let varChunkIdx = 0;
      for (const varInfo of schema) {
        const allVarBytes: Uint8Array[] = [];
        for (let c = 0; c < chunksPerVariable; c++) {
          const idx = varChunkIdx * chunksPerVariable + c;
          if (idx < chunkIndex.length) {
            const ci = chunkIndex[idx];
            allVarBytes.push(fileBytes.slice(ci.offset, ci.offset + ci.size));
          }
        }

        const varEncodedBytes = concatBytes(allVarBytes);
        const steps = fieldPipelines?.[varInfo.name] ?? [];
        const decoded = reverseCodecPipeline(varEncodedBytes, steps, varInfo.dtype);
        const values = bytesToValues(decoded.bytes, decoded.outputDtype as DtypeKey);
        reconstructedValues.set(varInfo.name, values.slice(0, totalElements));
        varChunkIdx++;
      }
    } else {
      // No chunk index — shouldn't happen with proper metadata
      // Fall back: assume data follows magic with no metadata
      let byteOffset = 0;
      for (const varInfo of schema) {
        const dtypeInfo = getDtype(varInfo.dtype);
        const rawSize = totalElements * dtypeInfo.size;
        const varBytes = fileBytes.slice(byteOffset, byteOffset + rawSize);
        const values = bytesToValues(varBytes, varInfo.dtype);
        reconstructedValues.set(varInfo.name, values);
        byteOffset += rawSize;
      }
    }
  } else {
    // Row mode: each chunk has interleaved multi-variable bytes
    const steps = chunkPipeline ?? [];

    // Determine the effective dtype for row mode
    const uniqueDtypes = new Set(schema.map((v) => v.dtype));
    const inputDtype: DtypeKey = uniqueDtypes.size > 1 ? 'uint8' : schema[0]?.dtype ?? 'uint8';

    if (chunkIndex && chunkIndex.length > 0) {
      const allDecodedBytes: Uint8Array[] = [];

      for (const ci of chunkIndex) {
        const chunkBytes = fileBytes.slice(ci.offset, ci.offset + ci.size);
        const decoded = reverseCodecPipeline(chunkBytes, steps, inputDtype);
        allDecodedBytes.push(decoded.bytes);
      }

      const decodedBytes = concatBytes(allDecodedBytes);
      deinterleaveRow(decodedBytes, schema, totalElements, reconstructedValues);
    } else {
      // Single chunk, no index
      const decoded = reverseCodecPipeline(fileBytes, steps, inputDtype);
      deinterleaveRow(decoded.bytes, schema, totalElements, reconstructedValues);
    }
  }

  return reconstructedValues;
}

function deinterleaveRow(
  bytes: Uint8Array,
  schema: { name: string; dtype: DtypeKey }[],
  totalElements: number,
  result: Map<string, number[]>,
): void {
  // Row interleaving: for each element, bytes are interleaved per-variable
  // Layout: [var0_elem0_bytes][var1_elem0_bytes]...[var0_elem1_bytes][var1_elem1_bytes]...
  const bytesPerElement = schema.reduce((sum, v) => sum + getDtype(v.dtype).size, 0);

  for (const varInfo of schema) {
    result.set(varInfo.name, []);
  }

  for (let elem = 0; elem < totalElements; elem++) {
    let varByteOffset = 0;
    for (const varInfo of schema) {
      const dtypeInfo = getDtype(varInfo.dtype);
      const start = elem * bytesPerElement + varByteOffset;
      const elemBytes = bytes.slice(start, start + dtypeInfo.size);
      const values = bytesToValues(elemBytes, varInfo.dtype);
      if (values.length > 0) {
        result.get(varInfo.name)!.push(values[0]);
      }
      varByteOffset += dtypeInfo.size;
    }
  }
}

function reconstructFromChunkFiles(
  dataFiles: VirtualFile[],
  magicBytes: Uint8Array,
  schema: { name: string; dtype: DtypeKey }[],
  totalElements: number,
  interleaving: 'row' | 'column',
  fieldPipelines: Record<string, CodecStep[]> | null,
  chunkPipeline: CodecStep[] | null,
  _chunkIndex: { coords: number[]; offset: number; size: number }[] | null,
  _chunkShape: number[],
  _shape: number[],
): Map<string, number[]> {
  const reconstructedValues = new Map<string, number[]>();

  if (interleaving === 'column') {
    // Per-chunk files in column mode: each file is one variable's chunk
    // File names are like "temperature_chunk_0", "pressure_chunk_0"
    for (const varInfo of schema) {
      const varFiles = dataFiles.filter((f) => f.name.startsWith(varInfo.name + '_chunk_'));
      // Sort by chunk index from filename
      varFiles.sort((a, b) => {
        const aIdx = extractChunkIndexFromName(a.name);
        const bIdx = extractChunkIndexFromName(b.name);
        return aIdx - bIdx;
      });

      const allBytes: Uint8Array[] = [];
      for (const f of varFiles) {
        const stripped = stripMagic(f.bytes, magicBytes);
        allBytes.push(stripped);
      }

      const varEncodedBytes = concatBytes(allBytes);
      const steps = fieldPipelines?.[varInfo.name] ?? [];
      const decoded = reverseCodecPipeline(varEncodedBytes, steps, varInfo.dtype);
      const values = bytesToValues(decoded.bytes, decoded.outputDtype as DtypeKey);
      reconstructedValues.set(varInfo.name, values.slice(0, totalElements));
    }
  } else {
    // Row mode per-chunk: each file is a chunk with interleaved data
    const steps = chunkPipeline ?? [];
    const uniqueDtypes = new Set(schema.map((v) => v.dtype));
    const inputDtype: DtypeKey = uniqueDtypes.size > 1 ? 'uint8' : schema[0]?.dtype ?? 'uint8';

    // Sort chunk files by name
    const chunkFiles = dataFiles.filter((f) => f.name.startsWith('chunk_'));
    chunkFiles.sort((a, b) => {
      const aIdx = extractChunkIndexFromName(a.name);
      const bIdx = extractChunkIndexFromName(b.name);
      return aIdx - bIdx;
    });

    const allDecodedBytes: Uint8Array[] = [];
    for (const f of chunkFiles) {
      const stripped = stripMagic(f.bytes, magicBytes);
      const decoded = reverseCodecPipeline(stripped, steps, inputDtype);
      allDecodedBytes.push(decoded.bytes);
    }

    const decodedBytes = concatBytes(allDecodedBytes);
    deinterleaveRow(decodedBytes, schema, totalElements, reconstructedValues);
  }

  return reconstructedValues;
}

function extractChunkIndexFromName(name: string): number {
  // Extract trailing number(s) from names like "chunk_0", "temperature_chunk_0_1"
  const parts = name.split('_');
  const nums = parts.filter((p) => /^\d+$/.test(p)).map(Number);
  // Use the last number as a simple sort key
  return nums.length > 0 ? nums[nums.length - 1] : 0;
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
