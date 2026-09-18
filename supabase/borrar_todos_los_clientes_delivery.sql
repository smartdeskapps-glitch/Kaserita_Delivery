-- KaseritaDelivery — borra TODAS las cuentas de cliente (irreversible).
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Ojo: esto borra cuentas, historial de pedidos y tiendas guardadas de
-- TODOS los clientes que hayan usado la vitrina, de prueba o reales.
-- No toca bodegas ni usuarios del POS (cajeros/dueños) -- el filtro por
-- 'cliente_%@kaserita.app' en auth.users es justamente para no tocarlos.

-- Paso 0 (opcional): ver cuántas cuentas hay antes de borrar, para tener
-- una referencia de lo que se está por eliminar.
select count(*) as cuentas_a_borrar from clientes_delivery;

-- Paso 1: todo lo que referencia clientes_delivery.id, hay que borrarlo
-- antes que la cuenta -- historial, tiendas visitadas, y cualquier pedido
-- todavía sin reclamar por la bodega (el puente efímero pedidos_delivery,
-- que normalmente se autolimpia a las 2 horas, pero si hay uno reciente
-- todavía existe). Solo se tocan los que tienen cliente_id asignado --
-- los pedidos de invitados sin cuenta (cliente_id null) no se tocan.
delete from pedidos_seguimiento;
delete from bodegas_visitadas;
delete from pedidos_delivery where cliente_id is not null;

-- Paso 2: las cuentas de cliente en sí.
delete from clientes_delivery;

-- Paso 3: los usuarios de autenticación asociados (sin esto, el celular
-- queda "ocupado" en auth.users y esa persona no podría volver a
-- registrarse con el mismo número).
delete from auth.users where email like 'cliente_%@kaserita.app';

-- Opcional: limpiar también el log de intentos de "olvidé mi PIN"
-- (no es necesario para el borrado, es solo prolijidad).
-- delete from reseteos_pin;

-- Verificación: debería devolver 0.
select count(*) as cuentas_restantes from clientes_delivery;
