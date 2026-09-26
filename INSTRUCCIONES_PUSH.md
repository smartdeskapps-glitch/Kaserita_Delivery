# Activar las notificaciones push ("tu pedido está listo")

Todo el código ya está armado y probado. Faltan tres pasos manuales en el
Dashboard de Supabase -- ninguno es SQL, así que van en este archivo
aparte en vez de en `supabase/`. Se hacen una sola vez.

## 1. Guardar las claves VAPID como secretos

Estas son las claves que identifican a Kaserita Delivery ante los
navegadores para mandar notificaciones:

```
VAPID_PUBLIC_KEY=<la pública, la misma que está en src/main.jsx>
VAPID_PRIVATE_KEY=<la privada -- NUNCA se escribe en este repo, que es público>
```

La pública ya está en el código del frontend (`src/main.jsx`), no hace
falta tocarla. La privada **nunca va en el frontend ni en el repo** --
solo como secreto de la función:

1. Dashboard de Supabase → **Edge Functions** → **Secrets** (o **Project
   Settings → Edge Functions → Secrets**, según la versión del Dashboard).
2. Agregar `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`.
3. Agregar también `WEBHOOK_SECRET` con un texto largo y aleatorio (ver el
   paso 3: el Database Webhook lo manda en el header `x-webhook-secret` y
   las funciones rechazan cualquier llamada que no lo traiga -- sin esto,
   cualquiera con la anon key pública podría llamar a la función y mandar
   notificaciones falsas).

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` no hace falta configurarlos:
Supabase se los da automáticamente a toda función.

## 2. Desplegar la función

1. Dashboard de Supabase → **Edge Functions** → **New Function**.
2. Nombre exacto: `enviar-notificacion-pedido-listo` (el Database Webhook
   del paso 3 lo busca por este nombre).
3. Pegar el contenido completo de
   [`supabase/functions/enviar-notificacion-pedido-listo/index.ts`](supabase/functions/enviar-notificacion-pedido-listo/index.ts)
   de este repo.
4. Deploy.

## 3. Crear el Database Webhook

Esto es lo que hace que la función se dispare sola cuando la bodega marca
un pedido como "listo" -- no se puede crear por SQL Editor.

1. Dashboard de Supabase → **Database** → **Webhooks** → **Create a new
   webhook**.
2. Tabla: `pedidos_seguimiento`.
3. Eventos: solo **Update**.
4. Tipo: **Supabase Edge Functions**.
5. Función: `enviar-notificacion-pedido-listo`.
6. En **HTTP Headers**, agregar `x-webhook-secret` con el mismo valor que
   el secreto `WEBHOOK_SECRET` del paso 1.
7. Guardar.

## 4. Avisos de la tienda a sus clientes ("Seguir tienda")

Segunda función, para avisar a los clientes cuando una bodega activa su
catálogo o su entrega a domicilio (o cuando el dueño toca "Avisar a mis
clientes" en el POS). Usa los mismos secretos del paso 1.

1. Correr `supabase/migration_34_seguir_tienda_y_avisos.sql` en el SQL Editor.
2. Dashboard → **Edge Functions** → **New Function**, nombre exacto
   `enviar-aviso-tienda`, pegar el contenido de
   [`supabase/functions/enviar-aviso-tienda/index.ts`](supabase/functions/enviar-aviso-tienda/index.ts) y Deploy.
3. Dashboard → **Database** → **Webhooks** → **Create a new webhook**:
   tabla `avisos_tienda`, evento solo **Insert**, tipo **Supabase Edge
   Functions**, función `enviar-aviso-tienda`, y el header
   `x-webhook-secret` con el mismo valor de `WEBHOOK_SECRET`.

Para probarlo: con un cliente que tenga notificaciones activadas y la
bodega en "Mis tiendas", en el POS abrir Mi Link de Pedidos → "Avisar a mis
clientes". Debe llegar la notificación "¡Tu bodega ya recibe pedidos!".

## Cómo probarlo de punta a punta

1. En la vitrina, crear una cuenta de cliente (celular + PIN) y hacer un
   pedido.
2. En "Mis pedidos" (dentro de la vitrina), tocar "Activar" y aceptar el
   permiso de notificaciones del navegador.
3. En el POS, abrir "Pedidos por retirar" (el ícono nuevo junto a
   "Cargar Pedido") y tocar "Marcar Listo" en ese pedido.
4. Debería aparecer la notificación en el celular/navegador del cliente
   en unos segundos, incluso con la pestaña cerrada.

## Limitación real de iOS/Safari

En iPhone, las notificaciones push de una página web (no una app nativa)
**solo funcionan si el cliente agregó la vitrina a su pantalla de inicio**
(Safari → Compartir → "Agregar a pantalla de inicio") y la abre desde ahí
-- no funciona con Safari abierto normal. Es una restricción de Apple, no
hay forma de evitarla desde el código. En Android con Chrome funciona
directo, sin este paso extra.
