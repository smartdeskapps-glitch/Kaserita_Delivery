// Supabase Edge Function: enviar-notificacion-pedido-listo
//
// La dispara un Database Webhook configurado a mano en el Dashboard de
// Supabase (Database -> Webhooks) sobre UPDATE sobre pedidos_seguimiento.
// No se puede crear ese webhook por SQL -- ver INSTRUCCIONES_PUSH.md en
// este mismo repo para los pasos exactos.
//
// Qué hace: si el UPDATE dejó estado = 'listo', busca la suscripción push
// guardada del cliente (clientes_delivery.push_subscription) y le manda
// la notificación. Si el cliente nunca activó las notificaciones, no
// hace nada (no es un error).

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Secreto compartido con el Database Webhook (header x-webhook-secret). Sin
// esto, cualquiera con la anon key pública podría llamar a la función con
// un payload inventado y mandar notificaciones falsas.
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!WEBHOOK_SECRET) console.warn("WEBHOOK_SECRET no está configurado: la función acepta llamadas de cualquiera.");

webpush.setVapidDetails("mailto:soporte@kaserita.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("no autorizado", { status: 401 });
  }
  try {
    const payload = await req.json();
    const fila = payload.record;

    if (!fila || fila.estado !== "listo") {
      return new Response("ok (nada que hacer)", { status: 200 });
    }

    if (!ES_UUID.test(String(fila.cliente_id)) || !ES_UUID.test(String(fila.bodega_id))) {
      return new Response("payload inválido", { status: 400 });
    }

    const headers = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };
    const [clienteResp, bodegaResp] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/clientes_delivery?id=eq.${fila.cliente_id}&select=push_subscription`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/bodegas?id=eq.${fila.bodega_id}&select=slug`, { headers }),
    ]);
    const clienteFilas = await clienteResp.json();
    const bodegaFilas = await bodegaResp.json();
    const suscripcion = clienteFilas?.[0]?.push_subscription;
    const slug = bodegaFilas?.[0]?.slug;

    if (!suscripcion) {
      return new Response("ok (el cliente no activó notificaciones)", { status: 200 });
    }

    // El cliente puede tener varias bodegas instaladas como accesos
    // directos distintos (cada una con su propio start_url) -- si no le
    // decimos a qué bodega pertenece este pedido, el service worker no
    // sabe cuál ventana enfocar o abrir al tocar la notificación.
    await webpush.sendNotification(
      suscripcion,
      JSON.stringify({
        title: "¡Tu pedido está listo!",
        body: `Código ${fila.codigo_corto} -- ya podés pasar a retirarlo.`,
        url: slug ? `/${slug}` : "/",
      })
    );

    return new Response("ok (push enviado)", { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});
