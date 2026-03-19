export interface ByteTrace {
  traceId: string;
  variableName: string;
  variableColor: string;
  coords: number[];
  displayValue: string;
  dtype: string;
  chunkId: string;
  byteInValue: number;
  byteCount: number;
}

export interface PipelineStage {
  name: string;
  bytes: Uint8Array;
  traces: ByteTrace[];
  stats: {
    byteCount: number;
    entropy: number;
  };
}

export interface Chunk {
  coords: number[];
  flatIndex: number;
  variables: ChunkVariable[];
}

export interface ChunkVariable {
  variableName: string;
  variableColor: string;
  dtype: string;
  values: number[];
  sourceCoords: number[][];
}

export interface LinearizedChunk {
  chunkId: string;
  coords: number[];
  bytes: Uint8Array;
  traces: ByteTrace[];
}

export interface EncodedChunk {
  chunkId: string;
  coords: number[];
  bytes: Uint8Array;
  traces: ByteTrace[];
}

export interface VirtualFile {
  name: string;
  bytes: Uint8Array;
  traces: ByteTrace[];
}
