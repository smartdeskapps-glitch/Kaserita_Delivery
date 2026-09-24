-- KaseritaDelivery -- se eliminó la función "Avisame cuando vuelva el stock".
-- Ejecutar a mano en el SQL Editor de Supabase. Borra la tabla que creó
-- migration_27 y los avisos que hubiera guardados (irreversible, pero no
-- afecta pedidos, clientes ni productos).

drop table if exists public.avisos_reposicion;

NOTIFY pgrst, 'reload schema';
