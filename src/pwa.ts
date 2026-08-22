import { join } from "node:path";

export const pwaManifestPath = "/manifest.webmanifest";
export const pwaServiceWorkerPath = "/sw.js";
export const pwaIconPath = "/icon.png";

// A browser discovers an installable app through anonymous fetches: the manifest
// (and the icon it points at) are pulled without our session cookie, so every
// hop in front of the webview has to let these three through unauthenticated.
export const pwaPublicPaths: ReadonlySet<string> = new Set([pwaManifestPath, pwaServiceWorkerPath, pwaIconPath]);

// The home-screen icon is the icon of the extension we host, taken from the
// installed package so it always matches the build the webview came from.
export function pwaIconFilePath(webviewRoot: string): string {
  return join(webviewRoot, "..", "resources", "blossom.dark.png");
}

export const pwaIconSize = "385x385";

export function pwaManifest(): string {
  return JSON.stringify(
    {
      name: "Codex Dispatcher",
      short_name: "Codex",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#000000",
      theme_color: "#000000",
      icons: [
        {
          src: pwaIconPath,
          sizes: pwaIconSize,
          type: "image/png",
          purpose: "any",
        },
      ],
    },
    null,
    2,
  );
}

// The manifest is the list of hashed assets this dispatcher has actually
// served — the app's real boot set, not the 200MB+ of lazy chunks the bundle
// ships. The worker below syncs its cache to that list, so a phone on a bad
// channel warms up from what some browser already needed.
export const pwaPrecacheManifestPath = "/precache.json";

// Cache-first is safe precisely because only /assets/* is cached: those
// filenames carry a content hash, so a new extension version references new
// names and can never be hidden behind an old cached file. Everything else —
// index with its embedded host id, /events, /host-message — stays on the plain
// network path, streams included.
export const pwaServiceWorkerSource = `const assetCache = "codex-assets";
const precacheManifestPath = ${JSON.stringify(pwaPrecacheManifestPath)};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }
  if (request.mode === "navigate") {
    // Every page open re-syncs the cache in the background; the navigation
    // itself stays on the network.
    event.waitUntil(scheduleCacheSync());
    return;
  }
  if (!url.pathname.startsWith("/assets/") || request.headers.has("range")) {
    return;
  }
  event.respondWith(serveAsset(request, url.pathname));
});

async function serveAsset(request, pathname) {
  const cache = await caches.open(assetCache);
  const hit = await cache.match(pathname);
  if (hit) {
    return hit;
  }
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(pathname, response.clone());
  }
  return response;
}

let syncInFlight = null;

function scheduleCacheSync() {
  if (!syncInFlight) {
    // The delay keeps the sweep off the tunnel while the page pulls its own
    // boot assets — which land in the cache anyway via serveAsset.
    syncInFlight = new Promise((resolve) => setTimeout(resolve, 15000))
      .then(syncAssetCache)
      .finally(() => {
        syncInFlight = null;
      });
  }
  return syncInFlight;
}

async function syncAssetCache() {
  const cache = await caches.open(assetCache);
  const cachedPaths = new Set((await cache.keys()).map((cached) => new URL(cached.url).pathname));
  // Teach and learn in one round trip: the dispatcher cannot see what a warm
  // browser pulls out of its own HTTP cache, so each worker reports what it
  // holds and gets back the union every device taught.
  const manifestResponse = await fetch(precacheManifestPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assets: Array.from(cachedPaths) }),
  });
  if (!manifestResponse.ok) {
    throw new Error("precache manifest sync failed: " + manifestResponse.status);
  }
  const manifest = await manifestResponse.json();
  const wanted = new Set(manifest.assets);
  // Hashed names outside the manifest belong to an extension version the
  // dispatcher no longer serves.
  for (const pathname of cachedPaths) {
    if (!wanted.has(pathname)) {
      await cache.delete(pathname);
    }
  }
  const queue = manifest.assets.filter((pathname) => !cachedPaths.has(pathname));
  const workers = [];
  for (let index = 0; index < 4; index += 1) {
    workers.push(downloadQueued(cache, queue));
  }
  await Promise.all(workers);
}

async function downloadQueued(cache, queue) {
  while (queue.length > 0) {
    const pathname = queue.pop();
    // The page may have pulled this one through serveAsset since the sweep
    // started; downloading it twice would double the load on a bad channel.
    if (await cache.match(pathname)) {
      continue;
    }
    const response = await fetch(pathname);
    if (!response.ok) {
      throw new Error("precache of " + pathname + " failed: " + response.status);
    }
    await cache.put(pathname, response);
  }
}
`;

export function pwaHeadTags(): string {
  return `<link rel="manifest" href="${pwaManifestPath}">
<link rel="apple-touch-icon" href="${pwaIconPath}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Codex">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#000000">
<script>
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("${pwaServiceWorkerPath}", { scope: "/" });
    });
  }
</script>`;
}
