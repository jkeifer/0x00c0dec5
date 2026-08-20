import type { DtypeKey } from './dtypes.ts';

export interface ParamDef {
  label: string;
  type: 'number' | 'select';
  default: number | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export interface CodecDefinition {
  key: string;
  label: string;
  category: 'transform' | 'reordering' | 'entropy';
  /** How this codec changes the encoded byte count:
   *  - 'preserving': output length === input length (delta, zigzag, shuffles)
   *  - 'fixed-ratio': length changes deterministically via element widths
   *    (scale-offset float32→int16 = 1/2) — offsets stay computable from
   *    geometry + codec metadata, so no chunk index is demanded
   *  - 'variable': data-dependent (every entropy codec) */
  sizeEffect: 'preserving' | 'fixed-ratio' | 'variable';
  /** Human-readable input expectation, surfaced by stepWarnings when
   *  applicableTo fails. Advisory only — never blocks. */
  expects?: string;
  /** Declared (possibly param-dependent) output dtype. Absent = the default
   *  rule in outputDtypeFor (entropy/traceMode → uint8, else input). */
  outputDtype?: (inputDtype: DtypeKey, params: Record<string, number | string>) => DtypeKey;
  /** Present on codecs backed by an external runtime. 'pyodide' entries are
   *  the real numcodecs codecs: the picker disables them until the runtime
   *  loads, and the worker awaits runtime init before computes that use one
   *  (see stateUsesPyodideCodec). Absent = educational codec, always available. */
  runtime?: 'pyodide';
  /**
   * How far this codec degrades byte tracing (CLAUDE.md pitfall 1). Absent =
   * the codec leaves every byte at its element's position, so per-value
   * tracing survives intact (delta, zigzag — they rewrite values in place).
   *
   *  - 'positional': the codec permutes bytes *within* the chunk, so byte
   *    offset N no longer holds element N's data. The Encoded stage still
   *    shows one row/highlight per fixed-width slot — that's what a reader
   *    ignoring the codec would see, garbage values and all — but the slot no
   *    longer identifies a real element, so its trace deliberately does not
   *    cross-match other panes (they fall back to the chunk wash). Byte
   *    Shuffle.
   *  - 'chunk-level': no byte carries per-element meaning at all. Bit Shuffle
   *    (bits, not bytes, are permuted — a single output byte mixes bits from
   *    up to 8 different elements).
   *
   * Entropy codecs are always 'chunk-level' regardless of this field; the
   * degradation is monotone, so a pipeline takes the worst mode any step
   * declares (see encodedChunkMeta in engine/layout.ts).
   */
  traceMode?: 'positional' | 'chunk-level';
  description: string;
  params: Record<string, ParamDef>;
  applicableTo: (dtype: string) => boolean;
  /**
   * Task 2.6: whether encode→decode is lossy for a given *input* dtype.
   *
   * `() => false` on every reordering/entropy codec (delta is plain integer
   * arithmetic — it differences bit patterns instead, exactly and uselessly).
   * The transform codecs (quantize, bitround, scale-offset) are the
   * dtype-independent `() => true` cases — since the codec-unification
   * typeAssignment shrink, they're the *only* place lossiness like this lives;
   * `Variable.typeAssignment` is a plain storage-dtype cast now, with its own
   * separate clip/round stats. `isPipelineLossy` (engine/read.ts) asks this.
   */
  isLossy: (inputDtype: DtypeKey) => boolean;
  encode: (
    bytes: Uint8Array,
    inputDtype: string,
    params: Record<string, number | string>,
    byteOrder?: 'little' | 'big',
  ) => {
    bytes: Uint8Array;
    outputDtype: string;
    stats?: { clipped: number; rounded: number };
  };
  decode: (
    bytes: Uint8Array,
    encodedDtype: string,
    params: Record<string, number | string>,
    byteOrder?: 'little' | 'big',
  ) => {
    bytes: Uint8Array;
    outputDtype: string;
  };
}

export interface CodecStep {
  codec: string;
  params: Record<string, number | string>;
  /**
   * F31: per-step demo toggle. **Absent = enabled** (zero migration — every
   * existing save/preset/share-link is unchanged). A disabled step is kept in
   * state with its params intact but is filtered out at every pipeline
   * consumption boundary via `activeSteps` (engine/codecs.ts), so it never
   * encodes, never reaches the written metadata, and never affects the
   * dtype-flow of later steps.
   */
  enabled?: boolean;
}
