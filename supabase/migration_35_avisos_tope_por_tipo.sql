-- KaseritaDelivery -- el tope de avisos automaticos pasa a ser POR TIPO.
-- Ejecutar a mano en el SQL Editor de Supabase, despues de migration_34.
--
-- Antes: 1 aviso automatico por bodega cada 7 dias, sin importar el tipo.
-- Eso hacia que avisar "ya recibe pedidos" bloqueara el aviso posterior de
-- "ya cuenta con delivery" (y al reves). Ahora cada tipo tiene su propio
-- tope de 7 dias.
--
-- Es idempotente: se puede correr mas de una vez.

create or replace function public.bodega_avisar_novedad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo text;
  v_audiencia integer;
begin
  if not (new.delivery_habilitado and new.delivery_permitido) then
    return null;
  end if;

  if not coalesce(old.delivery_habilitado, false) then
    v_tipo := 'reactivada';
  elsif new.delivery_domicilio and not coalesce(old.delivery_domicilio, false) then
    v_tipo := 'domicilio';
  else
    return null;
  end if;

  -- Tope: un aviso automatico de este tipo por bodega cada 7 dias.
  if exists (
    select 1 from avisos_tienda
    where bodega_id = new.id and origen = 'automatico' and tipo = v_tipo
      and creado_en > now() - interval '7 days'
  ) then
    return null;
  end if;

  select count(*) into v_audiencia
    from bodegas_visitadas bv
    join clientes_delivery c on c.id = bv.cliente_id
    where bv.bodega_id = new.id and bv.avisos and c.push_subscription is not null;

  if v_audiencia = 0 then
    return null;
  end if;

  insert into avisos_tienda (bodega_id, tipo, origen) values (new.id, v_tipo, 'automatico');
  return null;
end;
$$;

NOTIFY pgrst, 'reload schema';
