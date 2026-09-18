-- KaseritaDelivery — dirección física de la bodega.
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_18.
--
-- Para qué: el cliente no sabía dónde queda la bodega a la que le está
-- pidiendo (solo veía el nombre). Se agrega una dirección de texto libre
-- que carga el dueño desde el POS (igual que logo/banner), opcional -- si
-- no la carga, la vitrina y "Mis tiendas" simplemente no muestran esa línea.

alter table public.bodegas
  add column if not exists direccion text;

-- bodegas_delivery: se agrega direccion al final (create or replace view
-- no deja reordenar columnas existentes, solo agregar).
create or replace view public.bodegas_delivery
with (security_invoker = false) as
select
  b.id as bodega_id,
  b.slug,
  b.nombre,
  u.telefono,
  b.logo_url,
  b.banner_url,
  b.direccion
from bodegas b
left join lateral (
  select telefono
  from usuarios
  where usuarios.bodega_id = b.id
    and usuarios.rol = 'dueno'
    and usuarios.telefono is not null
  limit 1
) u on true
where b.delivery_habilitado = true
  and b.delivery_permitido = true
  and b.slug is not null;

drop function if exists public.obtener_bodega_delivery(text);

create function public.obtener_bodega_delivery(p_slug text)
returns table (bodega_id uuid, slug text, nombre text, telefono text, logo_url text, banner_url text, direccion text)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, slug, nombre, telefono, logo_url, banner_url, direccion
  from bodegas_delivery
  where slug = p_slug;
$$;

grant execute on function public.obtener_bodega_delivery(text) to anon;

-- "Mis tiendas" también muestra la dirección de cada bodega visitada.
drop function if exists public.obtener_nombres_bodegas(uuid[]);

create function public.obtener_nombres_bodegas(p_ids uuid[])
returns table (bodega_id uuid, nombre text, slug text, logo_url text, direccion text)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, nombre, slug, logo_url, direccion
  from bodegas_delivery
  where bodega_id = any(p_ids);
$$;

grant execute on function public.obtener_nombres_bodegas(uuid[]) to authenticated;

-- ============================================================
-- actualizar_mi_delivery (repo Kaserita / POS) -- se le agrega
-- p_direccion para que el dueño la pueda guardar desde "Mi Link de
-- Pedidos" junto con logo/portada.
-- ============================================================

drop function if exists public.actualizar_mi_delivery(text, boolean, text, text);

create or replace function public.actualizar_mi_delivery(
  p_slug text,
  p_delivery_habilitado boolean,
  p_logo_url text default null,
  p_banner_url text default null,
  p_direccion text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bodega_id uuid;
  v_permitido boolean;
begin
  select bodega_id into v_bodega_id from usuarios where auth_id = auth.uid();
  if v_bodega_id is null then
    raise exception 'No autorizado.';
  end if;

  select delivery_permitido into v_permitido from bodegas where id = v_bodega_id;

  if p_delivery_habilitado and not coalesce(v_permitido, false) then
    raise exception 'Esta bodega todavía no tiene habilitados los Pedidos por WhatsApp. Contactá al administrador.';
  end if;

  update bodegas
    set slug = nullif(trim(p_slug), ''),
        delivery_habilitado = p_delivery_habilitado,
        logo_url = p_logo_url,
        banner_url = p_banner_url,
        direccion = nullif(trim(p_direccion), '')
    where id = v_bodega_id;
end;
$$;

grant execute on function public.actualizar_mi_delivery(text, boolean, text, text, text) to authenticated;

NOTIFY pgrst, 'reload schema';
