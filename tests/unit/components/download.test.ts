import { describe, it, expect } from 'vitest';
import { normalizeDownloadFilename } from '../../../src/components/files/download.ts';

// Task 6.3 (remediation-plan.md): FileExplorer download buttons. `write.ts`'s
// single-file mode names its output `'data'` (extension-less — see
// `assembleFiles`, `files.push({ name: 'data', ... })`); we append `.bin` at
// download time only, without mutating the VirtualFile itself.
describe('normalizeDownloadFilename', () => {
  it('appends .bin to an extension-less name (single-file write mode)', () => {
    expect(normalizeDownloadFilename('data')).toBe('data.bin');
  });

  it('leaves a name with an existing extension untouched', () => {
    expect(normalizeDownloadFilename('metadata.json')).toBe('metadata.json');
  });

  it('leaves per-chunk names with dots untouched', () => {
    expect(normalizeDownloadFilename('chunk.0.0')).toBe('chunk.0.0');
  });

  it('does not append .bin to names with no dot but treats them literally otherwise', () => {
    expect(normalizeDownloadFilename('chunk_0_0')).toBe('chunk_0_0.bin');
  });

  it('trims surrounding whitespace before checking for a dot', () => {
    expect(normalizeDownloadFilename('  data  ')).toBe('data.bin');
  });

  it('falls back to a sensible default for an empty name', () => {
    expect(normalizeDownloadFilename('')).toBe('data.bin');
    expect(normalizeDownloadFilename('   ')).toBe('data.bin');
  });
});
