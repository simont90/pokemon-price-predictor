// Pokemon Price Predictor — Service Worker
// Strategy:
//   Versioned assets (?v=...)  → Cache First (immutable, safe to serve forever)
//   Data files (cards/sets db) → Stale-While-Revalidate (large, rarely changes)
//   Google Fonts               → Cache First
//   HTML                       → Network First, cache fallback (gets fresh busters)
//   External APIs              → Network Only (PriceCharting, Worker, eBay)

const SW_VER   = '20260704a';
const S_CACHE  = 'pkm-static-' + SW_VER;
const D_CACHE  = 'pkm-data-v1'; // survives SW updates — data files don't change often

// Precache the large data files on install so the first card lookup is instant.
const PRECACHE_URLS = [
  'data/cards-db.js',
  'data/sets-db.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(D_CACHE)
      .then(c => c.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Delete stale static caches; keep D_CACHE (data files don't change with every deploy).
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('pkm-static-') && k !== S_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const ownOrigin = url.hostname === self.location.hostname;
  const isFonts   = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

  // Only intercept same-origin and fonts; leave everything else (APIs) to network.
  if (!ownOrigin && !isFonts) return;

  if (isFonts) {
    // Cache First — fonts are content-addressed and never change.
    e.respondWith(
      caches.open(S_CACHE).then(c =>
        c.match(req).then(hit =>
          hit || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })
        )
      )
    );
    return;
  }

  const isVersioned = url.search.includes('v=');
  const isDataFile  = url.pathname.endsWith('cards-db.js') || url.pathname.endsWith('sets-db.js');
  const isHtml      = req.headers.get('accept')?.includes('text/html') || url.pathname.endsWith('.html') || url.pathname.endsWith('/');

  if (isVersioned) {
    // Cache First — URL encodes the version, so a cache hit is always correct.
    e.respondWith(
      caches.open(S_CACHE).then(c =>
        c.match(req).then(hit =>
          hit || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })
        )
      )
    );
  } else if (isDataFile) {
    // Stale-While-Revalidate — serve cached immediately, refresh in background.
    e.respondWith(
      caches.open(D_CACHE).then(c =>
        c.match(req).then(hit => {
          const netPromise = fetch(req).then(r => {
            if (r.ok) c.put(req, r.clone());
            return r;
          }).catch(() => null);
          return hit || netPromise;
        })
      )
    );
  } else if (isHtml) {
    // Network First — HTML must be fresh so cache busters update correctly.
    e.respondWith(
      fetch(req)
        .then(r => {
          if (r.ok) caches.open(S_CACHE).then(c => c.put(req, r.clone()));
          return r;
        })
        .catch(() => caches.match(req))
    );
  } else {
    // Other same-origin assets (images, etc.) — network with cache fallback.
    e.respondWith(
      fetch(req)
        .then(r => {
          if (r.ok) caches.open(S_CACHE).then(c => c.put(req, r.clone()));
          return r;
        })
        .catch(() => caches.match(req))
    );
  }
});
