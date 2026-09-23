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

## Cómo probarlo de punta a punta

1. En la vitrina, crear una cuenta de cliente (celular + PIN) y hacer un
   pedido.
2. En "Mis pedidos" (dentro de la vitrina), tocar "Activar" y aceptar el
   permiso de notificaciones del navegador.
3. En el POS, abrir "Pedidos por retirar" (el ícono nuevo junto a
   "Cargar Pedido") y tocar "Marcar Listo" en ese pedido.
4. Debería aparecer la notificación en el celular/navegador del cliente
   en unos segundos, incluso con la pestaña cerrada.

## 4. (Aparte) Aviso de reposición de stock ("Avisame")

Mismo mecanismo que arriba, pero sobre otra tabla y otra función --
avisa cuando un producto agotado vuelve a tener stock. Necesita también
haber corrido `supabase/migration_27_avisos_reposicion_stock.sql`.

1. Dashboard de Supabase → **Edge Functions** → **New Function**.
2. Nombre exacto: `avisar-reposicion-stock`.
3. Pegar el contenido completo de
   [`supabase/functions/avisar-reposicion-stock/index.ts`](supabase/functions/avisar-reposicion-stock/index.ts).
4. Deploy. (Usa los mismos secretos `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
   del paso 1, no hace falta configurarlos de nuevo.)
5. Dashboard de Supabase → **Database** → **Webhooks** → **Create a new
   webhook**.
6. Tabla: `productos`.
7. Eventos: solo **Update**.
8. Tipo: **Supabase Edge Functions**.
9. Función: `avisar-reposicion-stock`.
10. En **HTTP Headers**, agregar `x-webhook-secret` con el mismo valor que
    el secreto `WEBHOOK_SECRET` del paso 1.
11. Guardar.

Para probarlo: en la vitrina, con un producto en 0 de stock, tocar
"Avisame" (pide iniciar sesión si no hay cuenta). En el POS, actualizar
el stock de ese producto a más de 0 (edición manual o recepción de
inventario). El push debería llegar en unos segundos.

## Limitación real de iOS/Safari

En iPhone, las notificaciones push de una página web (no una app nativa)
**solo funcionan si el cliente agregó la vitrina a su pantalla de inicio**
(Safari → Compartir → "Agregar a pantalla de inicio") y la abre desde ahí
-- no funciona con Safari abierto normal. Es una restricción de Apple, no
hay forma de evitarla desde el código. En Android con Chrome funciona
directo, sin este paso extra.
