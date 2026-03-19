export type DtypeKey =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'float32'
  | 'float64';

export interface DtypeInfo {
  key: DtypeKey;
  label: string;
  size: number;
  signed: boolean;
  float: boolean;
  min: number;
  max: number;
  TypedArray:
    | typeof Int8Array
    | typeof Uint8Array
    | typeof Int16Array
    | typeof Uint16Array
    | typeof Int32Array
    | typeof Uint32Array
    | typeof Float32Array
    | typeof Float64Array;
}

export const DTYPE_REGISTRY: Record<DtypeKey, DtypeInfo> = {
  int8: {
    key: 'int8',
    label: 'Int8',
    size: 1,
    signed: true,
    float: false,
    min: -128,
    max: 127,
    TypedArray: Int8Array,
  },
  uint8: {
    key: 'uint8',
    label: 'UInt8',
    size: 1,
    signed: false,
    float: false,
    min: 0,
    max: 255,
    TypedArray: Uint8Array,
  },
  int16: {
    key: 'int16',
    label: 'Int16',
    size: 2,
    signed: true,
    float: false,
    min: -32768,
    max: 32767,
    TypedArray: Int16Array,
  },
  uint16: {
    key: 'uint16',
    label: 'UInt16',
    size: 2,
    signed: false,
    float: false,
    min: 0,
    max: 65535,
    TypedArray: Uint16Array,
  },
  int32: {
    key: 'int32',
    label: 'Int32',
    size: 4,
    signed: true,
    float: false,
    min: -2147483648,
    max: 2147483647,
    TypedArray: Int32Array,
  },
  uint32: {
    key: 'uint32',
    label: 'UInt32',
    size: 4,
    signed: false,
    float: false,
    min: 0,
    max: 4294967295,
    TypedArray: Uint32Array,
  },
  float32: {
    key: 'float32',
    label: 'Float32',
    size: 4,
    signed: true,
    float: true,
    min: -3.4028235e38,
    max: 3.4028235e38,
    TypedArray: Float32Array,
  },
  float64: {
    key: 'float64',
    label: 'Float64',
    size: 8,
    signed: true,
    float: true,
    min: -1.7976931348623157e308,
    max: 1.7976931348623157e308,
    TypedArray: Float64Array,
  },
};

export const DTYPE_KEYS: DtypeKey[] = Object.keys(DTYPE_REGISTRY) as DtypeKey[];

export function getDtype(key: DtypeKey): DtypeInfo {
  return DTYPE_REGISTRY[key];
}
