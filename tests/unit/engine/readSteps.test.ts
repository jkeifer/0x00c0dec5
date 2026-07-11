/**
 * Read plan Task 2: readFile narrates an 8-step log (READ_STEP_ORDER),
 * attached to both success and failure results, with the existing failure
 * taxonomy mapped onto steps.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from '../../../src/engine/read.ts';
import { computePipelineStages } from '../../../src/hooks/usePipeline.ts';
import { DEFAULT_STATE, type AppState, type Variable } from '../../../src/types/state.ts';
import { hexToBytes } from '../../../src/engine/bytes.ts';
import type { ReadStepId } from '../../../src/types/pipeline.ts';

const READ_STEP_ID_ORDER: ReadStepId[] = [
  'verify-magic',
  'locate-metadata',
  'parse-metadata',
  'read-schema',
  'read-layout',
  'locate-chunks',
  'decode-chunks',
  'reassemble',
];

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...DEFAULT_STATE, ...overrides };
}

function uintVar(name: string): Variable {
  return {
    id: name,
    name,
    color: '#98c379',
    logicalType: { type: 'integer', min: 0, max: 100, generation: 'random' },
    typeAssignment: { storageDtype: 'uint16' },
  };
}

describe('readFile — step log (read plan Task 2)', () => {
  it('success: all 8 steps ok, in READ_STEP_ORDER order', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(true);
    expect(result.steps.length).toBe(8);
    expect(result.steps.map((s) => s.id)).toEqual(READ_STEP_ID_ORDER);
    for (const step of result.steps) {
      expect(step.outcome).toBe('ok');
    }
  });

  it('bad-magic: steps[0] failed with detail === result.message, steps[1..7] skipped', () => {
    const state = stateWith({});
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes('deadbeef') });

    expect(result.success).toBe(false);
    expect(result.steps.length).toBe(8);
    if (!result.success) {
      expect(result.steps[0]).toMatchObject({ id: 'verify-magic', outcome: 'failed' });
      expect(result.steps[0].detail).toBe(result.message);
      for (let i = 1; i < 8; i++) {
        expect(result.steps[i].outcome).toBe('skipped');
        expect(result.steps[i].id).toBe(READ_STEP_ID_ORDER[i]);
      }
    }
  });

  it('no-metadata: verify-magic ok, locate-metadata failed, rest skipped', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: false },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('no-metadata');
      expect(result.steps[0]).toMatchObject({ id: 'verify-magic', outcome: 'ok' });
      expect(result.steps[1]).toMatchObject({ id: 'locate-metadata', outcome: 'failed' });
      expect(result.steps[1].detail).toBe(result.message);
      for (let i = 2; i < 8; i++) {
        expect(result.steps[i].outcome).toBe('skipped');
      }
    }
  });

  it('metadata-not-found (D1 footerLocator=none + binary + footer): locate-metadata failed', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'footer', footerLocator: 'none' },
      metadata: { ...DEFAULT_STATE.metadata, serialization: 'binary' },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('metadata-not-found');
      expect(result.steps[0]).toMatchObject({ id: 'verify-magic', outcome: 'ok' });
      expect(result.steps[1]).toMatchObject({ id: 'locate-metadata', outcome: 'failed' });
      expect(result.steps[1].detail).toBe(result.message);
      for (let i = 2; i < 8; i++) {
        expect(result.steps[i].outcome).toBe('skipped');
      }
    }
  });

  it('corrupt-metadata (header-embedded metadata\'s inner schema JSON mangled): locate-metadata ok, parse-metadata failed', () => {
    // Located entries stay intact (outer JSON parses, locator finds a
    // complete span) but the "schema" entry's *inner* JSON.parse fails —
    // genuinely "located but failed to parse", reaching parseStructure's
    // throw rather than locateMetadata's own sidecar catch. Mirrors
    // roundtrip.matrix.test.ts's "corrupting header-embedded metadata bytes"
    // case.
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    });
    const { files } = computePipelineStages(state);
    const magicBytes = hexToBytes(state.write.magicNumber);
    const corruptedFiles = files.map((f) => {
      if (f.name !== 'data') return f;
      const bytes = new Uint8Array(f.bytes);
      const text = new TextDecoder().decode(bytes);
      const marker = '\\",\\"dtype';
      const markerIdx = text.indexOf(marker);
      expect(markerIdx).toBeGreaterThan(0);
      const commaOffset = markerIdx + 2;
      bytes[commaOffset] = 'x'.charCodeAt(0);
      return { ...f, bytes };
    });
    const result = readFile(corruptedFiles, { magic: magicBytes });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('corrupt-metadata');
      expect(result.steps[0]).toMatchObject({ id: 'verify-magic', outcome: 'ok' });
      expect(result.steps[1]).toMatchObject({ id: 'locate-metadata', outcome: 'ok' });
      expect(result.steps[2]).toMatchObject({ id: 'parse-metadata', outcome: 'failed' });
      expect(result.steps[2].detail).toBe(result.message);
      for (let i = 3; i < 8; i++) {
        expect(result.steps[i].outcome).toBe('skipped');
      }
    }
  });

  it('no-chunk-index (D3: single file, entropy codec, chunkIndex off): fails at locate-chunks, priors ok', () => {
    const state = stateWith({
      shape: [4, 4],
      chunkShape: [2, 2],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [{ codec: 'rle', params: {} }] },
      metadata: { ...DEFAULT_STATE.metadata, include: { ...DEFAULT_STATE.metadata.include, chunkIndex: false } },
      write: { ...DEFAULT_STATE.write, includeMetadata: true },
    });
    const { files } = computePipelineStages(state);
    const result = readFile(files, { magic: hexToBytes(state.write.magicNumber) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('no-chunk-index');
      const ids = result.steps.map((s) => s.id);
      const locateChunksIdx = ids.indexOf('locate-chunks');
      expect(locateChunksIdx).toBeGreaterThan(-1);
      for (let i = 0; i < locateChunksIdx; i++) {
        expect(result.steps[i].outcome).toBe('ok');
      }
      expect(result.steps[locateChunksIdx].outcome).toBe('failed');
      expect(result.steps[locateChunksIdx].detail).toBe(result.message);
      for (let i = locateChunksIdx + 1; i < 8; i++) {
        expect(result.steps[i].outcome).toBe('skipped');
      }
    }
  });

  it('decode-error (corrupted chunk_index size): fails at decode-chunks or reassemble, priors ok', () => {
    const state = stateWith({
      shape: [4],
      chunkShape: [4],
      variables: [uintVar('humidity')],
      fieldPipelines: { humidity: [] },
      write: { ...DEFAULT_STATE.write, includeMetadata: true, metadataPlacement: 'header' },
    });
    const { files } = computePipelineStages(state);
    const magicBytes = hexToBytes(state.write.magicNumber);

    // Corrupt the header-embedded chunk_index's "size" to make it not a
    // whole multiple of the dtype size, so bytesToValues throws inside
    // codec reversal — a genuine decode-error (metadata found & parsed fine).
    // The header is pretty-printed JSON text, but the file also carries raw
    // binary chunk data after it — decode/re-encode the whole file as UTF-8
    // text would corrupt that binary tail (and the leading magic bytes), so
    // only the located digit byte(s) are patched in place on the raw array.
    const corruptedFiles = files.map((f) => {
      if (f.name !== 'data') return f;
      const bytes = new Uint8Array(f.bytes);
      const text = new TextDecoder().decode(bytes);
      // chunk_index value is a JSON-encoded array embedded as an escaped
      // string inside the outer pretty-printed JSON, e.g.
      // \"size\":8 — replace the digit(s) after \"size\": with an odd value.
      const marker = '\\"size\\":';
      const markerIdx = text.indexOf(marker);
      expect(markerIdx).toBeGreaterThan(0);
      const digitStart = markerIdx + marker.length;
      const digitsMatch = text.slice(digitStart).match(/^\d+/);
      expect(digitsMatch).not.toBeNull();
      // uint16 elements are 2 bytes each and this chunk's true size is a
      // single digit ("8", the whole 4-element chunk); overwrite that one
      // digit byte in place with '1' (ASCII 0x31) so the claimed size
      // becomes 1 byte — not a whole multiple of 2 — causing bytesToValues
      // to throw inside codec reversal.
      expect(digitsMatch![0].length).toBe(1);
      bytes[digitStart] = '1'.charCodeAt(0);
      return { ...f, bytes };
    });

    const result = readFile(corruptedFiles, { magic: magicBytes });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(['decode-chunks', 'reassemble']).toContain(
        result.steps.find((s) => s.outcome === 'failed')?.id,
      );
      const failedIdx = result.steps.findIndex((s) => s.outcome === 'failed');
      expect(failedIdx).toBeGreaterThan(-1);
      for (let i = 0; i < failedIdx; i++) {
        expect(result.steps[i].outcome).toBe('ok');
      }
      expect(result.steps[failedIdx].detail).toBe(result.message);
      for (let i = failedIdx + 1; i < 8; i++) {
        expect(result.steps[i].outcome).toBe('skipped');
      }
    }
  });

  it('both success AND failure results carry steps (type-level: no optionality)', () => {
    const state = stateWith({});
    const { files } = computePipelineStages(state);
    const successResult = readFile(files, { magic: hexToBytes(state.write.magicNumber) });
    const failureResult = readFile(files, { magic: hexToBytes('deadbeef') });

    // No `if (result.steps)` guard needed — steps is required on both variants.
    expect(Array.isArray(successResult.steps)).toBe(true);
    expect(Array.isArray(failureResult.steps)).toBe(true);
  });
});
