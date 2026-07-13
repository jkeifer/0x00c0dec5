import { describe, it, expect } from 'vitest';
import {
  validateManifest, decodeNumericBin, decodeStringColumn, fetchDatasetValues,
} from '../../../src/datasets/assets.ts';
import type { DatasetManifest } from '../../../src/datasets/types.ts';

const KNOWN_IDS = ['etopo-dem', 'sst-field', 'ghcn-daily'];

function le16(values: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(values.length * 2);
  const dv = new DataView(buf);
  values.forEach((v, i) => dv.setInt16(i * 2, v, true));
  return buf;
}

const MANIFEST: DatasetManifest = {
  id: 'etopo-dem',
  shape: [2, 2],
  attribution: { source: 's', source_url: 'u', retrieved: '2026-07-12', license: 'PD' },
  variables: [{
    name: 'elevation', kind: 'number', dtype: 'int16', file: 'elevation.bin',
    min: -3, max: 9,
    logicalType: { type: 'integer', min: -3, max: 9, generation: 'smooth' },
  }],
};

describe('validateManifest', () => {
  it('passes a well-formed manifest through', () => {
    expect(validateManifest(JSON.parse(JSON.stringify(MANIFEST)), KNOWN_IDS)).toEqual(MANIFEST);
  });
  it.each([
    ['not an object', 42],
    ['unknown id', { ...MANIFEST, id: 'nope' }],
    ['bad shape', { ...MANIFEST, shape: [0, 2] }],
    ['empty variables', { ...MANIFEST, variables: [] }],
    ['duplicate names', { ...MANIFEST, variables: [MANIFEST.variables[0], MANIFEST.variables[0]] }],
    ['bad dtype', { ...MANIFEST, variables: [{ ...MANIFEST.variables[0], dtype: 'int64' }] }],
    ['missing attribution', { ...MANIFEST, attribution: undefined }],
  ])('throws on %s', (_label, raw) => {
    expect(() => validateManifest(raw, KNOWN_IDS)).toThrow(/dataset manifest/i);
  });
});

describe('decodeNumericBin', () => {
  it('decodes int16 LE to Float64Array', () => {
    const out = decodeNumericBin(le16([-3, 0, 7, 9]), 'int16', 4, 'elevation.bin');
    expect(out).toBeInstanceOf(Float64Array);
    expect(Array.from(out)).toEqual([-3, 0, 7, 9]);
  });
  it('decodes float32 LE', () => {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat32(0, 1.5, true); dv.setFloat32(4, -2.25, true);
    expect(Array.from(decodeNumericBin(buf, 'float32', 2, 'x.bin'))).toEqual([1.5, -2.25]);
  });
  it('throws on byte-length mismatch, naming the file', () => {
    expect(() => decodeNumericBin(le16([1, 2, 3]), 'int16', 4, 'elevation.bin'))
      .toThrow(/elevation\.bin.*8 bytes.*got 6/);
  });
});

describe('decodeStringColumn', () => {
  it('maps codes through the dict', () => {
    const codes = new Uint8Array([0, 1, 1, 0]).buffer;
    expect(decodeStringColumn(['a', 'b'], codes, 'uint8', 4, 'station'))
      .toEqual(['a', 'b', 'b', 'a']);
  });
  it('throws on out-of-range code', () => {
    const codes = new Uint8Array([0, 2]).buffer;
    expect(() => decodeStringColumn(['a', 'b'], codes, 'uint8', 2, 'station'))
      .toThrow(/station.*code 2/);
  });
  it('throws on non-string-array dict and on length mismatch', () => {
    expect(() => decodeStringColumn('nope', new Uint8Array([0]).buffer, 'uint8', 1, 's')).toThrow(/dict/i);
    expect(() => decodeStringColumn(['a'], new Uint8Array([0]).buffer, 'uint8', 2, 's')).toThrow(/2.*got 1/);
  });
});

describe('fetchDatasetValues', () => {
  const files = new Map<string, ArrayBuffer | string>([
    ['elevation.bin', le16([-3, 0, 7, 9])],
  ]);
  const fakeFetch = ((url: string) => {
    const key = url.split('/').pop()!;
    const body = files.get(key);
    if (body === undefined) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(body));
  }) as unknown as typeof fetch;

  it('fetches and decodes every variable, keyed by name', async () => {
    const vals = await fetchDatasetValues(MANIFEST, (f) => `http://x/${f}`, fakeFetch);
    expect(Array.from(vals.get('elevation') as Float64Array)).toEqual([-3, 0, 7, 9]);
  });
  it('rejects on HTTP error, naming the file', async () => {
    const m = { ...MANIFEST, variables: [{ ...MANIFEST.variables[0], file: 'missing.bin' }] };
    await expect(fetchDatasetValues(m, (f) => `http://x/${f}`, fakeFetch))
      .rejects.toThrow(/missing\.bin.*404/);
  });
});
