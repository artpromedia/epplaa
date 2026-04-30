/* Web Push service worker for Epplaa */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "Epplaa", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Epplaa";
  const opts = {
    body: data.body || "",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
