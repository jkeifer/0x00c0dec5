/**
 * DEV ONLY: disable React 19.2's Component Performance Tracks.
 *
 * react-dom's development build logs every committed component to the Chrome
 * performance panel, and for any component whose props identity changed it
 * runs `addObjectDiffToProperties` — a DEEP STRUCTURAL DIFF of old vs new
 * props — before emitting the entry. Our pipeline props are worker-cloned
 * every recompute (fresh identities) and contain multi-MB typed arrays and
 * 100K-entry value Maps, so the diff walks all of it, per component, per
 * commit: measured ~95s of main-thread time for a single magic-number edit
 * at ~100K elements, and a never-finishing boot at 1M (StrictMode's
 * double-render gives even mounts an alternate to diff against). Production
 * builds contain none of this instrumentation and are unaffected.
 *
 * React gates the whole feature on `typeof console.timeStamp === 'function'`
 * (`supportsUserTiming` in react-dom-client.development.js), evaluated when
 * react-dom initializes — so this module must be imported BEFORE react-dom
 * (it is: first import in main.tsx; ES module execution order guarantees it).
 *
 * Escape hatch: set localStorage['0x00c0dec5-react-perf-track'] = 'on' and
 * reload to keep the tracks (e.g. to profile a SMALL dataset in DevTools).
 */
if (import.meta.env.DEV) {
  let optIn = false;
  try {
    optIn = localStorage.getItem('0x00c0dec5-react-perf-track') === 'on';
  } catch {
    // storage unavailable: default to disabling the track
  }
  if (!optIn && typeof console.timeStamp === 'function') {
    // Deleting the function flips react-dom's supportsUserTiming to false,
    // skipping the props-diff serialization entirely. console.timeStamp is a
    // Chrome-only debug API with no other consumer in this app.
    (console as { timeStamp?: unknown }).timeStamp = undefined;
  }
}

export {};
