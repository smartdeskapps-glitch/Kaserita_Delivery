-- ============================================================
-- Migración 41 (2026-10-12). Ejecutar todo de una vez en el SQL Editor.
-- Va dentro de una transacción e idempotente (se puede volver a correr).
--
-- Cerrar un pedido como "retirado" ("Confirmar retiro" en Pedidos por retirar,
-- o una venta cobrada) ahora libera su reserva de stock en el momento.
-- Antes solo cambiaba el estado del seguimiento: la fila de pedidos_delivery
-- seguía reservando stock hasta 2 horas, y como la venta ya había descontado
-- el stock real, la tienda online mostraba el producto descontado dos veces.
-- Es lo mismo que ya hace cancelar_seguimiento_pedido (migración 39).
-- ============================================================

begin;

create or replace function public.marcar_pedido_retirado(p_codigo_corto text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bodega uuid;
begin
  update pedidos_seguimiento
    set estado = 'retirado', actualizado_en = now()
    where codigo_corto = p_codigo_corto
      and bodega_id = mi_bodega_id()
      and estado in ('pendiente', 'listo', 'en_camino')
    returning bodega_id into v_bodega;
  if found then
    -- El pedido sin cobrar es lo que reserva el stock (stock_reservado_delivery).
    delete from pedidos_delivery
      where bodega_id = v_bodega and codigo_corto = p_codigo_corto and usado = false;
  end if;
end;
$$;

grant execute on function public.marcar_pedido_retirado(text) to authenticated;

-- Los que ya estaban retirados y todavía reservaban stock.
delete from public.pedidos_delivery p
  where p.usado = false
    and exists (
      select 1 from public.pedidos_seguimiento s
      where s.codigo_corto = p.codigo_corto
        and s.bodega_id = p.bodega_id
        and s.estado = 'retirado'
    );

commit;
