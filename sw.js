/* Service worker for the app shell only.
   Precaches a short, explicit list of static assets (this file, the page
   shell, icons, font, manifest, and the two external CDN <script> tags the
   page loads) with a stale-while-revalidate strategy: serve from cache
   instantly, then silently refetch in the background and update the cache
   for next time. Everything else — Supabase REST/auth calls, Google
   Calendar/Tasks, the Chess.com API — is left completely untouched (no
   fetch handler match), so this can never affect Supabase egress, auth
   freshness, or live data. */

var CACHE_NAME = "dashboard-shell-v1";

var PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./sd-logo.svg",
  "./Icon-192.png",
  "./icon-512.png",
  "./Asap_VariableFont_wdth_wght.ttf",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://accounts.google.com/gsi/client"
];

// Adds one URL to the cache, bounded to `ms` milliseconds. A per-item
// .catch() alone isn't enough to guarantee install() finishes — that only
// covers a *rejection*; it does nothing for a request that just hangs
// (throttled/blocked cross-origin fetch, flaky connection, etc.), which
// leaves the returned promise neither resolved nor rejected forever. That
// was silently stalling installation of this whole service worker, which in
// turn made navigator.serviceWorker.ready in index.html hang indefinitely —
// surfaced there as "Timed out waiting for the service worker to activate."
function cacheAddWithTimeout(cache, url, ms) {
  return Promise.race([
    cache.add(new Request(url, { cache: "reload" })),
    new Promise(function (resolve) { setTimeout(resolve, ms); })
  ]).catch(function () {
    /* a single failed precache entry (e.g. offline install, CDN unreachable)
       must never block the rest, or the whole install would stall */
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(
        PRECACHE_URLS.map(function (url) { return cacheAddWithTimeout(cache, url, 8000); })
      );
    }).then(function () { return self.skipWaiting(); })
      // Belt-and-suspenders: even if something above throws in a way the
      // per-item handling didn't anticipate (e.g. caches.open() itself
      // failing), still proceed to skipWaiting() rather than leaving this
      // service worker stuck in "installing" forever.
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
      .catch(function () { return self.clients.claim(); })
  );
});

var PRECACHE_ABSOLUTE_URLS = PRECACHE_URLS.map(function (u) { return new URL(u, self.location.href).href; });

function isPrecachedRequest(request) {
  if (request.method !== "GET") return false;
  return PRECACHE_ABSOLUTE_URLS.indexOf(request.url) !== -1;
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (!isPrecachedRequest(request)) return; // not in our shell list — let it hit the network normally, untouched

  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(request).then(function (cached) {
        var networkFetch = fetch(request).then(function (response) {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        }).catch(function () { return cached; });
        return cached || networkFetch;
      });
    })
  );
});

/* ---------------- push notifications (bill reminders) ----------------
   Payload comes from supabase/functions/send-bill-reminders as plain JSON:
   { title, body }. Unrelated to the precache/fetch logic above — these
   listeners only fire on an actual push message or a tap on the resulting
   notification. */
self.addEventListener("push", function (event) {
  var payload = { title: "Dashboard", body: "You have an update." };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (e) { /* non-JSON push payload — fall back to the defaults above */ }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./Icon-192.png",
      badge: "./Icon-192.png",
      tag: "bill-reminder" // a newer reminder replaces an unread older one instead of stacking
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) {
          // Focusing an already-open tab alone leaves it on whatever page it
          // happened to be showing — postMessage tells index.html to jump to
          // Budget (see the "bill-reminder-click" listener there) so tapping
          // the notification actually shows the bills it's about.
          client.focus();
          if ("postMessage" in client) client.postMessage({ type: "bill-reminder-click" });
          return client;
        }
      }
      // Nothing open at all — launch fresh with a query param index.html
      // checks on boot and forwards to Budget once signed in.
      if (self.clients.openWindow) return self.clients.openWindow("./index.html?open=budget");
    })
  );
});
