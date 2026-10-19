-- ============================================================
-- Migración 43 (2026-10-19): la tienda ya no muestra productos inactivos y
-- se puede esconder un producto de la tienda sin desactivarlo.
-- Ejecutar todo de una vez en el SQL Editor.
--
-- 1) Antes: "Eliminar producto" en el POS lo marca activo = false, pero la
--    lista pública (productos_delivery) no filtraba por activo, así que un
--    producto eliminado seguía viéndose y pidiéndose en la tienda.
--    Ahora la lista solo trae productos activos.
-- 2) productos.visible_en_tienda (por defecto true): permite esconder un
--    producto de la tienda online sin desactivarlo. Sirve para insumos que
--    forman parte de un combo (ej. el tinte del combo "Tinte completo"):
--    desactivarlos apagaría el combo, esconderlos no.
-- 3) Un pedido que incluya un producto inactivo u oculto se rechaza (antes
--    solo se revisaba que existiera y que alcanzara el stock). Es un
--    disparador aparte; validar_pedido_delivery no se toca.
-- ============================================================

alter table public.productos add column if not exists visible_en_tienda boolean not null default true;

create or replace view public.productos_delivery as
 select p.id,
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
  where b.delivery_habilitado = true and b.delivery_permitido = true and b.activa = true
    and (b.activa_hasta is null or b.activa_hasta >= current_date)
    and p.activo = true
    and p.visible_en_tienda = true;

alter view public.productos_delivery set (security_invoker = true);

create or replace function public.validar_productos_activos_pedido()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if exists (
    select 1
    from jsonb_array_elements(new.items) as it
    where it ? 'id'
      and exists (
        select 1 from productos p
        where p.id = (it->>'id')::uuid
          and p.bodega_id = new.bodega_id
          and (p.activo is not true or p.visible_en_tienda is not true)
      )
  ) then
    raise exception 'Uno de los productos del pedido ya no está disponible.';
  end if;
  return new;
end;
$$;

drop trigger if exists validar_productos_activos_trigger on public.pedidos_delivery;
create trigger validar_productos_activos_trigger
before insert on public.pedidos_delivery
for each row
when (jsonb_typeof(new.items) = 'array')
execute function public.validar_productos_activos_pedido();

notify pgrst, 'reload schema';
