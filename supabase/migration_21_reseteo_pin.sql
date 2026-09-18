-- KaseritaDelivery — límite de intentos para "Olvidé mi PIN".
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_20.
--
-- Para qué: se agrega un self-service para resetear el PIN de cliente
-- (celular + PIN nuevo, sin confirmar que sos el dueño real del celular --
-- mismo nivel de confianza que ya tiene el registro hoy, no hay SMS/
-- WhatsApp OTP). Esta tabla solo sirve para que la función de servidor
-- (resetear-pin-cliente, con service role) pueda contar cuántos intentos
-- hubo por celular en la última hora y cortar en 3, para que no se pueda
-- usar como herramienta de fuerza bruta masiva. No se expone a
-- authenticated/anon -- sin RLS policies (nadie salvo el service role,
-- que la ignora, puede tocarla).

create table if not exists reseteos_pin (
  id bigint generated always as identity primary key,
  telefono text not null,
  intentado_en timestamptz not null default now()
);

create index if not exists reseteos_pin_telefono_idx on reseteos_pin (telefono, intentado_en desc);

alter table reseteos_pin enable row level security;
