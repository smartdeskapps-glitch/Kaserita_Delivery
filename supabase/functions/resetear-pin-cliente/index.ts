// Supabase Edge Function: resetear-pin-cliente
//
// La llama directo el frontend público (KaseritaDelivery/index.html,
// "¿Olvidaste tu PIN?") con la anon key -- no hace falta estar logueado,
// es justamente para el caso de no poder entrar.
//
// Importante: el celular NO se verifica (no hay SMS/WhatsApp OTP en este
// proyecto) -- mismo nivel de confianza que ya tiene el registro hoy.
// Cualquiera que sepa el celular de otra persona puede resetear su PIN.
// El límite de 3 intentos por hora (tabla reseteos_pin) frena el abuso
// masivo/automatizado, no un ataque dirigido a una sola cuenta.
//
// Deploy manual (mismo mecanismo que enviar-notificacion-pedido-listo,
// ver INSTRUCCIONES_PUSH.md):
//   1. Dashboard de Supabase -> Edge Functions -> New Function.
//   2. Nombre exacto: resetear-pin-cliente
//   3. Pegar el contenido completo de este archivo.
//   4. Deploy. No necesita secretos nuevos (SUPABASE_URL y
//      SUPABASE_SERVICE_ROLE_KEY ya los da Supabase automáticamente).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LIMITE_INTENTOS_POR_HORA = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Mismo truco de siempre: PIN -> contraseña de Supabase Auth (ver
// passwordAuthDesdePin en el frontend, tiene que dar el mismo resultado).
const passwordAuthDesdePin = (pin: string) => `kst-${pin.trim()}`;

function respuesta(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { telefono, nuevo_pin } = await req.json();
    const tel = String(telefono || "").replace(/\D/g, "");
    const pin = String(nuevo_pin || "").trim();

    if (tel.length < 6) return respuesta({ error: "Ingresá un celular válido." }, 400);
    if (pin.length < 4) return respuesta({ error: "El PIN tiene que tener al menos 4 dígitos." }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Límite de intentos por celular en la última hora, independiente de
    // si la cuenta existe o no -- así tampoco sirve para "probar" qué
    // celulares tienen cuenta a fuerza de intentos.
    const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("reseteos_pin")
      .select("id", { count: "exact", head: true })
      .eq("telefono", tel)
      .gte("intentado_en", haceUnaHora);

    if ((count || 0) >= LIMITE_INTENTOS_POR_HORA) {
      return respuesta({ error: "Demasiados intentos con ese celular. Probá de nuevo en una hora." }, 429);
    }

    await admin.from("reseteos_pin").insert({ telefono: tel });

    const { data: cliente } = await admin
      .from("clientes_delivery")
      .select("auth_id")
      .eq("telefono", tel)
      .maybeSingle();

    // Mensaje genérico exista o no la cuenta -- si dijéramos "no existe
    // ninguna cuenta con ese celular" quedaría abierta una forma fácil de
    // averiguar qué celulares están registrados, probando uno por uno.
    const mensajeGenerico = "Si ese celular tiene una cuenta, ya se actualizó el PIN.";

    if (!cliente?.auth_id) {
      return respuesta({ mensaje: mensajeGenerico });
    }

    const { error: errUpdate } = await admin.auth.admin.updateUserById(cliente.auth_id, {
      password: passwordAuthDesdePin(pin),
    });
    if (errUpdate) throw errUpdate;

    return respuesta({ mensaje: mensajeGenerico });
  } catch (err) {
    console.error(err);
    return respuesta({ error: "No se pudo actualizar el PIN. Intentá de nuevo en un momento." }, 500);
  }
});
