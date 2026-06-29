/* Glas service worker
 * 1. Offline app shell caching.
 * 2. Web Share Target: receives a POSTed audio file from Android's share sheet,
 *    stashes it in the Cache, and redirects into the transcribe flow.
 */
const VERSION = "glas-v4";
const SHELL_CACHE = `${VERSION}-shell`;
const SHARE_CACHE = "glas-share"; // holds the most recently shared audio
const SHARED_AUDIO_URL = "/__shared-audio"; // internal cache key, never fetched from network

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Tolerant precache: a single failing asset must not abort SW install
      // (which can otherwise stall PWA installation on some devices).
      await Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(u)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== SHARE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // --- Web Share Target: Android shares a file here via POST ---
  if (request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShare(request));
    return;
  }

  // Never cache the API or the admin page; always hit the network.
  if (url.pathname.startsWith("/api/") || url.pathname === "/admin") return;

  // App shell: NETWORK-FIRST for same-origin GETs so deploys always show the
  // latest frontend; fall back to cache (then index.html) only when offline.
  if (request.method === "GET" && url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match("/index.html")),
        ),
    );
  }
});

async function handleShare(request) {
  try {
    const formData = await request.formData();
    const file = formData.get("audio") || formData.get("file");
    if (file && file.size) {
      const cache = await caches.open(SHARE_CACHE);
      const headers = new Headers();
      headers.set("content-type", file.type || "application/octet-stream");
      headers.set("x-filename", encodeURIComponent(file.name || "shared-voice-note.ogg"));
      await cache.put(SHARED_AUDIO_URL, new Response(file, { headers }));
    }
  } catch (err) {
    // Fall through to redirect; the page will simply show no shared file.
  }
  // 303 so the browser issues a GET for the landing page.
  return Response.redirect("/?shared=1", 303);
}

// Let the page retrieve + clear the shared audio.
self.addEventListener("message", (event) => {
  if (event.data === "get-shared-audio") {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(SHARE_CACHE);
        const res = await cache.match(SHARED_AUDIO_URL);
        if (!res) {
          event.source.postMessage({ type: "shared-audio", file: null });
          return;
        }
        const blob = await res.blob();
        const filename = decodeURIComponent(res.headers.get("x-filename") || "shared-voice-note.ogg");
        await cache.delete(SHARED_AUDIO_URL);
        event.source.postMessage({ type: "shared-audio", file: blob, filename });
      })(),
    );
  }
});
