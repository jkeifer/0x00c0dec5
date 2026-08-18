import { describe, it, expect } from 'vitest';
import { STEPS, BLOG_POSTS } from '../../../src/components/guide/steps.ts';

// Must stay in sync with Sidebar.tsx's SECTION_TESTIDS values.
const SIDEBAR_SLUGS = [
  'schema',
  'typing',
  'chunk',
  'interleave',
  'codecs',
  'metadata',
  'write',
  'read',
];

describe('guide steps', () => {
  it('has exactly 10 steps', () => {
    expect(STEPS).toHaveLength(10);
  });

  it('has unique ids', () => {
    const ids = STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses only known sidebar slugs (or null) for section', () => {
    for (const step of STEPS) {
      if (step.section !== null) {
        expect(SIDEBAR_SLUGS, `step ${step.id}`).toContain(step.section);
      }
    }
  });

  it('has null sections only on intro and wrap-up', () => {
    const nullSteps = STEPS.filter((s) => s.section === null).map((s) => s.id);
    expect(nullSteps).toEqual(['intro', 'wrap-up']);
  });

  it('covers every sidebar section exactly once, in sidebar order', () => {
    const sections = STEPS.map((s) => s.section).filter((s) => s !== null);
    expect(sections).toEqual(SIDEBAR_SLUGS);
  });

  it('has nonempty title, decision, body, and tryIt on every step', () => {
    for (const step of STEPS) {
      expect(step.title.trim(), `step ${step.id} title`).not.toBe('');
      expect(step.decision.trim(), `step ${step.id} decision`).not.toBe('');
      expect(step.body.trim(), `step ${step.id} body`).not.toBe('');
      expect(step.tryIt.trim(), `step ${step.id} tryIt`).not.toBe('');
    }
  });

  it('gives every sectioned step at least one option with nonempty pros and cons', () => {
    for (const step of STEPS) {
      if (step.section === null) continue;
      expect(step.options.length, `step ${step.id} options`).toBeGreaterThan(0);
      for (const opt of step.options) {
        expect(opt.label.trim(), `step ${step.id} option label`).not.toBe('');
        expect(opt.pros.trim(), `step ${step.id} "${opt.label}" pros`).not.toBe('');
        expect(opt.cons.trim(), `step ${step.id} "${opt.label}" cons`).not.toBe('');
      }
    }
  });
});

describe('blog post links', () => {
  it('every BLOG_POSTS entry has an element84.com URL and a nonempty label', () => {
    expect(BLOG_POSTS.length).toBe(5);
    for (const post of BLOG_POSTS) {
      expect(post.label.trim(), `post ${post.url} label`).not.toBe('');
      expect(post.url, `post "${post.label}" url`).toMatch(/^https:\/\/element84\.com\//);
    }
  });

  it('intro step links to all five blog posts', () => {
    const step = STEPS.find((s) => s.id === 'intro')!;
    expect(step.links).toEqual(BLOG_POSTS);
  });

  it('chunk step links to both Chunks and Chunkability posts', () => {
    const step = STEPS.find((s) => s.id === 'chunk')!;
    const urls = (step.links ?? []).map((l) => l.url);
    expect(urls.filter((u) => u.includes('chunks-and-chunkability')).length).toBe(2);
    expect(step.links?.length).toBe(2);
  });

  it('codecs step links to the raster compression post', () => {
    const step = STEPS.find((s) => s.id === 'codecs')!;
    const urls = (step.links ?? []).map((l) => l.url);
    expect(urls).toContain(
      'https://element84.com/software-engineering/beyond-the-default-a-modern-guide-to-raster-compression/',
    );
  });

  it('metadata step links to the format metadata post', () => {
    const step = STEPS.find((s) => s.id === 'metadata')!;
    const urls = (step.links ?? []).map((l) => l.url);
    expect(urls).toContain(
      'https://element84.com/software-engineering/metadata-makes-the-data-format-metadata-storage-and-representation-across-array-formats/',
    );
  });
});
