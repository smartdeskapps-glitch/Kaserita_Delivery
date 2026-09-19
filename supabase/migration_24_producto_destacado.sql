-- KaseritaDelivery + Kaserita (POS) — permite al dueño elegir a mano qué
-- producto se destaca en la tarjeta principal ("hero") de su tienda online,
-- en vez de que siempre sea el primero en orden alfabético con foto (el
-- comportamiento anterior, ver useMemo de productoDestacado en
-- KaseritaDelivery/index.html). Ejecutar a mano en el SQL Editor de
-- Supabase, después de migration_23.
--
-- Solo puede haber UN producto destacado por bodega -- eso se garantiza
-- desde la app (Kaserita/index.html, guardarEdicionProducto: al marcar
-- uno, se desmarca cualquier otro de la misma bodega antes de guardar), no
-- con una restricción de base de datos, para no bloquear al dueño con un
-- error de "unique constraint" si algo queda inconsistente.

alter table public.productos
  add column if not exists es_destacado boolean not null default false;

-- La vista y la función de abajo ya existían (ver migration_22 y
-- migration_13) -- se recrean completas, solo sumando es_destacado, para no
-- perder ninguna columna que ya devolvían. drop + create (no "or replace")
-- en la función porque cambia la firma de su tabla de retorno, igual que en
-- las migraciones anteriores que la tocaron.

create or replace view public.productos_delivery
with (security_invoker = true) as
select
  p.id,
  p.bodega_id,
  p.descripcion,
  p.categoria,
  coalesce(cm.foto_url, p.foto_url) as foto_url,
  p.precio_venta,
  p.stock_actual,
  p.fotos_extra,
  p.descripcion_larga,
  p.es_destacado
from productos p
join bodegas b on b.id = p.bodega_id
left join catalogo_maestro cm on cm.id = p.catalogo_maestro_id
where b.delivery_habilitado = true
  and b.delivery_permitido = true;

drop function if exists public.obtener_productos_delivery(text);

create function public.obtener_productos_delivery(p_slug text)
returns table (
  id uuid,
  bodega_id uuid,
  descripcion text,
  categoria text,
  foto_url text,
  precio_venta numeric,
  stock_disponible numeric,
  fotos_extra text[],
  descripcion_larga text,
  es_destacado boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select pd.id, pd.bodega_id, pd.descripcion, pd.categoria, pd.foto_url, pd.precio_venta,
         case
           when pd.stock_actual is null then null
           else greatest(pd.stock_actual - stock_reservado_delivery(pd.bodega_id, pd.id), 0)
         end as stock_disponible,
         pd.fotos_extra, pd.descripcion_larga, pd.es_destacado
  from productos_delivery pd
  join bodegas b on b.id = pd.bodega_id
  where b.slug = p_slug;
$$;

-- drop function borra también sus grants -- y desde migration_23 las
-- funciones nuevas ya no reciben EXECUTE de PUBLIC por defecto, así que
-- hay que devolvérselos a mano a los dos roles que ya la usaban.
grant execute on function public.obtener_productos_delivery(text) to anon;
grant execute on function public.obtener_productos_delivery(text) to authenticated;

NOTIFY pgrst, 'reload schema';
