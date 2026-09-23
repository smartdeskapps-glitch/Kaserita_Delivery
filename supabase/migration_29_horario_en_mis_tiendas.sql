-- KaseritaDelivery — expone horario_atencion en "Mis tiendas".
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_28.
--
-- "Mis tiendas" (PantallaMisTiendas) usa obtener_nombres_bodegas para
-- traer nombre/logo/dirección de cada bodega visitada -- le faltaba el
-- horario para poder mostrar "Abierto ahora" / "Cerrado" igual que ya
-- hace el catálogo de cada bodega individual (ver migration_28).

drop function if exists public.obtener_nombres_bodegas(uuid[]);

create function public.obtener_nombres_bodegas(p_ids uuid[])
returns table (bodega_id uuid, nombre text, slug text, logo_url text, direccion text, horario_atencion jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, nombre, slug, logo_url, direccion, horario_atencion
  from bodegas_delivery
  where bodega_id = any(p_ids);
$$;

grant execute on function public.obtener_nombres_bodegas(uuid[]) to authenticated;

NOTIFY pgrst, 'reload schema';
