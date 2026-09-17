-- KaseritaDelivery — mostrar la cantidad exacta disponible (decisión del
-- dueño: en vez de ocultar el número, se prefiere mostrarlo siempre y
-- sacar el producto de la vitrina apenas llega a 0).
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_12.
--
-- Reemplaza hay_stock (boolean) por stock_disponible (numeric): stock_actual
-- del producto menos lo que ya está pedido y pendiente de cargar (misma
-- lógica de reserva de migration_12, sin tocarla). NULL sigue significando
-- "la bodega no lleva stock de este producto" -> no se muestra número y
-- nunca se oculta por stock.

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
  descripcion_larga text
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
         pd.fotos_extra, pd.descripcion_larga
  from productos_delivery pd
  join bodegas b on b.id = pd.bodega_id
  where b.slug = p_slug;
$$;

grant execute on function public.obtener_productos_delivery(text) to anon;
