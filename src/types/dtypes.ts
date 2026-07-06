export type DtypeKey =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'float32'
  | 'float64'
  | 'char4'
  | 'char8'
  | 'char16';

/**
 * A logical (pre-storage) value: numbers for numeric variables, strings for
 * text (charN) variables. Chunking, tracing, and scattering copy values by
 * index with zero arithmetic, so they operate on LogicalValue directly; the
 * few sites that do math on values branch on `typeof`.
 */
export type LogicalValue = number | string;

export interface DtypeInfo {
  key: DtypeKey;
  label: string;
  size: number;
  signed: boolean;
  float: boolean;
  /** Fixed-width ASCII text dtype (char4/char8/char16). `size` is the
   * bytes-per-value stride, exactly as for numeric dtypes. */
  char?: boolean;
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
  char4: {
    key: 'char4',
    label: 'Char[4]',
    size: 4,
    signed: false,
    float: false,
    char: true,
    min: 0,
    max: 0,
    TypedArray: Uint8Array,
  },
  char8: {
    key: 'char8',
    label: 'Char[8]',
    size: 8,
    signed: false,
    float: false,
    char: true,
    min: 0,
    max: 0,
    TypedArray: Uint8Array,
  },
  char16: {
    key: 'char16',
    label: 'Char[16]',
    size: 16,
    signed: false,
    float: false,
    char: true,
    min: 0,
    max: 0,
    TypedArray: Uint8Array,
  },
};

export const DTYPE_KEYS: DtypeKey[] = Object.keys(DTYPE_REGISTRY) as DtypeKey[];

export function getDtype(key: DtypeKey): DtypeInfo {
  return DTYPE_REGISTRY[key];
}

/** Whether `key` is a fixed-width text dtype (char4/char8/char16). */
export function isCharDtype(key: DtypeKey): boolean {
  return DTYPE_REGISTRY[key]?.char === true;
}
