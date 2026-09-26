// Supabase Edge Function: enviar-aviso-tienda
//
// La dispara un Database Webhook (INSERT sobre avisos_tienda) configurado a
// mano en el Dashboard de Supabase -- ver INSTRUCCIONES_PUSH.md, paso 4.
//
// Qué hace: cuando una bodega activa su catálogo o su entrega a domicilio
// (aviso automático), o cuando el dueño toca "Avisar a mis clientes"
// (aviso manual), manda una notificación push a los clientes que tienen esa
// bodega en "Mis tiendas" (visitada, seguida o con pedidos), tienen las
// notificaciones activadas y no apagaron los avisos de esa tienda.

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Tope de seguridad por aviso (una bodega chica no llega ni cerca).
const MAX_DESTINATARIOS = 2000;
const TAMANO_LOTE_IDS = 100;
const ENVIOS_EN_PARALELO = 10;
if (!WEBHOOK_SECRET) console.warn("WEBHOOK_SECRET no está configurado: la función acepta llamadas de cualquiera.");

webpush.setVapidDetails("mailto:soporte@kaserita.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const headers = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };

Deno.serve(async (req) => {
  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("no autorizado", { status: 401 });
  }
  try {
    const payload = await req.json();
    const fila = payload.record;

    if (!fila || !ES_UUID.test(String(fila.id)) || !ES_UUID.test(String(fila.bodega_id))) {
      return new Response("payload inválido", { status: 400 });
    }
    // Un aviso ya procesado (enviados no es null) no se manda dos veces.
    if (fila.enviados !== null && fila.enviados !== undefined) {
      return new Response("ok (ya enviado)", { status: 200 });
    }

    const bodegaResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bodegas?id=eq.${fila.bodega_id}&select=nombre,slug,delivery_habilitado,delivery_permitido,delivery_domicilio`,
      { headers }
    );
    const bodega = (await bodegaResp.json())?.[0];
    if (!bodega || !bodega.delivery_habilitado || !bodega.delivery_permitido || !bodega.slug) {
      await marcarEnviados(fila.id, 0);
      return new Response("ok (la bodega no está activa)", { status: 200 });
    }

    // Clientes con esa bodega en "Mis tiendas" que no apagaron los avisos.
    const visitasResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bodegas_visitadas?bodega_id=eq.${fila.bodega_id}&avisos=eq.true&select=cliente_id&limit=${MAX_DESTINATARIOS}`,
      { headers }
    );
    const visitas = await visitasResp.json();
    const clienteIds: string[] = (Array.isArray(visitas) ? visitas : [])
      .map((v: { cliente_id: string }) => v.cliente_id)
      .filter((id: string) => ES_UUID.test(String(id)));

    const destinatarios: { id: string; push_subscription: any }[] = [];
    for (let i = 0; i < clienteIds.length; i += TAMANO_LOTE_IDS) {
      const lote = clienteIds.slice(i, i + TAMANO_LOTE_IDS);
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/clientes_delivery?id=in.(${lote.join(",")})&push_subscription=not.is.null&select=id,push_subscription`,
        { headers }
      );
      const filas = await r.json();
      if (Array.isArray(filas)) destinatarios.push(...filas);
    }

    const conDomicilio = !!bodega.delivery_domicilio;
    // Si la tienda ofrece domicilio (o el aviso es justo por eso), el título
    // lo dice: "ya cuenta con delivery". Si no, es el aviso simple de pedidos.
    const anunciaDelivery = fila.tipo === "domicilio" || (fila.tipo === "manual" && conDomicilio);
    const titulo = anunciaDelivery
      ? `${bodega.nombre} ya cuenta con delivery`
      : `¡${bodega.nombre} ya recibe pedidos!`;
    const cuerpo =
      fila.tipo === "domicilio"
        ? "Pide desde tu casa: marca tu ubicación y te lo llevan."
        : conDomicilio
        ? "Haz tu pedido y retíralo en tienda o pídelo a domicilio."
        : "Entra y haz tu pedido.";
    const mensaje = JSON.stringify({ title: titulo, body: cuerpo, url: `/${bodega.slug}` });

    let enviados = 0;
    const cola = [...destinatarios];
    const trabajador = async () => {
      while (cola.length > 0) {
        const cliente = cola.pop()!;
        try {
          await webpush.sendNotification(cliente.push_subscription, mensaje);
          enviados++;
        } catch (err) {
          const codigo = (err as { statusCode?: number })?.statusCode;
          // Suscripción vencida o dada de baja: se limpia para no reintentar siempre.
          if (codigo === 404 || codigo === 410) {
            await fetch(`${SUPABASE_URL}/rest/v1/clientes_delivery?id=eq.${cliente.id}`, {
              method: "PATCH",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ push_subscription: null }),
            });
          } else {
            console.warn("No se pudo enviar el aviso a un cliente:", codigo || String(err));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: ENVIOS_EN_PARALELO }, trabajador));

    await marcarEnviados(fila.id, enviados);
    return new Response(`ok (${enviados} enviados)`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});

async function marcarEnviados(id: string, enviados: number) {
  await fetch(`${SUPABASE_URL}/rest/v1/avisos_tienda?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ enviados }),
  });
}
