import type { AppState } from '../types/state.ts';
import { validateExternalState } from './persistence.ts';

/**
 * Task 6.4 (remediation-plan.md, Phase 6): checkpoint/restore — "undo-lite"
 * for the live talk. One slot, full `AppState` JSON, following the exact
 * same storage-key-per-concern pattern as the custom-preset slot in
 * `presets.ts` (D10). Restoring goes through `validateExternalState` (the
 * same migrate -> default-merge -> validate pipeline every other load path
 * uses), so a checkpoint saved by an older build, or hand-edited/corrupt
 * localStorage, degrades the same way a stale preset or persisted state
 * would rather than crashing.
 */
export const CHECKPOINT_KEY = '0x00c0dec5-checkpoint';

/** Save `state` to the single checkpoint slot, overwriting whatever was
 * there before (one slot, not a stack — repeated saves just move the
 * checkpoint forward). */
export function saveCheckpoint(state: AppState): void {
  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(state));
  } catch {
    // silently fail on storage errors, consistent with saveState/saveCustomPreset
  }
}

/** Whether a checkpoint currently exists (drives whether the Restore button
 * is enabled/shown). */
export function hasCheckpoint(): boolean {
  try {
    return localStorage.getItem(CHECKPOINT_KEY) !== null;
  } catch {
    return false;
  }
}

/** Load the checkpoint, validated through the same pipeline as any other
 * persisted state. Returns `null` if nothing has been saved yet, or the
 * saved JSON is corrupt/unparseable/structurally invalid. Restoring does
 * NOT clear the checkpoint — it stays in place so the same snapshot can be
 * restored again (repeatable, per task 6.4). The checkpoint's own
 * `dataModel` is preserved (mirrors `loadCustomPreset`), so restoring from
 * the other data model switches back to whichever model was checkpointed. */
export function loadCheckpoint(): AppState | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { dataModel?: unknown };
    const model: AppState['dataModel'] = parsed.dataModel === 'array' ? 'array' : 'tabular';
    return validateExternalState(parsed, model);
  } catch {
    return null;
  }
}

/**
 * Task 6.5 (remediation-plan.md, Phase 6): shareable state URLs. `AppState`
 * -> JSON -> base64url, small enough (a few KB) to live comfortably in a URL
 * hash fragment with no new dependencies. base64url (RFC 4648 §5) avoids the
 * `+`, `/`, and `=` characters that would otherwise need percent-encoding
 * inside a fragment.
 */

/** `btoa`/`atob` operate on a "binary string" (one code unit per byte), so a
 * JSON string with non-Latin1 characters (e.g. unicode custom metadata
 * values/keys) needs a UTF-8 encode/decode pass around them, not a direct
 * `btoa(json)`. */
function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  else if (pad !== 0) throw new Error('invalid base64url length');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode a full `AppState` into a base64url string suitable for a URL hash
 * fragment (`#s=<encoded>`). */
export function encodeShareState(state: AppState): string {
  return toBase64Url(JSON.stringify(state));
}

/** Decode a base64url-encoded state string back into a validated `AppState`.
 * Returns `null` on any decoding/parsing/validation failure — the caller
 * (boot-time hash handling, or the round-trip tests) treats that identically
 * to "no shared state was present." The decoded state's own `dataModel`
 * wins (mirrors `loadCheckpoint`/`loadCustomPreset`). */
export function decodeShareState(encoded: string): AppState | null {
  try {
    const json = fromBase64Url(encoded);
    const parsed = JSON.parse(json) as { dataModel?: unknown };
    const model: AppState['dataModel'] = parsed.dataModel === 'array' ? 'array' : 'tabular';
    return validateExternalState(parsed, model);
  } catch {
    return null;
  }
}

/** Prefix marking a share-state hash fragment, e.g. `#s=<encoded>`. */
export const SHARE_HASH_PREFIX = '#s=';

/** Build the full shareable URL for `state`: origin + pathname (no query
 * string or existing hash) + the encoded state hash. */
export function buildShareUrl(state: AppState): string {
  return `${location.origin}${location.pathname}${SHARE_HASH_PREFIX}${encodeShareState(state)}`;
}

/**
 * Boot-time hash consumption (task 6.5): if `location.hash` currently
 * carries a `#s=` share payload, decode + validate it and return the
 * resulting `AppState` (highest priority — the caller uses this ahead of
 * localStorage). Regardless of success or failure, the hash is stripped via
 * `history.replaceState` so a subsequent reload (or in-app edit that
 * triggers a save) doesn't resurrect stale shared state from the URL bar.
 * Safe to call outside a browser (no `location`/`history`) — returns `null`.
 */
export function consumeShareHash(): AppState | null {
  if (typeof location === 'undefined') return null;
  const hash = location.hash;
  if (!hash.startsWith(SHARE_HASH_PREFIX)) return null;

  const encoded = hash.slice(SHARE_HASH_PREFIX.length);
  const decoded = decodeShareState(encoded);

  // Strip the hash unconditionally (valid or not) so it can't resurrect
  // stale state on a later reload.
  if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    history.replaceState(null, '', location.pathname + location.search);
  }

  return decoded;
}
