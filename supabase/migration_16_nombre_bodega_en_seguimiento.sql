-- KaseritaDelivery — nombre de bodega en "Mis pedidos".
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_15.
--
-- Para qué: la cuenta del cliente (clientes_delivery) es global por
-- teléfono, no por bodega -- si compra en dos bodegas distintas, "Mis
-- pedidos" ya le muestra los pedidos de ambas (RLS filtra solo por
-- cliente_id, no por bodega_id), pero sin decir de cuál bodega es cada
-- uno. pedidos_seguimiento solo trae bodega_id (uuid); el cliente no
-- tiene acceso directo a la tabla bodegas, así que hace falta una función
-- que resuelva esos ids a nombre/slug, con la misma superficie que ya
-- expone la vista bodegas_delivery (solo bodegas con delivery habilitado
-- y con el permiso pago -- bodegas_delivery ya exige ambas cosas).

create or replace function public.obtener_nombres_bodegas(p_ids uuid[])
returns table (bodega_id uuid, nombre text, slug text)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, nombre, slug
  from bodegas_delivery
  where bodega_id = any(p_ids);
$$;

grant execute on function public.obtener_nombres_bodegas(uuid[]) to authenticated;
