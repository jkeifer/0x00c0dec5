import type { DtypeKey } from './dtypes.ts';
import type { CodecStep } from './codecs.ts';

export type LogicalType = 'integer' | 'decimal' | 'continuous';

export interface LogicalTypeConfig {
  type: LogicalType;
  min: number;
  max: number;
  decimalPlaces?: number;       // decimal only
  significantFigures?: number;  // continuous only
}

export interface TypeAssignment {
  storageDtype: DtypeKey;
  scale?: number;    // for integer storage of decimal/continuous
  offset?: number;   // for integer storage of decimal/continuous
  keepBits?: number; // for float precision reduction
}

export interface Variable {
  id: string;
  name: string;
  logicalType: LogicalTypeConfig;
  typeAssignment: TypeAssignment;
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
    /**
     * D3 (remediation-plan.md): whether `chunk_index` (coords/offset/size per
     * chunk) is included in collected metadata. Default true. When false, the
     * reader must compute chunk offsets from chunkShape x dtype size, which is
     * only possible when every codec in play is size-preserving — see
     * `no-chunk-index` in `ReadFailureReason`.
     */
    includeChunkIndex: boolean;
  };
  write: {
    includeMetadata: boolean;
    magicNumber: string;
    partitioning: 'single' | 'per-chunk';
    metadataPlacement: 'header' | 'footer' | 'sidecar';
    chunkOrder: 'row-major' | 'column-major';
    /**
     * D1 (remediation-plan.md): how a reader locates footer-placed metadata
     * when there's no separate index to consult. Only meaningful when
     * `metadataPlacement === 'footer'`.
     * - 'trailer': [magic][chunks][metadata][u32 LE metadata-length][magic] —
     *   Parquet-style; the reader seeks to the end and reads the length.
     * - 'none': layout stays [magic][chunks][metadata][magic]; the reader
     *   falls back to a best-effort backward scan, which may fail.
     */
    footerLocator: 'trailer' | 'none';
  };
  ui: {
    leftPaneStage: number;
    rightPaneStage: number;
    leftPaneView: string;
    rightPaneView: string;
    sidebarWidth: number;
    leftPaneRatio: number;
    showDiff: boolean;
  };
}

export const DEFAULT_VARIABLES: Variable[] = [
  {
    id: 'temperature', name: 'temperature', color: '#e06c75',
    logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'pressure', name: 'pressure', color: '#61afef',
    logicalType: { type: 'decimal', min: 900, max: 1100, decimalPlaces: 1 },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'humidity', name: 'humidity', color: '#98c379',
    logicalType: { type: 'integer', min: 0, max: 100 },
    typeAssignment: { storageDtype: 'uint16' },
  },
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
    includeChunkIndex: true,
  },
  write: {
    includeMetadata: false,
    magicNumber: '00C0DEC5',
    partitioning: 'single',
    metadataPlacement: 'header',
    chunkOrder: 'row-major',
    footerLocator: 'trailer',
  },
  ui: {
    leftPaneStage: 0,
    rightPaneStage: -1,
    leftPaneView: 'table',
    rightPaneView: 'hex',
    sidebarWidth: 300,
    leftPaneRatio: 0.5,
    showDiff: false,
  },
};
