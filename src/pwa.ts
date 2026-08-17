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

// An installable app needs a service worker with a fetch listener, but this one
// deliberately caches nothing: the webview is worthless without the laptop it
// streams from, and a cache would happily serve assets of an extension version
// the dispatcher no longer hosts. Not calling respondWith leaves every request
// on the plain network path, streams included.
export const pwaServiceWorkerSource = `self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {});
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
