/**
 * Offline cache -- hand-written, no workbox. Runtime cache-first for the app
 * shell and its assets. Offline reloads then serve from cache.
 *
 * The page registers us as `sw.js?v=<commit>`, so a new build gets a new
 * script URL (forcing an update) and a fresh, versioned cache; activate()
 * purges the caches from older versions.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `0xc-${VERSION}`;

// Project 4: the Pyodide runtime (+ numpy/numcodecs wheels) from the CDN.
// SEPARATE cache from the per-commit app-shell cache: these URLs are pinned
// and immutable, and evicting ~30MB of runtime on every deploy (the app
// cache's lifecycle) would force a re-download for no reason. Keep this
// version in sync with src/engine/pyodideRuntime.ts's PYODIDE_VERSION —
// tests/unit/engine/pyodideVersionSync.test.ts enforces the match.
const PYODIDE_VERSION = '314.0.2';
const PYODIDE_CACHE = `0xc-pyodide-${PYODIDE_VERSION}`;
const PYODIDE_ORIGIN = 'https://cdn.jsdelivr.net';
const PYODIDE_PATH_PREFIX = `/pyodide/v${PYODIDE_VERSION}/`;

// Origins whose GETs we persist: same-origin (the app shell + its assets)
// plus the pinned Pyodide CDN origin, handled separately below.
const CACHEABLE_ORIGINS = [self.location.origin];

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        (async () => {
            const names = await self.caches.keys();
            await Promise.all(
                names
                    .filter(name => name.startsWith('0xc-') && name !== CACHE && name !== PYODIDE_CACHE)
                    .map(name => self.caches.delete(name))
            );
            await self.clients.claim();
        })()
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    // Only full GETs to our own origin. Range reads and arbitrary URLs the
    // user pastes go straight to the network.
    if (request.method !== 'GET' || request.headers.has('range')) {
        return;
    }
    const url = new URL(request.url);
    if (url.origin === PYODIDE_ORIGIN) {
        if (!url.pathname.startsWith(PYODIDE_PATH_PREFIX)) {
            return; // some other jsdelivr URL: not ours to cache
        }
        event.respondWith(
            (async () => {
                const cache = await self.caches.open(PYODIDE_CACHE);
                const cached = await cache.match(request);
                if (cached) {
                    return cached;
                }
                const response = await fetch(request);
                if (response.ok) {
                    await cache.put(request, response.clone());
                }
                return response;
            })()
        );
        return;
    }
    if (!CACHEABLE_ORIGINS.includes(url.origin)) {
        return;
    }
    // Navigations (the app shell) are the unhashed URL whose content changes
    // across deploys: it MUST be network-first, with the cache only as the
    // offline fallback. Served cache-first, a client that warmed the cache
    // once would be pinned to that build forever -- the cached shell
    // re-registers its own old sw.js?v=<commit>, which keeps serving the
    // cached shell. Everything else (hashed vite assets) is immutable per
    // URL, so cache-first is safe.
    const networkFirst = request.mode === 'navigate';
    event.respondWith(
        (async () => {
            const cache = await self.caches.open(CACHE);
            if (networkFirst) {
                try {
                    const response = await fetch(request);
                    if (response.ok) {
                        await cache.put(request, response.clone());
                    }
                    return response;
                } catch (error) {
                    const cached = await cache.match(request);
                    if (cached) {
                        return cached;
                    }
                    throw error;
                }
            }
            const cached = await cache.match(request);
            if (cached) {
                return cached;
            }
            const response = await fetch(request);
            if (response.ok) {
                await cache.put(request, response.clone());
            }
            return response;
        })()
    );
});
