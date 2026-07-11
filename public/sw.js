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

// Origins whose GETs we persist: same-origin only for now (the app shell +
// its assets). A CDN origin (e.g. for Pyodide) can be added here later.
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
                    .filter(name => name.startsWith('0xc-') && name !== CACHE)
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
