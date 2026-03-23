import type { ByteTrace } from '../types/pipeline.ts';
import { getDtype } from '../types/dtypes.ts';
import type { DtypeKey } from '../types/dtypes.ts';

/**
 * Propagate traces through a value-preserving codec (mapping or reordering).
 * Same-size dtypes: 1:1 trace copy with updated dtype.
 * Different-size dtypes: recompute byteInValue/byteCount per new dtype size.
 */
export function propagateTracesValuePreserving(
  inputTraces: ByteTrace[],
  inputDtype: DtypeKey,
  outputDtype: DtypeKey,
): ByteTrace[] {
  const inputSize = getDtype(inputDtype).size;
  const outputSize = getDtype(outputDtype).size;

  if (inputSize === outputSize) {
    return inputTraces.map((t) => ({ ...t, dtype: outputDtype }));
  }

  // Different sizes: group by traceId, then re-expand
  const outputTraces: ByteTrace[] = [];
  let i = 0;
  while (i < inputTraces.length) {
    const trace = inputTraces[i];
    // Skip over all bytes of the current value in the input
    const inputValueByteCount = trace.byteCount;
    for (let b = 0; b < outputSize; b++) {
      outputTraces.push({
        ...trace,
        dtype: outputDtype,
        byteInValue: b,
        byteCount: outputSize,
      });
    }
    i += inputValueByteCount;
  }

  return outputTraces;
}

/**
 * Degrade traces to chunk-level after entropy coding.
 * All output traces get traceId = chunkId from the input traces.
 * When all input traces share the same variableName (per-variable chunks),
 * preserve variableName and variableColor in the output.
 */
export function degradeTracesToChunkLevel(
  inputTraces: ByteTrace[],
  outputByteCount: number,
): ByteTrace[] {
  if (inputTraces.length === 0 || outputByteCount === 0) {
    return [];
  }

  const sample = inputTraces[0];
  const chunkTraceId = sample.chunkId;

  // Check if all traces share the same variable (true for per-variable chunks)
  const sharedVariable = sample.variableName !== '' &&
    inputTraces.every((t) => t.variableName === sample.variableName);

  return Array.from({ length: outputByteCount }, () => ({
    traceId: chunkTraceId,
    variableName: sharedVariable ? sample.variableName : '',
    variableColor: sharedVariable ? sample.variableColor : '',
    coords: [],
    displayValue: '',
    dtype: 'uint8',
    chunkId: sample.chunkId,
    byteInValue: 0,
    byteCount: 1,
  }));
}

/** Check if a traceId indicates chunk-level (degraded) tracing. */
export function isChunkLevelTrace(traceId: string): boolean {
  return traceId.startsWith('chunk:');
}
