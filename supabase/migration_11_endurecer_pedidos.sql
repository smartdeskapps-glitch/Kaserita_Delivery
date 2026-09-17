-- KaseritaDelivery — endurece validar_pedido_delivery tras la auditoría del 2026-09-17.
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Hallazgos (todos probados en vivo con la anon key pública):
--
-- 1. El límite anti-spam de migration_08 se evadía mandando un header
--    X-Forwarded-For inventado: el trigger tomaba la PRIMERA IP de la
--    cadena, que es justamente la que el cliente puede escribir. Con el
--    6to pedido bloqueado, el 7mo con "X-Forwarded-For: 203.0.113.77"
--    entró como si nada. Ahora se usa cf-connecting-ip (Supabase corre
--    detrás de Cloudflare, que pisa ese header con la IP real y no deja
--    que el cliente lo falsifique) y, si no está, la ÚLTIMA IP de
--    x-forwarded-for (la que agrega el proxy, no la que manda el cliente).
--    Además, si no hay ninguna IP, ya no se exime del límite: cae en un
--    balde compartido "desconocida" que también se limita.
--
-- 2. creado_en y usado los podía fijar el cliente. Un pedido con creado_en
--    de hace 3 horas entraba (201) y nacía "abandonado": borrable por
--    cualquiera al instante y sin contar para el límite de 10 minutos.
--    Con usado=true nunca se limpiaría. Ahora el trigger los pisa siempre.
--
-- 3. items no tenía tope de largo: 300 líneas repetidas entraron en 1.4 s
--    (una consulta a productos por cada línea). Con 10.000 líneas es un
--    DoS barato contra la base. Tope: 50 líneas.
--
-- 4. codigo_corto no tenía formato ni largo: entró uno de 2000 caracteres.
--    Ahora tiene que ser 4 a 12 caracteres A-Z/0-9 (la vitrina genera 6).

create or replace function public.validar_pedido_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
  v_item jsonb;
  v_producto record;
  v_cantidad numeric;
  v_headers json;
  v_xff text;
  v_ip text;
  v_pedidos_recientes int;
begin
  -- Nada de esto lo decide el cliente.
  new.creado_en := now();
  new.usado := false;

  v_headers := coalesce(current_setting('request.headers', true), '{}')::json;
  v_xff := v_headers->>'x-forwarded-for';
  v_ip := coalesce(
    nullif(trim(v_headers->>'cf-connecting-ip'), ''),
    nullif(trim(split_part(v_xff, ',', -1)), ''),
    'desconocida'
  );

  select count(*) into v_pedidos_recientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and ip_origen = v_ip
      and creado_en > now() - interval '10 minutes';

  if v_pedidos_recientes >= 5 then
    raise exception 'Demasiados pedidos seguidos. Esperá unos minutos e intentá de nuevo.';
  end if;

  if new.codigo_corto is null or new.codigo_corto !~ '^[A-Z0-9]{4,12}$' then
    raise exception 'Código de pedido inválido.';
  end if;

  if jsonb_typeof(new.items) is distinct from 'array' or jsonb_array_length(new.items) = 0 then
    raise exception 'El pedido no tiene productos.';
  end if;

  if jsonb_array_length(new.items) > 50 then
    raise exception 'El pedido tiene demasiados productos distintos (máximo 50).';
  end if;

  v_items := '[]'::jsonb;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_cantidad := (v_item->>'cantidad')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_cantidad > 9999 then
      raise exception 'Cantidad inválida en el pedido.';
    end if;

    select id, descripcion, precio_venta into v_producto
      from productos
      where id = (v_item->>'id')::uuid
        and bodega_id = new.bodega_id;

    if v_producto.id is null then
      raise exception 'Uno de los productos del pedido ya no existe en esta bodega.';
    end if;

    -- Se reconstruye el item entero con los datos reales del producto --
    -- nunca se confía en descripcion/precio_venta que mandó el cliente.
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', v_producto.id,
      'descripcion', v_producto.descripcion,
      'precio_venta', v_producto.precio_venta,
      'cantidad', v_cantidad
    ));
  end loop;

  new.items := v_items;
  new.ip_origen := v_ip;
  return new;
end;
$$;

drop trigger if exists validar_pedido_delivery_trigger on pedidos_delivery;
create trigger validar_pedido_delivery_trigger
  before insert on pedidos_delivery
  for each row
  execute function public.validar_pedido_delivery();
