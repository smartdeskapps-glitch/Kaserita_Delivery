-- KaseritaDelivery — limpieza de pedidos_delivery.
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration.sql.
--
-- Antes: los pedidos se quedaban para siempre en la tabla (los atendidos
-- quedaban marcados usado=true, los abandonados no se tocaban nunca).
-- Ahora:
--   - Un pedido atendido se borra directo desde el POS al cargarlo
--     (ver cargarPedidoPorCodigo en Kaserita/index.html) -- por eso el POS
--     necesita poder borrar sus propios pedidos.
--   - Un pedido abandonado (nadie lo reclamó) se borra solo a las 2 horas,
--     aprovechando el tráfico normal de la vitrina pública (ver el efecto
--     de limpieza en index.html de este repo) -- no hace falta pg_cron ni
--     ningún proceso aparte.

-- La bodega dueña (cualquier cajero autenticado de esa bodega) puede borrar
-- sus propios pedidos -- tanto al cargarlos como al rechazar uno a mano.
create policy "la bodega dueña puede borrar sus pedidos_delivery"
  on pedidos_delivery for delete
  to authenticated
  using (
    exists (
      select 1 from usuarios
      where usuarios.auth_id = auth.uid()
        and usuarios.bodega_id = pedidos_delivery.bodega_id
    )
  );

-- Cualquiera (anon, sin login -- es la vitrina pública) puede borrar
-- pedidos sin usar de más de 2 horas, de cualquier bodega. No expone ni
-- filtra nada: solo permite borrar filas ya abandonadas.
create policy "limpieza de pedidos_delivery abandonados"
  on pedidos_delivery for delete
  to anon
  using (usado = false and creado_en < now() - interval '2 hours');
