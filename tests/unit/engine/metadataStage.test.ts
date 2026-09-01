import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';
import {
  computeValuesStage, computeTypedStage, computeLinearizedStage, computeEncodedStage,
  computeMetadataStage, computeFilesStage,
} from '../../../src/engine/pipelineCompute.ts';
import { deserializeMetadata, type ChunkIndexEntry } from '../../../src/engine/metadata.ts';
import { hexToBytes } from '../../../src/engine/bytes.ts';

const ALL_INCLUDE_ON = { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true };

function stateWith(overrides: Partial<AppState> = {}, include: Partial<AppState['metadata']['include']> = {}): AppState {
  return {
    ...DEFAULT_STATE,
    ...overrides,
    metadata: {
      ...DEFAULT_STATE.metadata,
      enabled: true,
      include: { ...ALL_INCLUDE_ON, ...include },
    },
  };
}

/** Build encodedChunks + variableStats + encoded layout from a state, the same
 * way the worker pipeline does (mirrors metadataGroups.test.ts's collectFor). */
function pipelineFor(state: AppState) {
  const values = computeValuesStage(state.shape, state.variables);
  const typed = computeTypedStage(state.shape, state.variables, values.variableValues);
  const linearized = computeLinearizedStage(
    state.shape, state.chunkShape, state.interleaving, state.variables, typed.typedVariableValues,
  );
  const encoded = computeEncodedStage(
    linearized.chunks, linearized.linearizedChunks, state.interleaving,
    state.variables, state.fieldPipelines, state.chunkPipeline, linearized.stage.layout,
  );
  return { typed, encoded };
}

function metadataStageEntries(state: AppState) {
  const { typed, encoded } = pipelineFor(state);
  return computeMetadataStage(state, encoded.encodedChunks, typed.variableStats).entries;
}

function metadataStageBytes(state: AppState) {
  const { typed, encoded } = pipelineFor(state);
  return computeMetadataStage(state, encoded.encodedChunks, typed.variableStats).stage.bytes;
}

function filesFor(state: AppState) {
  const { typed, encoded } = pipelineFor(state);
  return computeFilesStage(state, encoded.encodedChunks, typed.variableStats, encoded.stage.layout).files;
}

/** Parse the chunk_index array out of a serialized metadata blob, or null. */
function chunkIndexFromBytes(bytes: Uint8Array): ChunkIndexEntry[] | null {
  if (bytes.length === 0) return null;
  const entry = deserializeMetadata(bytes).find((e) => e.key === 'chunk_index');
  if (!entry) return null;
  return JSON.parse(entry.value) as ChunkIndexEntry[];
}

describe('computeMetadataStage — stage/file convergence', () => {
  it('stage includes chunk_index when the toggle is on', () => {
    const entries = metadataStageEntries(stateWith());
    expect(entries.map((e) => e.key)).toContain('chunk_index');
  });

  it('stage omits chunk_index when the toggle is off', () => {
    const entries = metadataStageEntries(stateWith({}, { chunkIndex: false }));
    expect(entries.map((e) => e.key)).not.toContain('chunk_index');
  });

  it('sidecar placement: stage bytes are byte-identical to the sidecar file', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'sidecar' },
    });
    const stageBytes = metadataStageBytes(state);
    const files = filesFor(state);
    const sidecar = files.find((f) => f.name === 'metadata');
    expect(sidecar).toBeDefined();
    expect(Array.from(sidecar!.bytes)).toEqual(Array.from(stageBytes));
  });

  it('sidecar: stage chunk_index offsets/sizes match the written file exactly', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'sidecar' },
    });
    const stageIndex = chunkIndexFromBytes(metadataStageBytes(state));
    const sidecar = filesFor(state).find((f) => f.name === 'metadata')!;
    const fileIndex = chunkIndexFromBytes(sidecar.bytes);
    expect(stageIndex).not.toBeNull();
    expect(stageIndex).toEqual(fileIndex);
  });

  it('header placement: the stage bytes appear verbatim inside the data file', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' },
    });
    const stageBytes = metadataStageBytes(state);
    const dataFile = filesFor(state).find((f) => f.name === 'data')!;
    expect(indexOfSubarray(dataFile.bytes, stageBytes)).toBeGreaterThanOrEqual(0);
  });

  it('header: stage chunk_index first offset points past magic + header (data start)', () => {
    const state = stateWith({
      write: { ...DEFAULT_STATE.write, metadataPlacement: 'header' },
    });
    const stageBytes = metadataStageBytes(state);
    const stageIndex = chunkIndexFromBytes(stageBytes);
    expect(stageIndex).not.toBeNull();
    const magicLen = state.write.magicNumber ? hexToBytes(state.write.magicNumber).length : 0;
    // The header IS the stage bytes, so data starts right after magic + header.
    expect(stageIndex![0].offset).toBe(magicLen + stageBytes.length);
  });
});

function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
