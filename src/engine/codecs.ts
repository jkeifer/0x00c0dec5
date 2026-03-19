import type { CodecDefinition, CodecStep } from '../types/codecs.ts';
import type { ByteTrace } from '../types/pipeline.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype, DTYPE_KEYS } from '../types/dtypes.ts';
import { bytesToValues, valuesToBytes } from './elements.ts';
import { propagateTracesValuePreserving, degradeTracesToChunkLevel } from './trace.ts';

// ─── Scale/Offset ───────────────────────────────────────────────────────

const scaleOffset: CodecDefinition = {
  key: 'scale-offset',
  label: 'Scale/Offset',
  category: 'mapping',
  description: '(value - offset) * scale, cast to output dtype',
  params: {
    scale: { label: 'Scale', type: 'number', default: 1, min: -1e9, max: 1e9, step: 0.1 },
    offset: { label: 'Offset', type: 'number', default: 0, min: -1e9, max: 1e9, step: 0.1 },
    outputDtype: {
      label: 'Output Type',
      type: 'select',
      default: 'int16',
      options: [...DTYPE_KEYS],
    },
  },
  applicableTo: () => true,
  encode(bytes, inputDtype, params) {
    const outDtype = (params.outputDtype ?? 'int16') as DtypeKey;
    const scale = Number(params.scale ?? 1);
    const offset = Number(params.offset ?? 0);
    const outInfo = getDtype(outDtype);

    const values = bytesToValues(bytes, inputDtype as DtypeKey);
    const transformed = values.map((v) => {
      let result = (v - offset) * scale;
      if (!outInfo.float) {
        result = Math.round(result);
        result = Math.max(outInfo.min, Math.min(outInfo.max, result));
      }
      return result;
    });

    return { bytes: valuesToBytes(transformed, outDtype), outputDtype: outDtype };
  },
};

// ─── Bit Round ──────────────────────────────────────────────────────────

const bitround: CodecDefinition = {
  key: 'bitround',
  label: 'Bit Round',
  category: 'mapping',
  description: 'Zero least-significant mantissa bits for better compressibility',
  params: {
    keepBits: { label: 'Keep Bits', type: 'number', default: 10, min: 1, max: 23, step: 1 },
  },
  applicableTo: (dtype) => dtype === 'float32' || dtype === 'float64',
  encode(bytes, inputDtype, params) {
    const keepBits = Number(params.keepBits ?? 10);
    const result = new Uint8Array(bytes.length);
    result.set(bytes);

    if (inputDtype === 'float32') {
      const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
      const mask = 0xffffffff << (23 - keepBits);
      for (let i = 0; i < result.length; i += 4) {
        const bits = view.getUint32(i, true);
        view.setUint32(i, bits & mask, true);
      }
    } else if (inputDtype === 'float64') {
      const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
      const maskHigh = 0xffffffff << Math.max(0, 20 - keepBits);
      const maskLow = keepBits >= 20 ? 0xffffffff << (52 - keepBits) : 0;
      for (let i = 0; i < result.length; i += 8) {
        const low = view.getUint32(i, true);
        const high = view.getUint32(i + 4, true);
        view.setUint32(i, low & maskLow, true);
        view.setUint32(i + 4, high & maskHigh, true);
      }
    }

    return { bytes: result, outputDtype: inputDtype };
  },
};

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
};

// ─── Registry ───────────────────────────────────────────────────────────

export const CODEC_REGISTRY: Record<string, CodecDefinition> = {
  'scale-offset': scaleOffset,
  'bitround': bitround,
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
