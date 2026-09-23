// Supabase Edge Function: avisar-reposicion-stock
//
// La dispara un Database Webhook configurado a mano en el Dashboard de
// Supabase (Database -> Webhooks) sobre UPDATE de productos. Ver
// INSTRUCCIONES_PUSH.md en la raíz del repo para los pasos exactos.
//
// Qué hace: si el UPDATE hizo que stock_actual pasara de "sin stock"
// (null/0/negativo) a "con stock" (>0), busca a todos los clientes que
// pidieron que les avise (tabla avisos_reposicion) para ese producto, les
// manda el push, y borra esos avisos -- ya se avisó, no hace falta de
// nuevo hasta que el cliente lo vuelva a pedir.

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
    const anterior = payload.old_record;

    const teniaStock = Number(anterior?.stock_actual ?? 0) > 0;
    const tieneStockAhora = Number(fila?.stock_actual ?? 0) > 0;
    if (teniaStock || !tieneStockAhora) {
      return new Response("ok (no es una reposición de 0 a stock)", { status: 200 });
    }

    if (!ES_UUID.test(String(fila.id)) || !ES_UUID.test(String(fila.bodega_id))) {
      return new Response("payload inválido", { status: 400 });
    }

    const headers = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };

    const avisosResp = await fetch(
      `${SUPABASE_URL}/rest/v1/avisos_reposicion?producto_id=eq.${fila.id}&select=cliente_id`,
      { headers }
    );
    const avisos = await avisosResp.json();
    if (!avisos || avisos.length === 0) {
      return new Response("ok (nadie pidió aviso para este producto)", { status: 200 });
    }

    const idsClientes = [...new Set(avisos.map((a: { cliente_id: string }) => a.cliente_id))];
    const [clientesResp, bodegaResp] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/clientes_delivery?id=in.(${idsClientes.join(",")})&select=id,push_subscription`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/bodegas?id=eq.${fila.bodega_id}&select=slug`, { headers }),
    ]);
    const clientes = await clientesResp.json();
    const bodegaFilas = await bodegaResp.json();
    const slug = bodegaFilas?.[0]?.slug;

    await Promise.all(
      clientes
        .filter((c: { push_subscription: unknown }) => c.push_subscription)
        .map((c: { id: string; push_subscription: webpush.PushSubscription }) =>
          webpush
            .sendNotification(
              c.push_subscription,
              JSON.stringify({
                title: "¡Ya volvió al stock!",
                body: `${fila.descripcion} ya está disponible de nuevo.`,
                url: slug ? `/${slug}` : "/",
              })
            )
            .catch((err: unknown) => console.error("push falló para", c.id, err))
        )
    );

    // Se borran todos los avisos pendientes de este producto, hayan
    // recibido el push o no (si el cliente nunca activó notificaciones,
    // tampoco tiene sentido dejarlo "pendiente" para siempre).
    await fetch(`${SUPABASE_URL}/rest/v1/avisos_reposicion?producto_id=eq.${fila.id}`, {
      method: "DELETE",
      headers,
    });

    return new Response(`ok (${clientes.length} clientes procesados)`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});
