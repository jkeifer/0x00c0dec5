import { describe, it, expect } from 'vitest';
import { hoverHighlightFor, type HoverLocalTrace } from '../../../src/components/viewers/hoverHighlight.ts';

const chunkShape = [2, 2];

function local(overrides: Partial<HoverLocalTrace> = {}): HoverLocalTrace {
  return {
    traceId: 'temperature:0,0',
    chunkId: 'chunk:0,0',
    coords: [0, 0],
    variableName: 'temperature',
    ...overrides,
  };
}

describe('hoverHighlightFor', () => {
  it('value hover: exact traceId match -> value', () => {
    const l = local();
    const result = hoverHighlightFor(l, { traceId: 'temperature:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBe('value');
  });

  it('value hover: chunk sibling with per-value local trace -> chunk (weak wash shows chunk membership)', () => {
    // hovering temperature:0,0; this element is temperature:0,1, same chunk
    // -> weak chunk wash. Deliberate: the wash teaches which values travel
    // together; the accent-tinted --hover-strong keeps the hovered value
    // itself distinguishable within it.
    const l = local({ traceId: 'temperature:0,1', coords: [0, 1] });
    const result = hoverHighlightFor(l, { traceId: 'temperature:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBe('chunk');
  });

  it('value hover: per-value local in a DIFFERENT chunk -> null', () => {
    const l = local({ traceId: 'temperature:2,2', coords: [2, 2] });
    const result = hoverHighlightFor(l, { traceId: 'temperature:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBeNull();
  });

  it('value hover: local trace is itself chunk-level (post-entropy) and in same chunk -> chunk (degradation)', () => {
    const l: HoverLocalTrace = { traceId: 'chunk:0,0', chunkId: 'chunk:0,0', coords: [], variableName: '' };
    const result = hoverHighlightFor(l, { traceId: 'temperature:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBe('chunk');
  });

  it('value hover: local trace is chunk-level but different chunk -> null', () => {
    const l: HoverLocalTrace = { traceId: 'chunk:1,1', chunkId: 'chunk:1,1', coords: [], variableName: '' };
    const result = hoverHighlightFor(l, { traceId: 'temperature:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBeNull();
  });

  it('chunk hover: per-value member via elementInChunk -> chunk', () => {
    const l = local({ traceId: 'temperature:1,1', coords: [1, 1] });
    const result = hoverHighlightFor(l, { traceId: 'chunk:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBe('chunk');
  });

  it('chunk hover: non-member -> null', () => {
    const l = local({ traceId: 'temperature:2,2', coords: [2, 2] });
    const result = hoverHighlightFor(l, { traceId: 'chunk:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBeNull();
  });

  it('chunk hover: exact traceId match on the chunk-level element itself -> value', () => {
    const l: HoverLocalTrace = { traceId: 'chunk:0,0', chunkId: 'chunk:0,0', coords: [], variableName: '' };
    const result = hoverHighlightFor(l, { traceId: 'chunk:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBe('value');
  });

  it('no hover state -> null', () => {
    const l = local();
    const result = hoverHighlightFor(l, { traceId: null, chunkId: null }, chunkShape);
    expect(result).toBeNull();
  });

  it('structural local trace (empty chunkId) never chunk-highlights', () => {
    const l: HoverLocalTrace = { traceId: 'magic:start', chunkId: '', coords: [], variableName: '' };
    const result = hoverHighlightFor(l, { traceId: 'chunk:0,0', chunkId: 'chunk:0,0' }, chunkShape);
    expect(result).toBeNull();
  });
});
