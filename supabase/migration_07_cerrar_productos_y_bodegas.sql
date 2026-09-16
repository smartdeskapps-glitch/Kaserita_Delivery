-- KaseritaDelivery — cerrar dos fugas de datos encontradas en auditoría con la anon key.
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Hallazgo 1 (productos_delivery): igual que bodegas_delivery antes de
-- migration_06, anon tenía SELECT directo sobre la vista productos_delivery
-- SIN filtro por bodega. La vitrina siempre filtraba por bodega_id en el
-- navegador, pero nada impedía pedir la vista entera por la API REST y
-- bajarse el catálogo completo (descripción, categoría, precio, stock) de
-- TODAS las bodegas con delivery habilitado en una sola consulta, no solo
-- la del link que uno conoce. Probado en vivo: hoy son pocas filas porque
-- solo una bodega tiene delivery activo, pero escala con cada bodega nueva
-- que lo prenda. Se cierra igual que bodegas_delivery: se revoca el acceso
-- directo y se reemplaza por una función que exige el slug exacto.
--
-- Hallazgo 2 (bodegas): la tabla base "bodegas" (no la vista) tenía SELECT
-- abierto para anon. Se pudo confirmar en vivo que con la anon key pública
-- se lee la tabla ENTERA sin filtro: nombre, activa, activa_hasta (fecha de
-- vencimiento de la suscripción) y los flags internos, de TODAS las
-- bodegas del sistema -- no solo las que tienen delivery. Esto es previo a
-- KaseritaDelivery (la tabla nunca tuvo este grant revocado en Kaserita),
-- pero nadie lo había notado porque la anon key nunca había estado expuesta
-- en una página pública hasta ahora. No afecta el acceso desde el POS: ahí
-- se usa el rol authenticated, que tiene sus propias políticas y sigue
-- intacto.
--
-- Nota: se probó también escribir (INSERT/UPDATE/DELETE) directo en
-- bodegas y productos con la anon key -- todo bloqueado correctamente por
-- las políticas RLS existentes. El problema encontrado es solo de LECTURA.

revoke select on public.productos_delivery from anon;

create or replace function public.obtener_productos_delivery(p_slug text)
returns table (
  id uuid,
  bodega_id uuid,
  descripcion text,
  categoria text,
  foto_url text,
  precio_venta numeric,
  stock_actual numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select pd.id, pd.bodega_id, pd.descripcion, pd.categoria, pd.foto_url, pd.precio_venta, pd.stock_actual
  from productos_delivery pd
  join bodegas b on b.id = pd.bodega_id
  where b.slug = p_slug;
$$;

grant execute on function public.obtener_productos_delivery(text) to anon;

revoke select on public.bodegas from anon;

-- Defensa adicional: productos y usuarios ya estaban bien protegidas (se
-- probó SELECT directo con anon y devolvió vacío), pero se revoca el grant
-- explícitamente por si alguna vez existió sin que una política RLS lo
-- estuviera tapando.
revoke select on public.productos from anon;
revoke select on public.usuarios from anon;
