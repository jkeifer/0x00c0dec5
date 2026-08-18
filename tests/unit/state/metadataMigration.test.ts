import { describe, it, expect } from 'vitest';
import { validateExternalState } from '../../../src/state/persistence.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';

/**
 * D3->five-group migration (read plan Task 1): the legacy
 * `metadata.includeChunkIndex` boolean is replaced by `metadata.include`,
 * a five-key config. `migrateState` synthesizes `include` from a legacy
 * save, honoring `includeChunkIndex` for the `chunkIndex` key and defaulting
 * every other key to true; the default-merge pass then fills in anything
 * still missing. Modern-shape saves round-trip unchanged.
 */
describe('metadata.include migration', () => {
  // Metadata redesign Task 1: DEFAULT_STATE.metadata.include.endianness now
  // defaults false (was true). The legacy synthesis path in migrateState only
  // ever fills 5 of the 6 keys (schema/layout/codecs/chunkIndex/descriptive);
  // `endianness` is deliberately left for the post-migration default-merge
  // pass to fill from DEFAULT_STATE — so it now comes back false here too.
  it('legacy includeChunkIndex: false -> include.chunkIndex false, all other groups true, endianness defaults false', () => {
    const raw = JSON.parse(JSON.stringify(DEFAULT_STATE));
    delete raw.metadata.include;
    raw.metadata.includeChunkIndex = false;

    const result = validateExternalState(raw, 'tabular');
    expect(result).not.toBeNull();
    expect(result!.metadata.include).toEqual({
      schema: true,
      layout: true,
      codecs: true,
      chunkIndex: false,
      descriptive: true,
      endianness: false,
    });
    expect('includeChunkIndex' in result!.metadata).toBe(false);
  });

  it('legacy includeChunkIndex: true -> include.chunkIndex true, all other groups true, endianness defaults false', () => {
    const raw = JSON.parse(JSON.stringify(DEFAULT_STATE));
    delete raw.metadata.include;
    raw.metadata.includeChunkIndex = true;

    const result = validateExternalState(raw, 'tabular');
    expect(result).not.toBeNull();
    expect(result!.metadata.include).toEqual({
      schema: true,
      layout: true,
      codecs: true,
      chunkIndex: true,
      descriptive: true,
      endianness: false,
    });
  });

  it('includeChunkIndex absent entirely -> all five legacy groups default true, endianness defaults false', () => {
    const raw = JSON.parse(JSON.stringify(DEFAULT_STATE));
    delete raw.metadata.include;
    delete raw.metadata.includeChunkIndex;

    const result = validateExternalState(raw, 'tabular');
    expect(result).not.toBeNull();
    expect(result!.metadata.include).toEqual({
      schema: true,
      layout: true,
      codecs: true,
      chunkIndex: true,
      descriptive: true,
      endianness: false,
    });
  });

  it('modern shape (metadata.include already present) round-trips unchanged', () => {
    const raw = JSON.parse(JSON.stringify(DEFAULT_STATE));
    raw.metadata.include = {
      schema: false,
      layout: true,
      codecs: false,
      chunkIndex: true,
      descriptive: false,
      endianness: true,
    };

    const result = validateExternalState(raw, 'tabular');
    expect(result).not.toBeNull();
    expect(result!.metadata.include).toEqual({
      schema: false,
      layout: true,
      codecs: false,
      chunkIndex: true,
      descriptive: false,
      endianness: true,
    });
  });

  // Metadata redesign Task 1: this save already carries a modern 5-key
  // `include` object (migrateState's legacy-synthesis branch doesn't run),
  // so the missing `endianness` key is filled by the post-migration
  // default-merge pass from DEFAULT_STATE.metadata.include.endianness, which
  // now defaults false (was true).
  it('pre-cl-8 five-group include (endianness absent) -> backfills endianness: false', () => {
    const raw = JSON.parse(JSON.stringify(DEFAULT_STATE));
    raw.metadata.include = {
      schema: true,
      layout: false,
      codecs: true,
      chunkIndex: false,
      descriptive: true,
      // no endianness key — a save from before the cl-8 group existed
    };

    const result = validateExternalState(raw, 'tabular');
    expect(result).not.toBeNull();
    expect(result!.metadata.include).toEqual({
      schema: true,
      layout: false,
      codecs: true,
      chunkIndex: false,
      descriptive: true,
      endianness: false,
    });
  });
});
