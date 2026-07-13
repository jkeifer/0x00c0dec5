import type { ValueArray } from '../engine/layout.ts';
import type {
  DatasetManifest, ManifestVariable, NumericBinDtype,
} from './types.ts';

const CODES_DTYPES: readonly string[] = ['uint8', 'uint16'];

const READERS: Record<NumericBinDtype, { size: number; read: (dv: DataView, off: number) => number }> = {
  int16:   { size: 2, read: (dv, o) => dv.getInt16(o, true) },
  int32:   { size: 4, read: (dv, o) => dv.getInt32(o, true) },
  float32: { size: 4, read: (dv, o) => dv.getFloat32(o, true) },
  float64: { size: 8, read: (dv, o) => dv.getFloat64(o, true) },
};

const NUMERIC_DTYPES: readonly string[] = Object.keys(READERS);

function fail(msg: string): never {
  throw new Error(`dataset manifest invalid: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural validation of a fetched manifest. Throws (never coerces):
 * a bad manifest is a data-branch bug, not user input — surface it.
 * `knownIds` is passed by the caller (the registry, which owns the id list)
 * rather than duplicated here. */
export function validateManifest(raw: unknown, knownIds: readonly string[]): DatasetManifest {
  if (!isRecord(raw)) fail('not an object');
  if (typeof raw.id !== 'string' || !knownIds.includes(raw.id)) fail(`unknown id ${JSON.stringify(raw.id)}`);
  if (!Array.isArray(raw.shape) || raw.shape.length === 0 ||
      !raw.shape.every((d) => typeof d === 'number' && Number.isInteger(d) && d > 0)) {
    fail('shape must be positive integers');
  }
  const att = raw.attribution;
  if (!isRecord(att) || ['source', 'source_url', 'retrieved', 'license'].some((k) => typeof att[k] !== 'string')) {
    fail('attribution must have source/source_url/retrieved/license strings');
  }
  if (!Array.isArray(raw.variables) || raw.variables.length === 0) fail('variables must be non-empty');
  const names = new Set<string>();
  for (const v of raw.variables) {
    if (!isRecord(v) || typeof v.name !== 'string' || v.name === '') fail('variable missing name');
    if (names.has(v.name)) fail(`duplicate variable name ${v.name}`);
    names.add(v.name);
    if (!isRecord(v.logicalType)) fail(`${v.name}: missing logicalType`);
    if (v.kind === 'number') {
      if (typeof v.dtype !== 'string' || !NUMERIC_DTYPES.includes(v.dtype)) fail(`${v.name}: bad dtype`);
      if (typeof v.file !== 'string') fail(`${v.name}: missing file`);
      if (typeof v.min !== 'number' || typeof v.max !== 'number') fail(`${v.name}: missing min/max`);
    } else if (v.kind === 'string') {
      if (typeof v.dictFile !== 'string' || typeof v.codesFile !== 'string') fail(`${v.name}: missing dict/codes file`);
      if (typeof v.codesDtype !== 'string' || !CODES_DTYPES.includes(v.codesDtype)) fail(`${v.name}: bad codesDtype`);
    } else {
      fail(`${v.name}: kind must be 'number' or 'string'`);
    }
  }
  return raw as unknown as DatasetManifest;
}

/** Decode a little-endian numeric bin into logical (float64) values.
 * Explicit-LE DataView reads, not typed-array views (platform endianness). */
export function decodeNumericBin(
  buf: ArrayBuffer, dtype: NumericBinDtype, expectedLength: number, label: string,
): Float64Array {
  const { size, read } = READERS[dtype];
  const expectedBytes = expectedLength * size;
  if (buf.byteLength !== expectedBytes) {
    throw new Error(`dataset asset ${label}: expected ${expectedBytes} bytes (${expectedLength} × ${dtype}), got ${buf.byteLength}`);
  }
  const dv = new DataView(buf);
  const out = new Float64Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) out[i] = read(dv, i * size);
  return out;
}

/** Decode a dictionary-coded string column: dict JSON + LE codes bin. */
export function decodeStringColumn(
  dict: unknown, codesBuf: ArrayBuffer, codesDtype: 'uint8' | 'uint16',
  expectedLength: number, label: string,
): string[] {
  if (!Array.isArray(dict) || !dict.every((s) => typeof s === 'string')) {
    throw new Error(`dataset asset ${label}: dict is not a string array`);
  }
  const size = codesDtype === 'uint8' ? 1 : 2;
  if (codesBuf.byteLength !== expectedLength * size) {
    throw new Error(`dataset asset ${label}: expected ${expectedLength * size} bytes of codes, got ${codesBuf.byteLength}`);
  }
  const dv = new DataView(codesBuf);
  const out = new Array<string>(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    const code = codesDtype === 'uint8' ? dv.getUint8(i) : dv.getUint16(i * 2, true);
    if (code >= dict.length) throw new Error(`dataset asset ${label}: code ${code} out of range (dict has ${dict.length})`);
    out[i] = dict[code];
  }
  return out;
}

async function fetchBuf(url: string, label: string, fetchFn: typeof fetch): Promise<ArrayBuffer> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`dataset asset ${label}: fetch failed (${res.status}) — ${url}`);
  return res.arrayBuffer();
}

/** Fetch + decode every variable's values for a manifest. `urlFor` maps a
 * manifest-relative file name to an absolute URL (registry provides it). */
export async function fetchDatasetValues(
  manifest: DatasetManifest,
  urlFor: (file: string) => string,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, ValueArray>> {
  const n = manifest.shape.reduce((a, b) => a * b, 1);
  const out = new Map<string, ValueArray>();
  await Promise.all((manifest.variables as ManifestVariable[]).map(async (v) => {
    if (v.kind === 'number') {
      out.set(v.name, decodeNumericBin(await fetchBuf(urlFor(v.file), v.file, fetchFn), v.dtype, n, v.file));
    } else {
      // Fetch a string column's dict + codes in parallel.
      const [dict, codes] = await Promise.all([
        (async () => {
          const dictRes = await fetchFn(urlFor(v.dictFile));
          if (!dictRes.ok) throw new Error(`dataset asset ${v.dictFile}: fetch failed (${dictRes.status})`);
          return dictRes.json();
        })(),
        fetchBuf(urlFor(v.codesFile), v.codesFile, fetchFn),
      ]);
      out.set(v.name, decodeStringColumn(dict, codes, v.codesDtype, n, v.name));
    }
  }));
  return out;
}
