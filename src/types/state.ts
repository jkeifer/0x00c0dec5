import type { DtypeKey } from './dtypes.ts';
import type { CodecStep } from './codecs.ts';

export interface Variable {
  id: string;
  name: string;
  dtype: DtypeKey;
  color: string;
}

export interface AppState {
  dataModel: 'tabular' | 'array';
  shape: number[];
  chunkShape: number[];
  interleaving: 'row' | 'column';
  variables: Variable[];
  fieldPipelines: Record<string, CodecStep[]>;
  chunkPipeline: CodecStep[];
  metadata: {
    customEntries: { key: string; value: string }[];
    serialization: 'json' | 'binary';
  };
  write: {
    magicNumber: string;
    partitioning: 'single' | 'per-chunk';
    metadataPlacement: 'header' | 'footer' | 'sidecar';
    chunkOrder: 'row-major' | 'column-major';
  };
  ui: {
    leftPaneStage: number;
    rightPaneStage: number;
    leftPaneView: string;
    rightPaneView: string;
    sidebarWidth: number;
    leftPaneRatio: number;
  };
}

export const DEFAULT_VARIABLES: Variable[] = [
  { id: 'temperature', name: 'temperature', dtype: 'float32', color: '#e06c75' },
  { id: 'pressure', name: 'pressure', dtype: 'float32', color: '#61afef' },
  { id: 'humidity', name: 'humidity', dtype: 'uint16', color: '#98c379' },
];

export const DEFAULT_STATE: AppState = {
  dataModel: 'tabular',
  shape: [32],
  chunkShape: [32],
  interleaving: 'column',
  variables: DEFAULT_VARIABLES,
  fieldPipelines: {
    temperature: [],
    pressure: [],
    humidity: [],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [],
    serialization: 'json',
  },
  write: {
    magicNumber: '00C0DEC5',
    partitioning: 'single',
    metadataPlacement: 'header',
    chunkOrder: 'row-major',
  },
  ui: {
    leftPaneStage: 0,
    rightPaneStage: -1,
    leftPaneView: 'table',
    rightPaneView: 'hex',
    sidebarWidth: 300,
    leftPaneRatio: 0.5,
  },
};
