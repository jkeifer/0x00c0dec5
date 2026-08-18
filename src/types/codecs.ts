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
  category: 'reordering' | 'entropy';
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
   * Currently `() => false` on every codec — the one dtype-dependent case was
   * delta on floats, and delta is now plain integer arithmetic (it differences
   * bit patterns instead, exactly and uselessly). Lossiness in this tool lives
   * entirely on `Variable.typeAssignment` (scale/offset, bit-rounding), which
   * is a separate mechanism with its own stats. Kept only because
   * `isPipelineLossy` (engine/read.ts) still asks.
   */
  isLossy: (inputDtype: DtypeKey) => boolean;
  encode: (
    bytes: Uint8Array,
    inputDtype: string,
    params: Record<string, number | string>,
  ) => {
    bytes: Uint8Array;
    outputDtype: string;
  };
  decode: (
    bytes: Uint8Array,
    encodedDtype: string,
    params: Record<string, number | string>,
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
