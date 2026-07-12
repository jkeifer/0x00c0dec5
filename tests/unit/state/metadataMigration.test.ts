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
  it('legacy includeChunkIndex: false -> include.chunkIndex false, all other groups true', () => {
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
      endianness: true,
    });
    expect('includeChunkIndex' in result!.metadata).toBe(false);
  });

  it('legacy includeChunkIndex: true -> include.chunkIndex true, all other groups true', () => {
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
      endianness: true,
    });
  });

  it('includeChunkIndex absent entirely -> all five groups default true', () => {
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
      endianness: true,
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

  it('pre-cl-8 five-group include (endianness absent) -> backfills endianness: true', () => {
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
      endianness: true,
    });
  });
});
