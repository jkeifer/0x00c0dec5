import type { CodecDefinition, CodecStep } from '../types/codecs.ts';
import type { ByteTrace } from '../types/pipeline.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype } from '../types/dtypes.ts';
import { bytesToValues, valuesToBytes } from './elements.ts';
import { propagateTracesValuePreserving, degradeTracesToChunkLevel } from './trace.ts';

// ─── Delta ──────────────────────────────────────────────────────────────

const delta: CodecDefinition = {
  key: 'delta',
  label: 'Delta',
  category: 'reordering',
  description: 'Store value-to-value differences',
  params: {
    order: { label: 'Order', type: 'number', default: 1, min: 1, max: 3, step: 1 },
  },
  applicableTo: () => true,
  encode(bytes, inputDtype, params) {
    const order = Number(params.order ?? 1);
    const dtype = inputDtype as DtypeKey;
    let values = bytesToValues(bytes, dtype);

    for (let o = 0; o < order; o++) {
      const prev = [...values];
      for (let i = values.length - 1; i >= 1; i--) {
        values[i] = values[i] - prev[i - 1];
      }
      // values[0] remains unchanged
    }

    // Clamp integer values to type range
    const info = getDtype(dtype);
    if (!info.float) {
      values = values.map((v) => {
        v = Math.round(v);
        return Math.max(info.min, Math.min(info.max, v));
      });
    }

    return { bytes: valuesToBytes(values, dtype), outputDtype: inputDtype };
  },
  decode(bytes, encodedDtype, params) {
    const order = Number(params.order ?? 1);
    const dtype = encodedDtype as DtypeKey;
    const values = bytesToValues(bytes, dtype);

    // Cumulative sum (prefix sum), applied `order` times
    for (let o = 0; o < order; o++) {
      for (let i = 1; i < values.length; i++) {
        values[i] = values[i] + values[i - 1];
      }
    }

    // Clamp integer values to type range
    const info = getDtype(dtype);
    if (!info.float) {
      for (let i = 0; i < values.length; i++) {
        values[i] = Math.round(values[i]);
        values[i] = Math.max(info.min, Math.min(info.max, values[i]));
      }
    }

    return { bytes: valuesToBytes(values, dtype), outputDtype: encodedDtype };
  },
};

// ─── Byte Shuffle ───────────────────────────────────────────────────────

const byteShuffle: CodecDefinition = {
  key: 'byte-shuffle',
  label: 'Byte Shuffle',
  category: 'reordering',
  description: 'Transpose bytes by position within each element',
  params: {
    elementSize: { label: 'Element Size', type: 'number', default: 4, min: 1, max: 8, step: 1 },
  },
  applicableTo: () => true,
  encode(bytes, inputDtype, params) {
    const elementSize = Number(params.elementSize ?? 4);
    if (elementSize <= 1 || bytes.length === 0) {
      return { bytes: new Uint8Array(bytes), outputDtype: inputDtype };
    }

    const numElements = Math.floor(bytes.length / elementSize);
    const usableBytes = numElements * elementSize;
    const result = new Uint8Array(bytes.length);

    // Transpose: (numElements, elementSize) → (elementSize, numElements)
    for (let e = 0; e < numElements; e++) {
      for (let b = 0; b < elementSize; b++) {
        result[b * numElements + e] = bytes[e * elementSize + b];
      }
    }

    // Copy remaining bytes (if any) unchanged
    for (let i = usableBytes; i < bytes.length; i++) {
      result[i] = bytes[i];
    }

    return { bytes: result, outputDtype: inputDtype };
  },
  decode(bytes, encodedDtype, params) {
    const elementSize = Number(params.elementSize ?? 4);
    if (elementSize <= 1 || bytes.length === 0) {
      return { bytes: new Uint8Array(bytes), outputDtype: encodedDtype };
    }

    const numElements = Math.floor(bytes.length / elementSize);
    const usableBytes = numElements * elementSize;
    const result = new Uint8Array(bytes.length);

    // Inverse transpose: result[e * elementSize + b] = input[b * numElements + e]
    for (let e = 0; e < numElements; e++) {
      for (let b = 0; b < elementSize; b++) {
        result[e * elementSize + b] = bytes[b * numElements + e];
      }
    }

    // Copy remaining bytes (if any) unchanged
    for (let i = usableBytes; i < bytes.length; i++) {
      result[i] = bytes[i];
    }

    return { bytes: result, outputDtype: encodedDtype };
  },
};

// ─── RLE ────────────────────────────────────────────────────────────────

