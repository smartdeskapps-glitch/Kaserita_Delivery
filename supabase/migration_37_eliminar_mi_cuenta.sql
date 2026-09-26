-- KaseritaDelivery — que el cliente pueda eliminar su propia cuenta.
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_36.
--
-- Las tiendas de aplicaciones y la ley de proteccion de datos piden que una
-- persona pueda borrar su cuenta y sus datos sin tener que escribir a soporte.
-- Esta funcion la llama el boton "Eliminar mi cuenta" del Perfil de Delivery.
--
-- Que hace (todo en una sola transaccion: o se borra todo o no se borra nada):
--   1) Borra los pedidos temporales (pedidos_delivery) del cliente.
--   2) Borra su historial de seguimiento (pedidos_seguimiento).
--   3) Borra su ficha (clientes_delivery); las tiendas guardadas
--      (bodegas_visitadas) se borran solas por el ON DELETE CASCADE.
--   4) Borra su usuario de acceso (auth.users), con lo que se cierran todas
--      sus sesiones.
--
-- Resguardos:
--   - Solo borra LA cuenta de quien la llama (auth.uid()); no recibe ningun id.
--   - Si el usuario pertenece a una bodega (dueno o cajero del POS, tabla
--     usuarios), NO se elimina desde aqui: esas cuentas se manejan aparte.
--   - Si el cliente tiene un pedido en curso (pendiente, listo o en camino) se
--     rechaza, para no dejar a la bodega con un pedido sin cliente.
--   - Las ventas ya registradas por las bodegas (POS) no se tocan: son parte
--     de la contabilidad de cada negocio y no guardan datos de la cuenta.
--
-- SECURITY DEFINER porque borrar de auth.users no esta permitido a la app.

create or replace function public.eliminar_mi_cuenta()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_cliente uuid;
begin
  if v_uid is null then
    raise exception 'Tenés que iniciar sesión para eliminar tu cuenta.';
  end if;

  if exists (select 1 from public.usuarios where auth_id = v_uid) then
    raise exception 'Esta cuenta pertenece a una bodega y no se puede eliminar desde Delivery.';
  end if;

  select id into v_cliente from public.clientes_delivery where auth_id = v_uid;

  if v_cliente is not null then
    if exists (
      select 1 from public.pedidos_seguimiento
      where cliente_id = v_cliente and estado in ('pendiente', 'listo', 'en_camino')
    ) then
      raise exception 'Tenés un pedido en curso. Esperá a que termine (o cancelalo) antes de eliminar tu cuenta.';
    end if;

    delete from public.pedidos_delivery where cliente_id = v_cliente;
    delete from public.pedidos_seguimiento where cliente_id = v_cliente;
    delete from public.clientes_delivery where id = v_cliente;
  end if;

  delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.eliminar_mi_cuenta() from public, anon;
grant execute on function public.eliminar_mi_cuenta() to authenticated;

NOTIFY pgrst, 'reload schema';
