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
  category: 'mapping' | 'reordering' | 'entropy';
  description: string;
  params: Record<string, ParamDef>;
  applicableTo: (dtype: string) => boolean;
  encode: (
    bytes: Uint8Array,
    inputDtype: string,
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
