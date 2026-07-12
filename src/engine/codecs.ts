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

// ─── Zigzag ─────────────────────────────────────────────────────────────

const zigzagCodec: CodecDefinition = {
  key: 'zigzag',
  label: 'Zigzag',
  category: 'reordering',
  description:
    'Maps signed integers to unsigned so small magnitudes get small byte values '
    + '(0→0, −1→1, 1→2, −2→3 …) — Parquet applies this before RLE/bit-packing. '
    + 'Bijective; byte width unchanged.',
  params: {},
  applicableTo: (dtype) => ['int8', 'int16', 'int32'].includes(dtype),
  isLossy: () => false,
  encode(bytes, inputDtype) {
    return { bytes: zigzagMap(bytes, inputDtype as DtypeKey, 'encode'), outputDtype: inputDtype };
  },
  decode(bytes, encodedDtype) {
    return { bytes: zigzagMap(bytes, encodedDtype as DtypeKey, 'decode'), outputDtype: encodedDtype };
  },
};

/** Per-element zigzag within the dtype's width. Uses 32-bit int math (widest
 * supported signed dtype is int32); encode: (n<<1)^(n>>31) on the
 * sign-extended value, masked back to the dtype width; decode: (u>>>1)^-(u&1). */
function zigzagMap(bytes: Uint8Array, dtype: DtypeKey, op: 'encode' | 'decode'): Uint8Array {
  const size = getDtype(dtype).size;
  const out = new Uint8Array(bytes.length);
  const inView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const outView = new DataView(out.buffer);
  const count = Math.floor(bytes.length / size);
  for (let i = 0; i < count; i++) {
    const off = i * size;
    if (op === 'encode') {
      const n = size === 1 ? inView.getInt8(off) : size === 2 ? inView.getInt16(off, true) : inView.getInt32(off, true);
      const z = ((n << 1) ^ (n >> 31)) >>> 0;
      if (size === 1) outView.setUint8(off, z & 0xff);
      else if (size === 2) outView.setUint16(off, z & 0xffff, true);
      else outView.setUint32(off, z, true);
    } else {
      const z = size === 1 ? inView.getUint8(off) : size === 2 ? inView.getUint16(off, true) : inView.getUint32(off, true);
      const n = (z >>> 1) ^ -(z & 1);
      if (size === 1) outView.setInt8(off, n);
      else if (size === 2) outView.setInt16(off, n, true);
      else outView.setInt32(off, n, true);
    }
  }
  // Trailing partial element (shouldn't occur in practice): copy through.
  for (let i = count * size; i < bytes.length; i++) out[i] = bytes[i];
  return out;
}

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

// ─── Bit Shuffle ────────────────────────────────────────────────────────

const bitShuffleCodec: CodecDefinition = {
  key: 'bit-shuffle',
  label: 'Bit Shuffle',
  category: 'reordering',
  description:
    'Byte Shuffle one level finer: transposes the BITS of a block of elements '
    + 'into bit planes (all elements’ bit 0, then bit 1, …). Slowly varying '
    + 'data yields long constant bit runs — the transform inside blosc/bitshuffle.',
  params: {},
  applicableTo: (dtype) => getDtype(dtype as DtypeKey).size > 1,
  isLossy: () => false,
  encode(bytes, inputDtype) {
    return { bytes: bitTranspose(bytes, getDtype(inputDtype as DtypeKey).size, 'encode'), outputDtype: inputDtype };
  },
  decode(bytes, encodedDtype) {
    return { bytes: bitTranspose(bytes, getDtype(encodedDtype as DtypeKey).size, 'decode'), outputDtype: encodedDtype };
  },
};

/** Transpose bits within each whole block of elements. Block = all complete
 * elements (count*stride bytes); trailing bytes copied through unchanged.
 * encode: output bit-plane p (p in [0, stride*8)) holds bit p of every
 * element, packed in element order. decode is the inverse permutation.
 * O(bits) with plain loops — a chunk is at most tens of MB and this runs in
 * the worker; ponytail: no SIMD/word tricks until profiling asks. */
function bitTranspose(bytes: Uint8Array, stride: number, op: 'encode' | 'decode'): Uint8Array {
  const count = Math.floor(bytes.length / stride);
  const blockBytes = count * stride;
  const out = new Uint8Array(bytes.length);
  const bitsPerElement = stride * 8;
  const getBit = (arr: Uint8Array, bit: number) => (arr[bit >> 3] >> (bit & 7)) & 1;
  const setBit = (arr: Uint8Array, bit: number, v: number) => { if (v) arr[bit >> 3] |= 1 << (bit & 7); };
  for (let el = 0; el < count; el++) {
    for (let p = 0; p < bitsPerElement; p++) {
      const elementBit = el * bitsPerElement + p;   // bit position in element order
      const planeBit = p * count + el;              // bit position in plane order
      if (op === 'encode') setBit(out, planeBit, getBit(bytes, elementBit));
      else setBit(out, elementBit, getBit(bytes, planeBit));
    }
  }
  for (let i = blockBytes; i < bytes.length; i++) out[i] = bytes[i];
  return out;
}

// ─── Dictionary ─────────────────────────────────────────────────────────

