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
  description: string;
  params: Record<string, ParamDef>;
  applicableTo: (dtype: string) => boolean;
  /**
   * Task 2.6: whether encode→decode is lossy for a given *input* dtype.
   *
   * This deviates from docs/extension-read-step.md's `lossy: boolean` field.
   * A plain boolean cannot express delta's behavior: after task 2.5 removed
   * the clamp, delta's encode/decode is an exact modular round-trip for
   * integer dtypes (typed-array writes wrap mod 2^N), but is still lossy for
   * float dtypes (diffs are re-rounded to the float dtype's precision). A
   * predicate over the input dtype is the minimum shape that can express
   * "lossy for some dtypes, exact for others." See DC-2 in
   * docs/remediation-plan.md.
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
}
