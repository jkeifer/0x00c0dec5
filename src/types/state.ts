import type { DtypeKey } from './dtypes.ts';
import type { CodecStep } from './codecs.ts';
import type { StageName } from './pipeline.ts';

export type LogicalType = 'integer' | 'decimal' | 'continuous' | 'text';

/** Bundled word sets for text variables (see `engine/generate.ts`'s
 * `WORD_SETS`): sorted, ASCII-transliterated, internationally diverse. */
export type WordSetKey = 'names' | 'cities' | 'countries' | 'stations';

/**
 * D9 (remediation-plan.md, Phase 6.1): how raw values are generated before
 * logicalType rounding is applied. `generate.ts`'s `generateValues` reads
 * this to pick an algorithm; all four are deterministic from the existing
 * variable-name + global-seed scheme.
 * - 'random': current uniform behavior — incompressible by construction, the
 *   deliberate "why won't this compress?" contrast case.
 * - 'smooth': a bounded random walk — like a sensor reading drifting over time.
 * - 'sorted': monotonic non-decreasing — like timestamps or IDs.
 * - 'stepped': piecewise-constant with occasional jumps — like a control state.
 */
export type GenerationMode = 'random' | 'smooth' | 'sorted' | 'stepped';

export interface LogicalTypeConfig {
  type: LogicalType;
  min: number;
  max: number;
  decimalPlaces?: number;       // decimal only
  significantFigures?: number;  // continuous only
  /** text only: which bundled word set to draw values from. min/max are
   * ignored (kept 0/0) for text variables. */
  wordSet?: WordSetKey;
  /** D9: generation algorithm. Missing on migrated saves defaults to 'random'. */
  generation: GenerationMode;
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

/**
 * Read plan Task 1: which groups of auto-generated metadata get collected.
 * Each key maps to a specific reader-step failure when off — see
 * `METADATA_KEY_GROUPS` in `engine/metadata.ts`.
 */
export interface MetadataIncludeConfig {
  schema: boolean; // schema, type_assignments, logical_types
  layout: boolean; // shape, chunk_shape, chunk_grid, chunk_order, partitioning, interleaving
  codecs: boolean; // codec_pipelines
  chunkIndex: boolean; // chunk_index (absorbs legacy includeChunkIndex — D3 semantics unchanged)
  descriptive: boolean; // variable_statistics + ALL customEntries
}

export interface AppState {
  dataModel: 'tabular' | 'array';
  shape: number[];
  chunkShape: number[];
  interleaving: 'row' | 'column';
  variables: Variable[];
  /**
   * D5 (remediation-plan.md, Phase 3.1): keyed by Variable.id, not name — names
   * are mutable and non-unique, so keying by name silently clobbered pipelines
   * on rename/collision (SW-1). The file format itself still keys
   * `codec_pipelines` by variable NAME (see `engine/metadata.ts`); the
   * id -> name translation happens at metadata-collection time only.
   */
  fieldPipelines: Record<string, CodecStep[]>;
  chunkPipeline: CodecStep[];
  metadata: {
    customEntries: { key: string; value: string }[];
    serialization: 'json' | 'binary';
    /**
     * Read plan Task 1: five per-group metadata toggles, replacing the old
     * single all-or-nothing `includeChunkIndex` boolean. Each group maps to
     * a specific reader-step failure when off — see `METADATA_KEY_GROUPS` in
     * `engine/metadata.ts` for the key->group mapping. `chunkIndex` absorbs
     * the old `includeChunkIndex` field (D3 semantics unchanged: when false,
     * the reader must compute chunk offsets from chunkShape x dtype size,
     * possible only when every codec in play is size-preserving — see
     * `no-chunk-index` in `ReadFailureReason`). Legacy saves with
     * `includeChunkIndex` migrate via `migrateState` in `state/persistence.ts`.
     */
    include: MetadataIncludeConfig;
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
    leftPaneStage: StageName;
    rightPaneStage: StageName;
    leftPaneView: string;
    rightPaneView: string;
    showDiff: boolean;
  };
}

export const DEFAULT_VARIABLES: Variable[] = [
  {
    id: 'temperature', name: 'temperature', color: '#e06c75',
    logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'pressure', name: 'pressure', color: '#61afef',
    logicalType: { type: 'decimal', min: 900, max: 1100, decimalPlaces: 1, generation: 'sorted' },
    typeAssignment: { storageDtype: 'float32' },
  },
  {
    id: 'humidity', name: 'humidity', color: '#98c379',
    logicalType: { type: 'integer', min: 0, max: 100, generation: 'stepped' },
    typeAssignment: { storageDtype: 'uint16' },
  },
];

export const DEFAULT_STATE: AppState = {
  dataModel: 'tabular',
  shape: [32],
  chunkShape: [32],
  interleaving: 'column',
  variables: DEFAULT_VARIABLES,
  // Keyed by Variable.id (see AppState.fieldPipelines doc comment above). The
  // starter variables' ids happen to equal their names today, but that is
  // coincidence, not key semantics.
  fieldPipelines: {
    temperature: [],
    pressure: [],
    humidity: [],
  },
  chunkPipeline: [],
  metadata: {
    customEntries: [],
    serialization: 'json',
    include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true },
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
    // D5 (remediation-plan.md): defaults are stage NAMES, not indices — the
    // old `-1` sentinel for rightPaneStage is gone entirely (fixes SW-2).
    leftPaneStage: 'values',
    rightPaneStage: 'write',
    leftPaneView: 'table',
    rightPaneView: 'hex',
    showDiff: false,
  },
};

/**
 * A *blank* configuration for `dataModel` — zero variables, no field
 * pipelines — as opposed to DEFAULT_STATE's three starter variables. Used by
 * the Header's Clear button. `shape`/`chunkShape` deliberately keep the
 * defaults: persistence's `validateState` hard-resets the whole state on an
 * empty shape array, and the documented degenerate state (design.md Edge
 * Cases) is *zero variables*, not zero dimensions. A factory rather than a
 * constant because callers may mutate the returned state (mutable refs).
 */
export function makeEmptyState(dataModel: AppState['dataModel']): AppState {
  return {
    ...structuredClone(DEFAULT_STATE),
    dataModel,
    variables: [],
    fieldPipelines: {},
  };
}
