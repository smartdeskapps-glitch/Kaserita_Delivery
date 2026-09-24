-- KaseritaDelivery -- borra las cuentas de cliente que entraban con celular +
-- PIN (irreversible). Ejecutar a mano en el SQL Editor de Supabase.
--
-- Contexto: el ingreso con celular y PIN se eliminó (solo queda Google). Esas
-- cuentas tienen en auth.users un correo sintético "cliente_<celular>@kaserita.app";
-- las de Google tienen el correo real de la persona y NO se tocan. Tampoco se
-- tocan bodegas ni usuarios del POS.
--
-- Se borra, de esos clientes: cuenta, historial de pedidos, tiendas guardadas
-- y avisos de reposición. Los pedidos de invitados sin cuenta no se tocan.
--
-- PASO 1 (solo lectura): correr esto primero y revisar la lista.

select cd.nombre, cd.telefono, au.email,
       (select count(*) from pedidos_seguimiento s where s.cliente_id = cd.id) as pedidos
from clientes_delivery cd
join auth.users au on au.id = cd.auth_id
where au.email like 'cliente\_%@kaserita.app' escape '\'
order by cd.nombre;

-- PASO 2 (borra): correr esto solo después de revisar el paso 1.

do $$
declare
  v_ids uuid[];
  v_auth uuid[];
  v_huerfanos int;
begin
  select array_agg(cd.id), array_agg(cd.auth_id)
    into v_ids, v_auth
  from clientes_delivery cd
  join auth.users au on au.id = cd.auth_id
  where au.email like 'cliente\_%@kaserita.app' escape '\';

  if v_ids is not null then
    delete from pedidos_seguimiento where cliente_id = any(v_ids);
    delete from pedidos_delivery    where cliente_id = any(v_ids);
    delete from bodegas_visitadas   where cliente_id = any(v_ids);
    delete from clientes_delivery   where id = any(v_ids);
    delete from auth.users          where id = any(v_auth);
  end if;

  -- Usuarios de Auth con ese formato de correo que quedaron sin cliente
  -- (registro que falló a medias): también fuera, y el celular queda libre.
  delete from auth.users
  where email like 'cliente\_%@kaserita.app' escape '\'
    and not exists (select 1 from clientes_delivery c where c.auth_id = auth.users.id);
  get diagnostics v_huerfanos = row_count;

  raise notice 'Cuentas de celular+PIN borradas: %. Usuarios huerfanos borrados: %.',
    coalesce(array_length(v_ids, 1), 0), v_huerfanos;
end $$;

-- Registro de intentos de "olvidé mi PIN" (ya no se usa).
delete from reseteos_pin;

-- Verificación: las dos deberían dar 0.
select
  (select count(*) from auth.users where email like 'cliente\_%@kaserita.app' escape '\') as accesos_celular_pin_restantes,
  (select count(*) from clientes_delivery c join auth.users a on a.id = c.auth_id where a.email like 'cliente\_%@kaserita.app' escape '\') as clientes_pin_restantes;
