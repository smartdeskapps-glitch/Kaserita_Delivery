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

webpush.setVapidDetails("mailto:soporte@kaserita.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const fila = payload.record;

    if (!fila || fila.estado !== "listo") {
      return new Response("ok (nada que hacer)", { status: 200 });
    }

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/clientes_delivery?id=eq.${fila.cliente_id}&select=push_subscription`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
    );
    const filas = await resp.json();
    const suscripcion = filas?.[0]?.push_subscription;

    if (!suscripcion) {
      return new Response("ok (el cliente no activó notificaciones)", { status: 200 });
    }

    await webpush.sendNotification(
      suscripcion,
      JSON.stringify({
        title: "¡Tu pedido está listo!",
        body: `Código ${fila.codigo_corto} -- ya podés pasar a retirarlo.`,
      })
    );

    return new Response("ok (push enviado)", { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});