const dictionary: CodecDefinition = {
  key: 'dictionary',
  label: 'Dictionary',
  category: 'entropy',
  description:
    'Parquet\'s workhorse: distinct values go into a dictionary, the stream '
    + 'becomes indices into it. Self-contained format — '
    + '[stride][dictCount][dict bytes][indexWidth][indices] — great for '
    + 'low-cardinality data.',
  params: {},
  applicableTo: () => true,
  isLossy: () => false,
  encode(bytes, inputDtype) {
    if (bytes.length === 0) {
      return { bytes: new Uint8Array(0), outputDtype: 'uint8' };
    }

    const stride = getDtype(inputDtype as DtypeKey).size;
    const count = Math.floor(bytes.length / stride);

    // Byte-level dedup keyed on the tuple's byte string — exact even for
    // NaN payloads, since it compares raw bytes rather than decoded values.
    const dict: string[] = [];
    const index = new Map<string, number>();
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const key = String.fromCharCode(...bytes.subarray(i * stride, (i + 1) * stride));
      let id = index.get(key);
      if (id === undefined) {
        id = dict.length;
        index.set(key, id);
        dict.push(key);
      }
      indices[i] = id;
    }

    const dictCount = dict.length;
    const indexWidth = dictCount <= 256 ? 1 : dictCount <= 65536 ? 2 : 4;

    const out = new Uint8Array(1 + 4 + dictCount * stride + 1 + count * indexWidth);
    const view = new DataView(out.buffer);
    out[0] = stride;
    view.setUint32(1, dictCount, true);
    let off = 1 + 4;
    for (const key of dict) {
      for (let b = 0; b < stride; b++) out[off++] = key.charCodeAt(b);
    }
    out[off++] = indexWidth;
    for (let i = 0; i < count; i++) {
      if (indexWidth === 1) out[off] = indices[i];
      else if (indexWidth === 2) view.setUint16(off, indices[i], true);
      else view.setUint32(off, indices[i], true);
      off += indexWidth;
    }

    return { bytes: out, outputDtype: 'uint8' };
  },
  decode(bytes, _encodedDtype) {
    if (bytes.length === 0) {
      return { bytes: new Uint8Array(0), outputDtype: 'uint8' };
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const stride = bytes[0];
    const dictCount = view.getUint32(1, true);
    const dictStart = 1 + 4;
    const indexWidthOff = dictStart + dictCount * stride;
    const indexWidth = bytes[indexWidthOff];
    const indicesStart = indexWidthOff + 1;
    const count = Math.floor((bytes.length - indicesStart) / indexWidth);

    const out = new Uint8Array(count * stride);
    for (let i = 0; i < count; i++) {
      const off = indicesStart + i * indexWidth;
      const id = indexWidth === 1 ? bytes[off]
        : indexWidth === 2 ? view.getUint16(off, true)
        : view.getUint32(off, true);
      out.set(bytes.subarray(dictStart + id * stride, dictStart + (id + 1) * stride), i * stride);
    }

    return { bytes: out, outputDtype: 'uint8' };
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

// ─── Real codecs: actual numcodecs via Pyodide ─────────────────────────────
//
// Ordinary entropy entries — uint8 output dtype, chunk-level trace
// degradation, codec_pipelines metadata, and read-side reversal all come
// from the same machinery RLE uses. The only differences: `runtime:
// 'pyodide'` (picker/gating) and encode/decode delegating to numcodecs.
// numcodecs.get_codec consumes the same config-dict shape Zarr metadata
// stores, so params translate 1:1.

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
  label: 'Zstd',
  description: 'Real Zstandard compression via numcodecs — the default compressor in modern Zarr.',
  params: {
    level: { label: 'Level', type: 'number', default: 3, min: 1, max: 22, step: 1 },
  },
  config: (p) => ({ id: 'zstd', level: Number(p.level ?? 3) }),
});

const gzipCodec = pyodideCodec({
  key: 'gzip',
  label: 'GZip',
  description: 'Real DEFLATE/gzip via numcodecs — the same algorithm behind .gz files and PNG.',
  params: {
    level: { label: 'Level', type: 'number', default: 6, min: 0, max: 9, step: 1 },
  },
  config: (p) => ({ id: 'gzip', level: Number(p.level ?? 6) }),
});

const deflateCodec = pyodideCodec({
  key: 'deflate',
  label: 'Deflate',
  description: "The algorithm inside GZip, in a bare zlib container — compare the first bytes with GZip's 1f 8b magic: same compressed stream, different wrapper.",
  params: {
    level: { label: 'Level', type: 'number', default: 6, min: 1, max: 9, step: 1 },
  },
  config: (p) => ({ id: 'zlib', level: Number(p.level ?? 6) }),
});

// ─── Registry ───────────────────────────────────────────────────────────
//
// Insertion order IS the picker order (binding constraint — see CodecPipelineEditor).
// Curated, pedagogical order: reordering transforms first (delta, zigzag,
// byte-shuffle, bit-shuffle), then dictionary, then entropy codecs (rle,
// deflate, gzip, zstd).

export const CODEC_REGISTRY: Record<string, CodecDefinition> = {
  'delta': delta,
  'zigzag': zigzagCodec,
  'byte-shuffle': byteShuffle,
  'bit-shuffle': bitShuffleCodec,
  'dictionary': dictionary,
  'rle': rle,
  'deflate': deflateCodec,
  gzip: gzipCodec,
  zstd: zstdCodec,
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
