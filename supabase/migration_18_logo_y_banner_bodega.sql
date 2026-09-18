-- KaseritaDelivery — logo y foto de portada por bodega.
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_16.
--
-- Para qué: la vitrina mostraba un header de solo texto (nombre + una
-- línea). Se agrega logo_url/banner_url a bodegas para poder mostrar un
-- header estilo "app de delivery" (foto de portada + logo redondo
-- superpuesto), subidos por el dueño desde el POS (Kaserita) en "Mi Link
-- de Pedidos". Ambos son opcionales -- sin ellos la vitrina cae a un
-- degradado + la inicial del nombre, no se rompe nada.

alter table public.bodegas
  add column if not exists logo_url text,
  add column if not exists banner_url text;

-- bodegas_delivery: mismo gate de siempre (delivery_habilitado +
-- delivery_permitido), solo se agregan las dos columnas nuevas. Van
-- DESPUÉS de telefono (no antes) porque create or replace view no deja
-- cambiar la posición de una columna existente, solo agregar al final.
create or replace view public.bodegas_delivery
with (security_invoker = false) as
select
  b.id as bodega_id,
  b.slug,
  b.nombre,
  u.telefono,
  b.logo_url,
  b.banner_url
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

create or replace function public.obtener_bodega_delivery(p_slug text)
returns table (bodega_id uuid, slug text, nombre text, telefono text, logo_url text, banner_url text)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, slug, nombre, telefono, logo_url, banner_url
  from bodegas_delivery
  where slug = p_slug;
$$;

grant execute on function public.obtener_bodega_delivery(text) to anon;

-- "Mis tiendas" también puede mostrar el logo de cada bodega visitada.
create or replace function public.obtener_nombres_bodegas(p_ids uuid[])
returns table (bodega_id uuid, nombre text, slug text, logo_url text)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, nombre, slug, logo_url
  from bodegas_delivery
  where bodega_id = any(p_ids);
$$;

grant execute on function public.obtener_nombres_bodegas(uuid[]) to authenticated;

-- ============================================================
-- actualizar_mi_delivery (repo Kaserita / POS) -- mismo proyecto de
-- Supabase, se ejecuta acá mismo. Se le agregan p_logo_url/p_banner_url
-- para que el dueño los pueda guardar desde "Mi Link de Pedidos". Se
-- borra la versión vieja de 2 parámetros para no dejar dos funciones
-- sobrecargadas con el mismo nombre.
-- ============================================================

drop function if exists public.actualizar_mi_delivery(text, boolean);

create or replace function public.actualizar_mi_delivery(
  p_slug text,
  p_delivery_habilitado boolean,
  p_logo_url text default null,
  p_banner_url text default null
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
        banner_url = p_banner_url
    where id = v_bodega_id;
end;
$$;

grant execute on function public.actualizar_mi_delivery(text, boolean, text, text) to authenticated;

NOTIFY pgrst, 'reload schema';
