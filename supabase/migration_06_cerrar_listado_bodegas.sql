-- KaseritaDelivery — cerrar el listado completo de bodegas_delivery.
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Hallazgo: anon tenía SELECT directo sobre la vista bodegas_delivery, así
-- que cualquiera con la anon key (pública) podía pedir bodegas_delivery
-- sin filtro y bajarse la lista completa de bodegas con delivery
-- habilitado (nombre + teléfono), no solo la de un slug que ya conocía por
-- su link. Esto reemplaza el acceso directo por una función que exige el
-- slug exacto -- solo se puede consultar una bodega a la vez, nunca
-- listarlas todas.

revoke select on public.bodegas_delivery from anon;

create or replace function public.obtener_bodega_delivery(p_slug text)
returns table (bodega_id uuid, slug text, nombre text, telefono text)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, slug, nombre, telefono
  from bodegas_delivery
  where slug = p_slug;
$$;

grant execute on function public.obtener_bodega_delivery(text) to anon;