const rle: CodecDefinition = {
  key: 'rle',
  label: 'RLE',
  category: 'entropy',
  description: 'Run-length encoding: (count, value) byte pairs',
  params: {},
  applicableTo: () => true,
  encode(bytes, _inputDtype) {
    if (bytes.length === 0) {
      return { bytes: new Uint8Array(0), outputDtype: 'uint8' };
    }

    const output: number[] = [];
    let i = 0;
    while (i < bytes.length) {
      const value = bytes[i];
      let count = 1;
      while (i + count < bytes.length && bytes[i + count] === value && count < 255) {
        count++;
      }
      output.push(count, value);
      i += count;
    }

    return { bytes: new Uint8Array(output), outputDtype: 'uint8' };
  },
  decode(bytes, _encodedDtype) {
    if (bytes.length === 0) {
      return { bytes: new Uint8Array(0), outputDtype: 'uint8' };
    }

    const output: number[] = [];
    for (let i = 0; i < bytes.length; i += 2) {
      const count = bytes[i];
      const value = bytes[i + 1];
      for (let j = 0; j < count; j++) {
        output.push(value);
      }
    }

    return { bytes: new Uint8Array(output), outputDtype: 'uint8' };
  },
};

// ─── LZ ─────────────────────────────────────────────────────────────────

const lz: CodecDefinition = {
  key: 'lz',
  label: 'LZ (simple)',
  category: 'entropy',
  description: 'Simplified LZ77 with back-references',
  params: {
    windowSize: { label: 'Window Size', type: 'number', default: 256, min: 3, max: 32768, step: 1 },
  },
  applicableTo: () => true,
  encode(bytes, _inputDtype, params) {
    const windowSize = Number(params.windowSize ?? 256);
    if (bytes.length === 0) {
      return { bytes: new Uint8Array(0), outputDtype: 'uint8' };
    }

    const output: number[] = [];
    let i = 0;

    while (i < bytes.length) {
      let bestLen = 0;
      let bestOffset = 0;

      const searchStart = Math.max(0, i - windowSize);
      for (let j = searchStart; j < i; j++) {
        let matchLen = 0;
        while (i + matchLen < bytes.length && bytes[j + matchLen] === bytes[i + matchLen] && matchLen < 255) {
          matchLen++;
        }
        if (matchLen >= 3 && matchLen > bestLen) {
          bestLen = matchLen;
          bestOffset = i - j;
        }
      }

      if (bestLen >= 3) {
        // Match: [length, offset_hi, offset_lo]
        output.push(bestLen, (bestOffset >> 8) & 0xff, bestOffset & 0xff);
        i += bestLen;
      } else {
        // Literal: [0x00, byte]
        output.push(0x00, bytes[i]);
        i++;
      }
    }

    return { bytes: new Uint8Array(output), outputDtype: 'uint8' };
  },
  decode(bytes, _encodedDtype) {
    if (bytes.length === 0) {
      return { bytes: new Uint8Array(0), outputDtype: 'uint8' };
    }

    const output: number[] = [];
    let i = 0;

    while (i < bytes.length) {
      const token = bytes[i];
      if (token === 0x00) {
        // Literal: [0x00, byte]
        output.push(bytes[i + 1]);
        i += 2;
      } else {
        // Match: [length, offset_hi, offset_lo]
        const matchLen = token;
        const offset = (bytes[i + 1] << 8) | bytes[i + 2];
        const start = output.length - offset;
        for (let j = 0; j < matchLen; j++) {
          output.push(output[start + j]);
        }
        i += 3;
      }
    }

    return { bytes: new Uint8Array(output), outputDtype: 'uint8' };
  },
};

// ─── Registry ───────────────────────────────────────────────────────────

export const CODEC_REGISTRY: Record<string, CodecDefinition> = {
  'delta': delta,
  'byte-shuffle': byteShuffle,
  'rle': rle,
  'lz': lz,
};

// ─── Pipeline Execution ─────────────────────────────────────────────────

export interface CodecPipelineResult {
  bytes: Uint8Array;
  traces: ByteTrace[];
  stages: { name: string; bytes: Uint8Array; traces: ByteTrace[] }[];
  outputDtype: string;
}

/**
 * Run a sequence of codec steps on input bytes, propagating traces.
 */
export function runCodecPipeline(
  inputBytes: Uint8Array,
  inputTraces: ByteTrace[],
  steps: CodecStep[],
  inputDtype: DtypeKey,
): CodecPipelineResult {
  let currentBytes = inputBytes;
  let currentTraces = inputTraces;
  let currentDtype: DtypeKey = inputDtype;
  const stages: { name: string; bytes: Uint8Array; traces: ByteTrace[] }[] = [];

  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;

    const result = codec.encode(currentBytes, currentDtype, step.params);

    const outputDtype = result.outputDtype as DtypeKey;

    if (codec.category === 'entropy') {
      currentTraces = degradeTracesToChunkLevel(currentTraces, result.bytes.length);
    } else {
      currentTraces = propagateTracesValuePreserving(currentTraces, currentDtype, outputDtype);
    }

    currentBytes = result.bytes;
    currentDtype = outputDtype;

    stages.push({
      name: codec.label,
      bytes: new Uint8Array(currentBytes),
      traces: [...currentTraces],
    });
  }

  return {
    bytes: currentBytes,
    traces: currentTraces,
    stages,
    outputDtype: currentDtype,
  };
}

// ─── Entropy ────────────────────────────────────────────────────────────

/** Calculate Shannon entropy in bits per byte. */
export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;

  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) {
    counts[bytes[i]]++;
  }

  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i] > 0) {
      const p = counts[i] / bytes.length;
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}
