/**
 * Shared helpers for the dataset extraction scripts (run manually:
 *   npx tsx scripts/datasets/etopo-dem.ts
 * Outputs go to data-branch-work/ — gitignored on main; committed to the
 * orphan `data` branch by hand, see README.md alongside this file).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatasetManifest } from '../../src/datasets/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUT_ROOT = path.join(__dirname, '..', '..', 'data-branch-work', 'datasets');

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`extraction failed: ${msg}`);
}

export async function fetchText(url: string): Promise<string> {
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  assert(res.ok, `HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Minimal CSV line parser handling double-quoted fields (GHCN NAME contains
 * commas). No embedded newlines in any source we use. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function writeInt16Bin(dir: string, file: string, values: number[] | Float64Array): void {
  const buf = new ArrayBuffer(values.length * 2);
  const dv = new DataView(buf);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    assert(Number.isInteger(v) && v >= -32768 && v <= 32767, `${file}[${i}]=${v} not int16`);
    dv.setInt16(i * 2, v, true);
  }
  writeFileSync(path.join(dir, file), Buffer.from(buf));
}

export function writeInt32Bin(dir: string, file: string, values: number[]): void {
  const buf = new ArrayBuffer(values.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    assert(Number.isInteger(v) && Math.abs(v) <= 0x7fffffff, `${file}[${i}]=${v} not int32`);
    dv.setInt32(i * 4, v, true);
  }
  writeFileSync(path.join(dir, file), Buffer.from(buf));
}

export function writeFloat32Bin(dir: string, file: string, values: number[] | Float64Array): void {
  const buf = new ArrayBuffer(values.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < values.length; i++) {
    assert(Number.isFinite(values[i]), `${file}[${i}] not finite (NaN in crop?)`);
    dv.setFloat32(i * 4, values[i], true);
  }
  writeFileSync(path.join(dir, file), Buffer.from(buf));
}

export function writeStringColumn(dir: string, baseName: string, values: string[]): { dictFile: string; codesFile: string; codesDtype: 'uint8' | 'uint16' } {
  const dict = Array.from(new Set(values)).sort();
  assert(dict.length <= 65536, `${baseName}: dict too large`);
  const codesDtype = dict.length <= 256 ? 'uint8' : 'uint16';
  const index = new Map(dict.map((s, i) => [s, i]));
  const size = codesDtype === 'uint8' ? 1 : 2;
  const buf = new ArrayBuffer(values.length * size);
  const dv = new DataView(buf);
  values.forEach((s, i) => {
    const code = index.get(s)!;
    if (codesDtype === 'uint8') dv.setUint8(i, code);
    else dv.setUint16(i * 2, code, true);
  });
  const dictFile = `${baseName}.dict.json`;
  const codesFile = `${baseName}.codes.bin`;
  writeFileSync(path.join(dir, dictFile), JSON.stringify(dict, null, 1) + '\n');
  writeFileSync(path.join(dir, codesFile), Buffer.from(buf));
  return { dictFile, codesFile, codesDtype };
}

export function writeManifest(dir: string, manifest: DatasetManifest): void {
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

export function outDir(id: string): string {
  const dir = path.join(OUT_ROOT, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
