// Service Worker — يستقبل الإشعارات ويعرضها حتى لو الصفحة مقفولة
self.addEventListener("push", (event) => {
  let data = { title: "بُن", body: "لديك تحديث جديد" };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title || "بُن", {
      body: data.body || "",
      icon: "icon-192.png",
      badge: "icon-192.png",
      dir: "rtl",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/index.html");
    })
  );
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));
