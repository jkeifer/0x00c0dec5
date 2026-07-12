import type { CodecDefinition, CodecStep, ParamDef } from '../types/codecs.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { getDtype, isCharDtype } from '../types/dtypes.ts';
import { bytesToValues, valuesToBytes } from './elements.ts';
import { runPyodideCodec } from './pyodideRuntime.ts';
import type { AppState } from '../types/state.ts';

// ─── Delta ──────────────────────────────────────────────────────────────

const delta: CodecDefinition = {
  key: 'delta',
  label: 'Delta',
  category: 'reordering',
  description: 'Store value-to-value differences',
  params: {
    order: { label: 'Order', type: 'number', default: 1, min: 1, max: 3, step: 1 },
  },
  // Task 4.3 (UI-4/SW-7): delta is exact (lossless) for every integer dtype
  // post-Phase-2 — typed-array writes wrap mod 2^N so encode/decode are
  // perfect inverses, including on uint8. Only float dtypes warrant the
  // applicability warning: taking a difference and storing it back at the
  // same float precision re-rounds the value (see `isLossy` below).
  // Char dtypes also warn: "differences between words" is meaningless, so
  // encode/decode below fall back to byte-wise (uint8) delta — still a
  // lossless roundtrip (warnings never block), just not a useful transform.
  applicableTo: (dtype) => {
    const key = dtype as DtypeKey;
    return !getDtype(key).float && !isCharDtype(key);
  },
  // Task 2.6 deviation from the extension spec's plain `lossy: boolean`: delta is
  // exact for integer dtypes (post-2.5, typed-array writes wrap mod 2^N so encode
  // and decode are perfect inverses) but lossy for float dtypes (diffs are
  // re-rounded to the float dtype's precision). A single boolean cannot express
  // that distinction, so `isLossy` is a predicate over the input dtype instead.
  isLossy: (inputDtype) => getDtype(inputDtype).float,
  encode(bytes, inputDtype, params) {
    const order = Number(params.order ?? 1);
    // Char guard (symmetric with decode): bytesToValues on a char dtype
    // returns strings, and string arithmetic is NaN garbage. Treat char
    // input as raw uint8 bytes instead — byte-wise delta, lossless.
    const dtype = isCharDtype(inputDtype as DtypeKey) ? 'uint8' : inputDtype as DtypeKey;
    const values = bytesToValues(bytes, dtype) as Float64Array;

    // Integer dtypes: diffs of integers are integers, so no rounding is needed.
    // Typed-array writes below wrap mod 2^N (DataView setters perform ToInt32 /
    // modulo semantics), which is what makes the round-trip exact for unsigned
    // dtypes — do NOT clamp to the dtype range here (that was DC-2: clamping a
    // negative diff on an unsigned dtype to 0 made the transform irreversible).
    // Float dtypes: values are stored back at the same float precision, which is
    // inherently lossy (see `isLossy` above) — no clamping applies to floats either.
    for (let o = 0; o < order; o++) {
      const prev = [...values];
      for (let i = values.length - 1; i >= 1; i--) {
        values[i] = values[i] - prev[i - 1];
      }
      // values[0] remains unchanged
    }

    return { bytes: valuesToBytes(values, dtype), outputDtype: inputDtype };
  },
  decode(bytes, encodedDtype, params) {
    const order = Number(params.order ?? 1);
    // Symmetric char guard — see encode above.
    const dtype = isCharDtype(encodedDtype as DtypeKey) ? 'uint8' : encodedDtype as DtypeKey;
    const values = bytesToValues(bytes, dtype) as Float64Array;

    // Cumulative sum (prefix sum), applied `order` times. No clamping — see the
    // encode-side comment above. The typed-array write in valuesToBytes wraps
    // mod 2^N for integer dtypes, undoing encode's wrap exactly.
    for (let o = 0; o < order; o++) {
      for (let i = 1; i < values.length; i++) {
        values[i] = values[i] + values[i - 1];
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
    elementSize: { label: 'Element Size', type: 'number', default: 4, min: 1, max: 16, step: 1 },
  },
  // Task 4.3 (UI-4): `applicableTo` only receives the input dtype, not the
  // step's `elementSize` param, so this can only judge dtype-level
  // applicability: shuffling is a no-op transpose on 1-byte dtypes (nothing
  // to transpose within a single-byte element), so warn there. The
  // param-vs-dtype mismatch (elementSize != dtype size) is a *separate*,
  // param-aware warning — see `stepWarnings` below, which is what actually
  // catches the "shuffle needs to know the element boundary" lesson.
  applicableTo: (dtype) => getDtype(dtype as DtypeKey).size > 1,
  isLossy: () => false,
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
  // Task 4.3 (UI-4): RLE operates byte-wise with no notion of element
  // boundaries or numeric interpretation — it is always applicable,
  // regardless of dtype. (It may of course *inflate* incompressible input;
  // that is a size warning, not an applicability one — see the pipeline
  // strip's size-increase coloring.)
  applicableTo: () => true,
  isLossy: () => false,
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
  // Task 4.3 (UI-4): same reasoning as RLE — LZ is a byte-wise back-reference
  // scheme with no dtype-specific assumptions, so it is always applicable.
  applicableTo: () => true,
  isLossy: () => false,
  encode(bytes, _inputDtype, params) {
    const windowSize = Number(params.windowSize ?? 256);
    if (bytes.length === 0) {
      return { bytes: new Uint8Array(0), outputDtype: 'uint8' };
    }

    // Hash-chain LZ77 (how real encoders find matches): a head table maps a
    // 3-byte-prefix hash to the most recent position, chained through prev[].
    // Replaces the O(n*window) backward scan; format unchanged (see decode).
    const HASH_BITS = 16;
    const HASH_SIZE = 1 << HASH_BITS;
    const MAX_CHAIN = 64; // candidates examined per position; quality/speed knob
    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(bytes.length).fill(-1);
    const hashAt = (i: number) =>
      ((bytes[i] << 10) ^ (bytes[i + 1] << 5) ^ bytes[i + 2]) & (HASH_SIZE - 1);
    const insert = (i: number) => {
      if (i + 2 >= bytes.length) return;
      const h = hashAt(i);
      prev[i] = head[h];
      head[h] = i;
    };

    // Growable output (number[] push on multi-MB inputs is the old cliff).
    let out = new Uint8Array(Math.max(64, bytes.length >> 2));
    let outLen = 0;
    const push = (...vals: number[]) => {
      if (outLen + vals.length > out.length) {
        const next = new Uint8Array(out.length * 2 + vals.length);
        next.set(out.subarray(0, outLen));
        out = next;
      }
      for (const v of vals) out[outLen++] = v;
    };

    let i = 0;
    while (i < bytes.length) {
      let bestLen = 0;
      let bestOffset = 0;
      if (i + 2 < bytes.length) {
        let candidate = head[hashAt(i)];
        let chain = 0;
        const windowStart = i - windowSize;
        while (candidate >= 0 && candidate >= windowStart && chain < MAX_CHAIN) {
          let matchLen = 0;
          while (
            i + matchLen < bytes.length &&
            bytes[candidate + matchLen] === bytes[i + matchLen] &&
            matchLen < 255
          ) {
            matchLen++;
          }
          if (matchLen >= 3 && matchLen > bestLen) {
            bestLen = matchLen;
            bestOffset = i - candidate;
            if (matchLen === 255) break;
          }
          candidate = prev[candidate];
          chain++;
        }
      }

      if (bestLen >= 3) {
        // Match: [length, offset_hi, offset_lo] — candidates are always < i, so
        // bytes[candidate + matchLen] may read at/past i; that's the legal
        // overlapping-match case the decoder already supports byte-by-byte.
        push(bestLen, (bestOffset >> 8) & 0xff, bestOffset & 0xff);
        for (let k = 0; k < bestLen; k++) insert(i + k);
        i += bestLen;
      } else {
        // Literal: [0x00, byte]
        push(0x00, bytes[i]);
        insert(i);
        i++;
      }
    }

    return { bytes: out.slice(0, outLen), outputDtype: 'uint8' };
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

// ─── Real codecs (project 4): actual numcodecs via Pyodide ─────────────────
//
// Ordinary entropy entries — uint8 output dtype, chunk-level trace
// degradation, codec_pipelines metadata, and read-side reversal all come
// from the same machinery RLE/LZ use. The only differences: `runtime:
// 'pyodide'` (picker/gating) and encode/decode delegating to numcodecs.
// numcodecs.get_codec consumes the same config-dict shape Zarr metadata
// stores, so params translate 1:1.

const BLOSC_SHUFFLE: Record<string, number> = { none: 0, byte: 1, bit: 2 };

function pyodideCodec(opts: {
  key: string;
  label: string;
  description: string;
  params: Record<string, ParamDef>;
  config: (params: Record<string, number | string>) => Record<string, unknown>;
}): CodecDefinition {
  return {
    key: opts.key,
    label: opts.label,
    category: 'entropy',
    runtime: 'pyodide',
    description: opts.description,
    params: opts.params,
    applicableTo: () => true,
    isLossy: () => false,
    encode: (bytes, _inputDtype, params) => ({
      bytes: runPyodideCodec('encode', opts.config(params), bytes),
      outputDtype: 'uint8',
    }),
    decode: (bytes, _encodedDtype, params) => ({
      bytes: runPyodideCodec('decode', opts.config(params), bytes),
      outputDtype: 'uint8',
    }),
  };
}

const zstdCodec = pyodideCodec({
  key: 'zstd',
  label: 'Zstd (real)',
  description: 'Real Zstandard compression via numcodecs — the default compressor in modern Zarr.',
  params: {
    level: { label: 'Level', type: 'number', default: 3, min: 1, max: 22, step: 1 },
  },
  config: (p) => ({ id: 'zstd', level: Number(p.level ?? 3) }),
});

const gzipCodec = pyodideCodec({
  key: 'gzip',
  label: 'GZip (real)',
  description: 'Real DEFLATE/gzip via numcodecs — the same algorithm behind .gz files and PNG.',
  params: {
    level: { label: 'Level', type: 'number', default: 6, min: 0, max: 9, step: 1 },
  },
  config: (p) => ({ id: 'gzip', level: Number(p.level ?? 6) }),
});

const bloscCodec = pyodideCodec({
  key: 'blosc',
  label: 'Blosc (real)',
  description: 'Real Blosc meta-compressor via numcodecs — note it has byte/bit shuffle BUILT IN, the same trick as the educational Byte Shuffle step.',
  params: {
    cname: { label: 'Compressor', type: 'select', default: 'lz4', options: ['lz4', 'zstd', 'zlib'] },
    clevel: { label: 'Level', type: 'number', default: 5, min: 1, max: 9, step: 1 },
    shuffle: { label: 'Shuffle', type: 'select', default: 'byte', options: ['none', 'byte', 'bit'] },
  },
  config: (p) => ({
    id: 'blosc',
    cname: String(p.cname ?? 'lz4'),
    clevel: Number(p.clevel ?? 5),
    shuffle: BLOSC_SHUFFLE[String(p.shuffle ?? 'byte')] ?? 1,
  }),
});

// ─── Registry ───────────────────────────────────────────────────────────

export const CODEC_REGISTRY: Record<string, CodecDefinition> = {
  'delta': delta,
  'byte-shuffle': byteShuffle,
  'rle': rle,
  'lz': lz,
  zstd: zstdCodec,
  gzip: gzipCodec,
  blosc: bloscCodec,
};

// ─── Dtype flow (UI-15) ───────────────────────────────────────────────────

/**
 * Cheap dtype-flow rule for a single codec step, without running `encode`.
 *
 * UI-15: `CodecPipelineEditor` used to re-implement this rule locally
 * (`computeRunningDtype`: "entropy codecs collapse to uint8, everything else
 * preserves dtype"). That is a real invariant of the registry today — every
 * `encode` honors it — but it was duplicated rather than derived, so it would
 * go silently stale the day a dtype-changing codec (e.g. a future
 * scale/offset-as-codec) was added. This is the single source of truth both
 * the editor and any other dtype-flow consumer should call instead.
 */
export function outputDtypeFor(codec: CodecDefinition, inputDtype: DtypeKey): DtypeKey {
  return codec.category === 'entropy' ? 'uint8' : inputDtype;
}

/** True when any configured pipeline step references a runtime-backed codec.
 *  Used by the worker to decide whether a compute must await Pyodide init.
 *  Deliberately checks ALL fieldPipelines (including ones inactive in row
 *  mode): the worst case of the conservative answer is an unnecessary await,
 *  never a wrong result. */
export function stateUsesPyodideCodec(
  state: Pick<AppState, 'fieldPipelines' | 'chunkPipeline'>,
): boolean {
  const usesRuntime = (steps: CodecStep[]) =>
    steps.some((s) => CODEC_REGISTRY[s.codec]?.runtime === 'pyodide');
  if (usesRuntime(state.chunkPipeline)) return true;
  return Object.values(state.fieldPipelines).some(usesRuntime);
}

/**
 * Run the dtype-flow rule across an entire pipeline, returning the dtype fed
 * into (and the dtype produced by) each step. `runningDtypes[i]` is the input
 * dtype seen by `steps[i]`; the function's return value is the pipeline's
 * final output dtype.
 */
function computeDtypeFlow(steps: CodecStep[], inputDtype: DtypeKey): DtypeKey[] {
  const runningDtypes: DtypeKey[] = [];
  let dtype = inputDtype;
  for (const step of steps) {
    runningDtypes.push(dtype);
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;
    dtype = outputDtypeFor(codec, dtype);
  }
  return runningDtypes;
}

// ─── Applicability warnings (UI-4, SW-7, task 4.3) ────────────────────────

/**
 * Single source of truth for codec-step warnings, shared by
 * `CodecPipelineEditor` (per-step ⚠ icon) and `PipelineStrip` (Encoded-stage
 * ⚠ icon). Returns one human-readable warning string per problem found —
 * empty when the pipeline has nothing to warn about.
 *
 * Per docs/design.md's "Codec Applicability and Warnings" section, this is
 * advisory only: it never blocks or alters the pipeline's actual encode
 * behavior, it only surfaces text for the UI to render.
 *
 * Two independent checks feed into this:
 *  - `codec.applicableTo(dtype)` — dtype-level applicability (e.g. delta on
 *    float, shuffle on 1-byte dtypes).
 *  - Byte Shuffle's `elementSize` param vs. the actual input dtype size —
 *    `applicableTo` only receives the dtype, not the step's params, so this
 *    mismatch can't be expressed there. It is exactly the "shuffle needs to
 *    know the element boundary" lesson the design doc is built around.
 */
export function stepWarnings(steps: CodecStep[], inputDtype: DtypeKey): string[] {
  const warnings: string[] = [];
  const runningDtypes = computeDtypeFlow(steps, inputDtype);

  steps.forEach((step, i) => {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) return;
    const dtype = runningDtypes[i];
    const dtypeInfo = getDtype(dtype);

    if (!codec.applicableTo(dtype)) {
      if (step.codec === 'delta' && dtypeInfo.char) {
        warnings.push(
          `Delta on ${dtypeInfo.label} has no numeric meaning — it falls back to byte-wise differences (lossless, but rarely useful for text).`,
        );
      } else if (step.codec === 'delta') {
        warnings.push(
          `Delta on ${dtypeInfo.label} is lossy — differences are re-rounded to float precision each step (integer dtypes round-trip exactly; this is why).`,
        );
      } else {
        warnings.push(
          `${codec.label} is not applicable to ${dtypeInfo.label} input — results may be garbled or meaningless.`,
        );
      }
    }

    if (step.codec === 'byte-shuffle') {
      const elementSize = Number(step.params.elementSize ?? 4);
      if (elementSize !== dtypeInfo.size) {
        warnings.push(
          `Element size ${elementSize} doesn't match dtype size ${dtypeInfo.size} — bytes will be grouped incorrectly (this is the lesson: shuffle needs to know the element boundary).`,
        );
      }
    }
  });

  return warnings;
}

// ─── Pipeline Execution ─────────────────────────────────────────────────

export interface CodecPipelineResult {
  bytes: Uint8Array;
  outputDtype: string;
}

/**
 * Run a sequence of codec steps on input bytes.
 *
 * Per-byte tracing through this pipeline is computed on demand from the
 * Encoded stage's StageLayout (buildEncodedLayout in layout.ts), not
 * threaded through here — see CLAUDE.md pitfall 1. The dtype-flow rule this
 * pipeline follows (entropy codecs -> uint8, everything else preserves
 * dtype) is exactly what buildEncodedLayout mirrors via outputDtypeFor.
 */
export function runCodecPipeline(
  inputBytes: Uint8Array,
  steps: CodecStep[],
  inputDtype: DtypeKey,
): CodecPipelineResult {
  let currentBytes = inputBytes;
  let currentDtype: DtypeKey = inputDtype;

  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;

    const result = codec.encode(currentBytes, currentDtype, step.params);
    currentBytes = result.bytes;
    currentDtype = result.outputDtype as DtypeKey;
  }

  return {
    bytes: currentBytes,
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
