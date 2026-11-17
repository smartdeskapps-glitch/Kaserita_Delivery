-- KaseritaDelivery -- la limpieza de pedidos abandonados pasa del celular al servidor.
-- (auditoría 2026-11-17)
--
-- Problema: la política "limpieza de pedidos_delivery abandonados" dejaba que CUALQUIER
-- visitante sin sesión (rol anon) borrara los pedidos sin usar de más de 2 horas, y cada
-- celular lo ejecutaba al abrir la app. Un pedido que la tienda no atendió en 2 horas
-- desaparecía de "Pedidos por retirar" por obra de cualquiera.
--
-- Ahora: la misma regla (sin usar y de más de 2 horas) la aplica el servidor cada 30
-- minutos con pg_cron y el rol anon ya no puede borrar nada. La app deja de pedir el
-- borrado (ver src/main.jsx).
--
-- REVERSA:
--   select cron.unschedule('kaserita_limpiar_pedidos_abandonados');
--   drop function if exists public.limpiar_pedidos_abandonados();
--   create policy "limpieza de pedidos_delivery abandonados" on public.pedidos_delivery
--     for delete to anon using (usado = false and creado_en < now() - interval '2 hours');

create or replace function public.limpiar_pedidos_abandonados()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.pedidos_delivery
   where usado = false
     and creado_en < now() - interval '2 hours';
end;
$$;

revoke all on function public.limpiar_pedidos_abandonados() from public, anon, authenticated;

select cron.schedule(
  'kaserita_limpiar_pedidos_abandonados',
  '*/30 * * * *',
  $$select public.limpiar_pedidos_abandonados()$$
);

drop policy if exists "limpieza de pedidos_delivery abandonados" on public.pedidos_delivery;
