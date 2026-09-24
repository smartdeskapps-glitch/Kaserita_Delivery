// Supabase Edge Function: resetear-pin-cliente -- DESACTIVADA (2026-09-23).
//
// Los clientes de Kaserita Delivery ya no entran con celular + PIN, solo con
// Google. Esta función dejaba cambiar el PIN de cualquier cliente sabiendo
// solo su celular (no se verificaba), o sea, tomar su cuenta. Se deja
// desplegada solo para responder 410 a quien todavía la llame; se puede
// borrar desde el Dashboard de Supabase (Edge Functions).

Deno.serve(() =>
  new Response(JSON.stringify({ error: "El ingreso con PIN ya no existe. Usá 'Continuar con Google'." }), {
    status: 410,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
);
