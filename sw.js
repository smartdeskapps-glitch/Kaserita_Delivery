// Service worker mínimo, solo para notificaciones push -- no cachea nada
// (la vitrina necesita internet siempre para hablar con Supabase).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());

self.addEventListener("push", (event) => {
  let datos = { title: "Kaserita Delivery", body: "Tenés novedades en tu pedido." };
  try {
    if (event.data) datos = { ...datos, ...event.data.json() };
  } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(datos.title, {
      body: datos.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
