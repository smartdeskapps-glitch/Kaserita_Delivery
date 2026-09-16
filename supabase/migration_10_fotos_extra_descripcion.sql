-- KaseritaDelivery — expone fotos_extra y descripcion_larga en la vitrina.
-- Ejecutar a mano en el SQL Editor de Supabase, DESPUÉS de que en el repo
-- Kaserita se corra producto_fotos_extra.sql (agrega esas dos columnas a
-- la tabla productos). Pensado para negocios que necesitan mostrar más
-- que una sola foto (ej. ropa).
--
-- Nota: las columnas nuevas van AL FINAL del select, no en el medio --
-- CREATE OR REPLACE VIEW de Postgres no permite insertar una columna
-- entre dos existentes, solo agregar al final (si no, tira "cannot change
-- name of view column").

create or replace view public.productos_delivery
with (security_invoker = false) as
select
  p.id,
  p.bodega_id,
  p.descripcion,
  p.categoria,
  coalesce(cm.foto_url, p.foto_url) as foto_url,
  p.precio_venta,
  p.stock_actual,
  p.fotos_extra,
  p.descripcion_larga
from productos p
join bodegas b on b.id = p.bodega_id
left join catalogo_maestro cm on cm.id = p.catalogo_maestro_id
where b.delivery_habilitado = true
  and b.delivery_permitido = true;

-- create or replace no alcanza cuando cambia la forma de "returns table";
-- hay que borrarla primero.
drop function if exists public.obtener_productos_delivery(text);

create function public.obtener_productos_delivery(p_slug text)
returns table (
  id uuid,
  bodega_id uuid,
  descripcion text,
  categoria text,
  foto_url text,
  precio_venta numeric,
  stock_actual numeric,
  fotos_extra text[],
  descripcion_larga text
)
language sql
stable
security definer
set search_path = public
as $$
  select pd.id, pd.bodega_id, pd.descripcion, pd.categoria, pd.foto_url, pd.precio_venta, pd.stock_actual, pd.fotos_extra, pd.descripcion_larga
  from productos_delivery pd
  join bodegas b on b.id = pd.bodega_id
  where b.slug = p_slug;
$$;

grant execute on function public.obtener_productos_delivery(text) to anon;
