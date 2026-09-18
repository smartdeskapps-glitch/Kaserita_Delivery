// Service worker mínimo, solo para notificaciones push -- no cachea nada
// (la vitrina necesita internet siempre para hablar con Supabase).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());

self.addEventListener("push", (event) => {
  let datos = { title: "Kaserita Delivery", body: "Tenés novedades en tu pedido.", url: "/" };
  try {
    if (event.data) datos = { ...datos, ...event.data.json() };
  } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(datos.title, {
      body: datos.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: datos.url },
      silent: false,
      vibrate: [200, 100, 200],
    })
  );
});

// Un mismo cliente puede tener varias bodegas instaladas como accesos
// directos separados (una por slug). Si ya hay una ventana de la bodega
// del pedido abierta, la enfoca; si hay otra ventana (de otra bodega o
// pestaña suelta), la navega hacia la bodega correcta antes de enfocarla;
// si no hay ninguna, abre una nueva ahí.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
      const exacto = clientList.find((c) => c.url === url);
      if (exacto && "focus" in exacto) return exacto.focus();
      const otro = clientList.find((c) => "navigate" in c && "focus" in c);
      if (otro) {
        const navegado = await otro.navigate(url);
        return navegado.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
