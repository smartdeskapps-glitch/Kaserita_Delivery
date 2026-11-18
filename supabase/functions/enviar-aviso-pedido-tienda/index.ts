// Supabase Edge Function: enviar-aviso-pedido-tienda
//
// La dispara un Database Webhook (INSERT sobre pedidos_seguimiento) configurado a
// mano en el Dashboard de Supabase, con el header x-webhook-secret.
//
// Qué hace: cuando un cliente hace un pedido (o reserva una cita), manda una
// notificación push a los celulares del dueño que activaron "Avisarme de pedidos
// nuevos" en el POS (tabla push_dueno), aunque el POS esté cerrado.

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DISPOSITIVOS = 50;

function claveSecreta(): string {
  try {
    const claves = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (typeof claves.default === "string" && claves.default) return claves.default;
  } catch { /* sigue con la antigua */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const CLAVE = claveSecreta();

webpush.setVapidDetails("mailto:soporte@kaserita.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const headers: Record<string, string> = CLAVE.startsWith("eyJ")
  ? { apikey: CLAVE, Authorization: `Bearer ${CLAVE}` }
  : { apikey: CLAVE };

// El endpoint lo guarda el celular: solo se le habla a los servicios push reales, nunca a una
// dirección cualquiera (evita que alguien use la función para hacer peticiones a donde quiera).
const ENDPOINT_PUSH_VALIDO =
  /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\/\S*$/;

const recortar = (t: unknown, n: number) => String(t ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, n);

Deno.serve(async (req) => {
  if (!WEBHOOK_SECRET) {
    console.error("Falta el secreto WEBHOOK_SECRET: la función no atiende llamadas.");
    return new Response("configuración incompleta", { status: 500 });
  }
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("no autorizado", { status: 401 });
  }
  try {
    const payload = await req.json();
    const fila = payload.record;
    if (payload.type !== "INSERT" || !fila || !ES_UUID.test(String(fila.bodega_id))) {
      return new Response("payload inválido", { status: 400 });
    }

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/push_dueno?bodega_id=eq.${fila.bodega_id}&select=id,suscripcion&limit=${MAX_DISPOSITIVOS}`,
      { headers }
    );
    const dispositivos = await resp.json();
    if (!Array.isArray(dispositivos) || dispositivos.length === 0) {
      return new Response("ok (sin dispositivos)", { status: 200 });
    }

    const cliente = recortar(fila.cliente_nombre, 40) || "Un cliente";
    const esCita = !!fila.cita_barbero_id;
    const titulo = esCita ? "Nueva cita reservada" : "Nuevo pedido";
    let cuerpo = `${cliente}${fila.codigo_corto ? ` · #${recortar(fila.codigo_corto, 12)}` : ""}`;
    if (esCita && fila.cita_hora) cuerpo += ` · ${recortar(fila.cita_hora, 8)}`;
    if (!esCita && fila.tipo_entrega === "domicilio") cuerpo += " · a domicilio";
    const mensaje = JSON.stringify({ title: titulo, body: cuerpo, url: "/pos", tag: `pedido-${fila.id}` });

    let enviados = 0;
    await Promise.all(
      dispositivos.map(async (d: { id: number; suscripcion: any }) => {
        try {
          if (!ENDPOINT_PUSH_VALIDO.test(String(d.suscripcion?.endpoint ?? ""))) {
            await fetch(`${SUPABASE_URL}/rest/v1/push_dueno?id=eq.${d.id}`, { method: "DELETE", headers });
            return;
          }
          // urgency alta: sin ella Android en reposo (Doze) retrasa el aviso minutos u horas.
          // TTL de 1 h: un "nuevo pedido" que llega horas después ya no sirve.
          await webpush.sendNotification(d.suscripcion, mensaje, { urgency: "high", TTL: 3600 });
          enviados++;
        } catch (err) {
          const codigo = (err as { statusCode?: number })?.statusCode;
          if (codigo === 404 || codigo === 410) {
            await fetch(`${SUPABASE_URL}/rest/v1/push_dueno?id=eq.${d.id}`, { method: "DELETE", headers });
          } else {
            console.warn("No se pudo avisar a un dispositivo del dueño:", codigo || String(err));
          }
        }
      })
    );
    return new Response(`ok (${enviados} enviados)`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});
