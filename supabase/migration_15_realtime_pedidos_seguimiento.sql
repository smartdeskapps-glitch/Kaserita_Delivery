-- KaseritaDelivery — habilita Realtime sobre pedidos_seguimiento.
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_14.
--
-- Para qué: el POS (Kaserita) se suscribe a esta tabla para sonar un aviso
-- apenas entra un pedido nuevo, sin tener que refrescar. Supabase Realtime
-- respeta la RLS que ya existe ("bodega lee su seguimiento" -- bodega_id =
-- mi_bodega_id()): cada bodega solo recibe el evento de sus propios
-- pedidos, ninguna bodega ve los pedidos de otra. No hace falta tocar
-- ninguna política, solo agregar la tabla a la publicación de Realtime.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pedidos_seguimiento'
  ) then
    alter publication supabase_realtime add table public.pedidos_seguimiento;
  end if;
end $$;
