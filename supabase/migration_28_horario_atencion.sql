-- KaseritaDelivery — horario de atención de la bodega ("Abierto ahora" /
-- "Cerrado" en la vitrina). Ejecutar a mano en el SQL Editor de Supabase,
-- después de migration_27.
--
-- Por qué un horario configurado en vez de mirar turnos_caja (si el
-- cajero tiene el turno abierto en Kaserita ahora mismo): un turno
-- abierto/cerrado depende de que alguien se acuerde de cerrarlo -- si se
-- olvida, la vitrina diría "Abierto" a las 3am aunque no haya nadie. Un
-- horario fijo por día de la semana, cargado una sola vez, es más
-- predecible para el cliente (mismo criterio que usa cualquier app de
-- delivery). null = el dueño no lo configuró todavía -- ahí la vitrina no
-- muestra ningún indicador (ni abierto ni cerrado), no bloquea pedidos.
--
-- Forma del JSON (horario_atencion), un objeto por día de la semana
-- (0=domingo ... 6=sábado, igual que Date.getDay() en JS):
--   { "1": { "abierto": true, "desde": "08:00", "hasta": "21:00" }, ... }

alter table public.bodegas
  add column if not exists horario_atencion jsonb;

-- bodegas_delivery: se agrega horario_atencion al final (create or
-- replace view no deja reordenar columnas existentes, solo agregar).
create or replace view public.bodegas_delivery
with (security_invoker = true) as
select
  b.id as bodega_id,
  b.slug,
  b.nombre,
  u.telefono,
  b.logo_url,
  b.banner_url,
  b.direccion,
  b.horario_atencion
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
returns table (
  bodega_id uuid,
  slug text,
  nombre text,
  telefono text,
  logo_url text,
  banner_url text,
  direccion text,
  horario_atencion jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, slug, nombre, telefono, logo_url, banner_url, direccion, horario_atencion
  from bodegas_delivery
  where slug = p_slug;
$$;

grant execute on function public.obtener_bodega_delivery(text) to anon;
grant execute on function public.obtener_bodega_delivery(text) to authenticated;

-- actualizar_mi_delivery (repo Kaserita / POS) -- se le agrega
-- p_horario_atencion para que el dueño lo pueda guardar desde "Mi Link de
-- Pedidos" junto con logo/dirección.
-- Se dropean las dos firmas posibles (la vieja de 5 parámetros, y la
-- nueva de 6 por si esta migración ya se corrió parcialmente antes y
-- se está re-ejecutando) para que el script sea repetible sin el error
-- "function already exists with same argument types".
drop function if exists public.actualizar_mi_delivery(text, boolean, text, text, text);
drop function if exists public.actualizar_mi_delivery(text, boolean, text, text, text, jsonb);

create function public.actualizar_mi_delivery(
  p_slug text,
  p_delivery_habilitado boolean,
  p_logo_url text default null,
  p_banner_url text default null,
  p_direccion text default null,
  p_horario_atencion jsonb default null
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
        direccion = nullif(trim(p_direccion), ''),
        horario_atencion = p_horario_atencion
    where id = v_bodega_id;
end;
$$;

grant execute on function public.actualizar_mi_delivery(text, boolean, text, text, text, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
