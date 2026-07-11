// @vitest-environment jsdom
//
// Task 6.5 (remediation-plan.md, Phase 6): shareable state URLs.
// `location.hash`/`history.replaceState` need jsdom (same pragma used
// elsewhere for renderHook-through-AppStateProvider tests); this file needs
// it directly since it manipulates the URL itself.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  encodeShareState,
  decodeShareState,
  buildShareUrl,
  consumeShareHash,
  SHARE_HASH_PREFIX,
} from '../../../src/state/share.ts';
import { AppStateProvider, useAppState } from '../../../src/state/useAppState.ts';
import { DEFAULT_STATE } from '../../../src/types/state.ts';
import type { AppState } from '../../../src/types/state.ts';

/** Minimal Map-backed localStorage mock (same pattern used throughout
 * src/__tests__/state). */
class MockStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  globalThis.localStorage = new MockStorage() as unknown as Storage;
  window.location.hash = '';
});

// ─── encode/decode round-trip ─────────────────────────────────────────────

describe('encodeShareState / decodeShareState', () => {
  it('round-trips the default state deep-equal', () => {
    const encoded = encodeShareState(DEFAULT_STATE);
    const decoded = decodeShareState(encoded);
    expect(decoded).toEqual(DEFAULT_STATE);
  });

  it('round-trips a mutated state (shape, custom entries, unicode) deep-equal', () => {
    const state: AppState = {
      ...DEFAULT_STATE,
      shape: [48],
      metadata: {
        ...DEFAULT_STATE.metadata,
        customEntries: [{ key: 'crs', value: 'EPSG:4326 — épreuve 日本語' }],
      },
    };
    const encoded = encodeShareState(state);
    const decoded = decodeShareState(encoded);
    expect(decoded).toEqual(state);
  });

  it('produces a base64url string (no +, /, or = padding)', () => {
    const encoded = encodeShareState(DEFAULT_STATE);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('decodeShareState returns null for corrupt/truncated input without throwing', () => {
    expect(() => decodeShareState('!!!not-base64!!!')).not.toThrow();
    expect(decodeShareState('!!!not-base64!!!')).toBeNull();

    const encoded = encodeShareState(DEFAULT_STATE);
    const truncated = encoded.slice(0, Math.floor(encoded.length / 2));
    expect(() => decodeShareState(truncated)).not.toThrow();
    // Truncated base64url may or may not throw during decode depending on
    // where the cut lands, but it must never produce a valid AppState back
    // (JSON.parse should fail on the truncated payload).
    expect(decodeShareState(truncated)).toBeNull();
  });

  it('decodeShareState returns null for valid base64 that is not JSON', () => {
    const notJson = btoa('this is not json').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeShareState(notJson)).toBeNull();
  });
});

// ─── buildShareUrl ────────────────────────────────────────────────────────

describe('buildShareUrl', () => {
  it('builds origin + pathname + #s=<encoded>, stripping any existing hash/search', () => {
    const url = buildShareUrl(DEFAULT_STATE);
    expect(url.startsWith(`${location.origin}${location.pathname}${SHARE_HASH_PREFIX}`)).toBe(true);
    const encoded = url.slice(`${location.origin}${location.pathname}${SHARE_HASH_PREFIX}`.length);
    expect(decodeShareState(encoded)).toEqual(DEFAULT_STATE);
  });

  it('the encoded default-state URL is a reasonable size (well under typical URL limits)', () => {
    const url = buildShareUrl(DEFAULT_STATE);
    // Informational/regression guard, not a hard spec: a few KB is expected
    // per the task description; fail loudly if it balloons unexpectedly.
    expect(url.length).toBeLessThan(4000);
  });
});

// ─── consumeShareHash (boot-time decode) ──────────────────────────────────

describe('consumeShareHash', () => {
  it('returns null and leaves history alone when there is no #s= hash', () => {
    window.location.hash = '';
    expect(consumeShareHash()).toBeNull();
  });

  it('decodes a valid #s= hash and strips it via history.replaceState', () => {
    const encoded = encodeShareState({ ...DEFAULT_STATE, shape: [48] });
    window.location.hash = `${SHARE_HASH_PREFIX}${encoded}`;
    expect(location.hash).toContain('s=');

    const decoded = consumeShareHash();
    expect(decoded).not.toBeNull();
    expect(decoded!.shape).toEqual([48]);
    expect(location.hash).toBe('');
  });

  it('falls through safely on a corrupt/truncated hash, and still strips it', () => {
    window.location.hash = `${SHARE_HASH_PREFIX}!!!not-valid!!!`;
    const decoded = consumeShareHash();
    expect(decoded).toBeNull();
    expect(location.hash).toBe('');
  });

  it('ignores hashes that do not start with the share prefix', () => {
    window.location.hash = '#somethingelse';
    const decoded = consumeShareHash();
    expect(decoded).toBeNull();
    // Non-share hashes are left alone entirely (not our hash to manage).
    expect(location.hash).toBe('#somethingelse');
  });
});

// ─── Boot priority: hash beats localStorage ───────────────────────────────

function renderApp() {
  return renderHook(() => useAppState(), { wrapper: AppStateProvider });
}

describe('boot priority — hash beats localStorage', () => {
  it('a valid #s= hash wins over a persisted localStorage state on initial load', () => {
    // Seed localStorage with a distinguishable persisted state.
    localStorage.setItem(
      '0x00c0dec5-state-tabular',
      JSON.stringify({ ...DEFAULT_STATE, shape: [123] }),
    );
    localStorage.setItem('0x00c0dec5-active-model', 'tabular');

    // Seed a different, distinguishable shared state in the hash.
    const shared: AppState = { ...DEFAULT_STATE, shape: [48] };
    window.location.hash = `${SHARE_HASH_PREFIX}${encodeShareState(shared)}`;

    const { result } = renderApp();
    expect(result.current.state.shape).toEqual([48]);
    // Hash is stripped after boot so a reload doesn't resurrect it.
    expect(location.hash).toBe('');
  });

  it('an invalid #s= hash falls through to localStorage rather than defaults', () => {
    localStorage.setItem(
      '0x00c0dec5-state-tabular',
      JSON.stringify({ ...DEFAULT_STATE, shape: [123] }),
    );
    localStorage.setItem('0x00c0dec5-active-model', 'tabular');
    window.location.hash = `${SHARE_HASH_PREFIX}garbage`;

    const { result } = renderApp();
    expect(result.current.state.shape).toEqual([123]);
    expect(location.hash).toBe('');
  });

  it('a valid hash whose state switches dataModel records that model as active', () => {
    window.location.hash = `${SHARE_HASH_PREFIX}${encodeShareState({ ...DEFAULT_STATE, dataModel: 'array', shape: [5, 5] })}`;
    act(() => {
      renderApp();
    });
    expect(localStorage.getItem('0x00c0dec5-active-model')).toBe('array');
  });

  it('with no hash present, boots from localStorage as before (unaffected)', () => {
    localStorage.setItem(
      '0x00c0dec5-state-tabular',
      JSON.stringify({ ...DEFAULT_STATE, shape: [7] }),
    );
    localStorage.setItem('0x00c0dec5-active-model', 'tabular');
    const { result } = renderApp();
    expect(result.current.state.shape).toEqual([7]);
  });
});
