-- KaseritaDelivery — arregla el checkout roto por migration_07.
-- Ejecutar YA en el SQL Editor de Supabase, es urgente: desde que se
-- corrió migration_07, nadie puede completar un pedido en la vitrina.
--
-- Qué pasó: la política de INSERT de anon en pedidos_delivery hace
--   EXISTS (select 1 from bodegas b where b.id = ... and b.delivery_habilitado = true)
-- Esa subconsulta corre con los permisos de anon, no con privilegios
-- elevados -- y migration_07 le revocó a anon el SELECT directo sobre
-- bodegas (para cerrar la fuga de leer la tabla entera). Como
-- consecuencia, cualquier intento de crear un pedido ahora falla con
-- "permission denied" (aparece como tabla usuarios porque bodegas_select_propia,
-- la política de lectura de bodegas, a su vez consulta usuarios, que
-- también quedó sin SELECT para anon).
--
-- Fix: la verificación de "esta bodega admite pedidos" pasa a una función
-- security definer (mismo patrón que obtener_bodega_delivery y
-- obtener_productos_delivery), así no depende de que anon tenga SELECT
-- directo sobre bodegas. De paso, ahora también exige delivery_permitido
-- (antes solo chequeaba delivery_habilitado), igual que ya exigen las
-- vistas públicas desde migration_04.

create or replace function public.bodega_admite_pedido_delivery(p_bodega_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from bodegas b
    where b.id = p_bodega_id
      and b.delivery_habilitado = true
      and b.delivery_permitido = true
  );
$$;

grant execute on function public.bodega_admite_pedido_delivery(uuid) to anon;

drop policy if exists "anon puede crear pedidos_delivery" on pedidos_delivery;
create policy "anon puede crear pedidos_delivery"
  on pedidos_delivery for insert
  to anon
  with check (bodega_admite_pedido_delivery(bodega_id));
