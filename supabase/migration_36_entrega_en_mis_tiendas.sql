-- KaseritaDelivery — entrega a domicilio visible en "Mis tiendas".
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_35.
--
-- "Mis tiendas" (PantallaMisTiendas) usa obtener_nombres_bodegas para traer
-- nombre/logo/dirección/horario de cada bodega visitada. Ahora también trae si
-- la bodega reparte a domicilio, cuánto cobra de envío y el pedido mínimo, para
-- mostrar en cada tarjeta las dos modalidades (Retiro gratis / Delivery con su
-- costo). Son datos que la bodega ya tiene configurados (migration_33) y que la
-- vista bodegas_delivery ya expone: no se abre nada nuevo.
--
-- Es un cambio de forma de retorno, por eso se borra y se vuelve a crear la
-- función. No toca datos. Mientras no se corra, la app sigue funcionando igual
-- y simplemente no muestra las casillas de entrega.

drop function if exists public.obtener_nombres_bodegas(uuid[]);

create function public.obtener_nombres_bodegas(p_ids uuid[])
returns table (
  bodega_id uuid,
  nombre text,
  slug text,
  logo_url text,
  direccion text,
  horario_atencion jsonb,
  delivery_domicilio boolean,
  costo_envio numeric,
  pedido_minimo numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, nombre, slug, logo_url, direccion, horario_atencion,
         delivery_domicilio, costo_envio, pedido_minimo
  from bodegas_delivery
  where bodega_id = any(p_ids);
$$;

revoke all on function public.obtener_nombres_bodegas(uuid[]) from public, anon;
grant execute on function public.obtener_nombres_bodegas(uuid[]) to authenticated;

NOTIFY pgrst, 'reload schema';
