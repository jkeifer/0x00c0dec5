import { getDtype } from '../types/dtypes.ts';
import type { DtypeKey } from '../types/dtypes.ts';

type DataViewSetter = (byteOffset: number, value: number, littleEndian?: boolean) => void;
type DataViewGetter = (byteOffset: number, littleEndian?: boolean) => number;

/** Convert an array of typed values to little-endian bytes. */
export function valuesToBytes(values: number[], dtype: DtypeKey): Uint8Array {
  const info = getDtype(dtype);
  const byteLength = values.length * info.size;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  const setter = getDataViewSetter(view, dtype);
  for (let i = 0; i < values.length; i++) {
    setter(i * info.size, values[i], true);
  }

  return new Uint8Array(buffer);
}

/** Convert little-endian bytes back to typed values. */
export function bytesToValues(bytes: Uint8Array, dtype: DtypeKey): number[] {
  const info = getDtype(dtype);
  const count = bytes.length / info.size;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = new Array(count);

  const getter = getDataViewGetter(view, dtype);
  for (let i = 0; i < count; i++) {
    values[i] = getter(i * info.size, true);
  }

  return values;
}

/** Format a numeric value for display based on dtype. */
export function formatValue(value: number, dtype: DtypeKey): string {
  const info = getDtype(dtype);
  if (info.float) {
    return value.toPrecision(6);
  }
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
  }
}
