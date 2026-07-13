import type { ValueArray } from './layout.ts';

/**
 * Fill a schema-shaped output from a curated source array by tiling/cropping.
 *
 * Trailing dimensions align: schema dim `shape.length-1-k` maps to source dim
 * `naturalShape.length-1-k`. Unmatched leading schema dims broadcast (repeat
 * the whole source block); unmatched leading source dims are fixed at index 0
 * (i.e. only the first "slice" along those dims is used — this is what makes
 * "fewer schema dims" a crop down to row/slice 0, not an average or sample).
 * Dims present in both align via modulo: `coord % naturalShape[sd]`, which
 * tiles when the schema dim is larger than the source dim and crops when
 * it's smaller (or equal, in which case modulo is a no-op).
 *
 * Output kind mirrors the source: Float64Array in, Float64Array out;
 * string/LogicalValue array in, plain array out. Inner loop is
 * allocation-free (no coord arrays) since this runs on up to 8M elements.
 */
export function fillFromSource(
  source: ValueArray,
  naturalShape: number[],
  shape: number[],
): ValueArray {
  const total = shape.reduce((a, b) => a * b, 1);
  const srcTotal = naturalShape.reduce((a, b) => a * b, 1);
  if (srcTotal !== source.length) {
    throw new Error(
      `fillFromSource: source length ${source.length} != natural shape product ${srcTotal}`,
    );
  }

  const isText = Array.isArray(source);
  const out: ValueArray = isText ? new Array(total) : new Float64Array(total);
  if (total === 0 || srcTotal === 0) return out;

  const sStrides = strides(naturalShape);

  for (let flat = 0; flat < total; flat++) {
    let rem = flat;
    let srcIndex = 0;
    for (let d = shape.length - 1, k = 0; d >= 0; d--, k++) {
      const dim = shape[d];
      const coord = rem % dim;
      rem = (rem - coord) / dim;
      const sd = naturalShape.length - 1 - k;
      if (sd >= 0) srcIndex += (coord % naturalShape[sd]) * sStrides[sd];
      // sd < 0: unmatched leading schema dim — broadcast, contributes nothing
    }
    if (isText) {
      (out as (string | number)[])[flat] = (source as (string | number)[])[srcIndex];
    } else {
      (out as Float64Array)[flat] = (source as Float64Array)[srcIndex];
    }
  }
  return out;
}

function strides(shape: number[]): number[] {
  const s = new Array<number>(shape.length);
  let acc = 1;
  for (let d = shape.length - 1; d >= 0; d--) {
    s[d] = acc;
    acc *= shape[d];
  }
  return s;
}
