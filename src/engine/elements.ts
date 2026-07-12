import { getDtype, isCharDtype } from '../types/dtypes.ts';
import type { DtypeKey, LogicalValue } from '../types/dtypes.ts';
import type { ValueArray } from './layout.ts';

type DataViewSetter = (byteOffset: number, value: number, littleEndian?: boolean) => void;
type DataViewGetter = (byteOffset: number, littleEndian?: boolean) => number;

/**
 * Convert an array of typed values to little-endian bytes.
 *
 * charN dtypes: each value is stringified, non-ASCII chars replaced with '?',
 * truncated to N chars, and space-padded to exactly N bytes. (ASCII-only this
 * phase — UTF-8 truncation mid-codepoint is a great future lesson, out of scope.)
 *
 * `byteOrder` defaults to 'little' so every untouched call site is byte-identical
 * to the pre-endianness behavior. Char dtypes ignore it (one byte per char).
 */
export function valuesToBytes(
  values: ValueArray,
  dtype: DtypeKey,
  byteOrder: 'little' | 'big' = 'little',
): Uint8Array {
  const info = getDtype(dtype);
  const byteLength = values.length * info.size;

  if (isCharDtype(dtype)) {
    const out = new Uint8Array(byteLength);
    out.fill(0x20); // space padding
    for (let i = 0; i < values.length; i++) {
      const str = String(values[i]);
      const n = Math.min(str.length, info.size);
      for (let c = 0; c < n; c++) {
        const code = str.charCodeAt(c);
        out[i * info.size + c] = code <= 0x7f ? code : 0x3f; // '?'
      }
    }
    return out;
  }

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  const littleEndian = byteOrder === 'little';
  const setter = getDataViewSetter(view, dtype);
  for (let i = 0; i < values.length; i++) {
    setter(i * info.size, values[i] as number, littleEndian);
  }

  return new Uint8Array(buffer);
}

/**
 * Convert little-endian bytes back to typed values.
 *
 * charN dtypes: each N-byte slice decodes to an ASCII string with trailing
 * spaces (the padding) trimmed.
 *
 * `byteOrder` defaults to 'little' (see valuesToBytes). Char dtypes ignore it.
 */
export function bytesToValues(
  bytes: Uint8Array,
  dtype: DtypeKey,
  byteOrder: 'little' | 'big' = 'little',
): ValueArray {
  const info = getDtype(dtype);
  const count = bytes.length / info.size;
  if (!Number.isInteger(count)) {
    // A fractional element count means the byte slice being decoded doesn't
    // line up with whole values of this dtype — e.g. a short tail slice from
    // deinterleaving, or a chunk boundary that doesn't match the claimed
    // geometry. Surface a descriptive error (caught upstream in read.ts and
    // reported as a 'decode-error') instead of letting DataView throw a raw,
    // unexplained RangeError once indexing runs past the buffer.
    throw new Error(
      `bytesToValues: ${bytes.length} bytes is not a whole number of ${dtype} values ` +
      `(${info.size} bytes each) — got ${count} elements. The byte slice being decoded ` +
      `doesn't match the expected layout for this dtype.`,
    );
  }
  if (isCharDtype(dtype)) {
    const values: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
      let str = '';
      for (let c = 0; c < info.size; c++) {
        str += String.fromCharCode(bytes[i * info.size + c]);
      }
      values[i] = trimTrailingSpaces(str);
    }
    return values;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Numeric dtypes uniformly return Float64Array (brief, Task 11 Step 2):
  // simplest ValueArray shape regardless of storage dtype width/signedness.
  const values = new Float64Array(count);

  const littleEndian = byteOrder === 'little';
  const getter = getDataViewGetter(view, dtype);
  for (let i = 0; i < count; i++) {
    values[i] = getter(i * info.size, littleEndian);
  }

  return values;
}

function trimTrailingSpaces(str: string): string {
  let end = str.length;
  while (end > 0 && str[end - 1] === ' ') end--;
  return str.slice(0, end);
}

/** Format a typed value for display based on dtype. */
export function formatValue(value: LogicalValue, dtype: DtypeKey): string {
  if (typeof value === 'string') {
    return trimTrailingSpaces(value);
  }
  const info = getDtype(dtype);
  if (info.float) {
    return value.toPrecision(6);
  }
  return String(value);
}

/** Format a logical value for display (exact, no binary dtype artifacts). */
export function formatLogicalValue(value: LogicalValue): string {
  return String(value);
}

function getDataViewSetter(view: DataView, dtype: DtypeKey): DataViewSetter {
  switch (dtype) {
    case 'int8':
      return view.setInt8.bind(view);
    case 'uint8':
      return view.setUint8.bind(view);
    case 'int16':
      return view.setInt16.bind(view);
    case 'uint16':
      return view.setUint16.bind(view);
    case 'int32':
      return view.setInt32.bind(view);
    case 'uint32':
      return view.setUint32.bind(view);
    case 'float32':
      return view.setFloat32.bind(view);
    case 'float64':
      return view.setFloat64.bind(view);
    case 'char4':
    case 'char8':
    case 'char16':
      // Unreachable: valuesToBytes handles char dtypes before reaching here.
      throw new Error(`char dtypes have no DataView setter (${dtype})`);
  }
}

function getDataViewGetter(view: DataView, dtype: DtypeKey): DataViewGetter {
  switch (dtype) {
    case 'int8':
      return view.getInt8.bind(view);
    case 'uint8':
      return view.getUint8.bind(view);
    case 'int16':
      return view.getInt16.bind(view);
    case 'uint16':
      return view.getUint16.bind(view);
    case 'int32':
      return view.getInt32.bind(view);
    case 'uint32':
      return view.getUint32.bind(view);
    case 'float32':
      return view.getFloat32.bind(view);
    case 'float64':
      return view.getFloat64.bind(view);
    case 'char4':
    case 'char8':
    case 'char16':
      // Unreachable: bytesToValues handles char dtypes before reaching here.
      throw new Error(`char dtypes have no DataView getter (${dtype})`);
  }
}
