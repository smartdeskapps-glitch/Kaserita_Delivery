-- ============================================================
-- Migración 46 (2026-10-19): ajustar la duración de una cita ya reservada.
-- Ejecutar todo de una vez en el SQL Editor.
--
-- El POS (Agenda de citas) permite alargar o acortar una cita, por ejemplo
-- cuando un tinte toma más tiempo. La función revisa que la bodega sea la de
-- la sesión, que la duración sea de 5 a 480 minutos (de 5 en 5) y que la cita
-- no choque con la siguiente del mismo barbero (lo garantiza la restricción
-- de exclusión de la tabla citas). También deja la duración nueva en el
-- seguimiento del pedido.
-- ============================================================

create or replace function public.ajustar_duracion_cita(p_cita uuid, p_minutos integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_bodega uuid := mi_bodega_id();
  v_seguimiento uuid;
begin
  if v_bodega is null then
    raise exception 'No se pudo ajustar la cita.';
  end if;
  if p_minutos is null or p_minutos < 5 or p_minutos > 480 or p_minutos % 5 <> 0 then
    raise exception 'La duración debe ser de 5 a 480 minutos, de 5 en 5.';
  end if;
  select seguimiento_id into v_seguimiento from citas where id = p_cita and bodega_id = v_bodega for update;
  if not found then
    raise exception 'No se encontró la cita.';
  end if;
  begin
    update citas set fin = inicio + make_interval(mins => p_minutos) where id = p_cita;
  exception when exclusion_violation then
    raise exception 'No se puede: choca con la siguiente cita de ese barbero.';
  end;
  update pedidos_seguimiento set cita_duracion_min = p_minutos where id = v_seguimiento;
end;
$$;

revoke execute on function public.ajustar_duracion_cita(uuid, integer) from public, anon;
grant execute on function public.ajustar_duracion_cita(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
