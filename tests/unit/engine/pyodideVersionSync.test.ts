// public/sw.js cannot import from src/, so the pinned Pyodide version is
// duplicated there. This test is the thing that makes that duplication safe.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PYODIDE_VERSION } from '../../../src/engine/pyodideRuntime.ts';

describe('pyodide version pin consistency', () => {
  it('sw.js pins the same PYODIDE_VERSION as pyodideRuntime.ts', () => {
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain(`const PYODIDE_VERSION = '${PYODIDE_VERSION}'`);
  });
});
