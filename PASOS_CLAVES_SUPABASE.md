# Retirar la clave maestra antigua de Supabase

La clave `service_role` antigua (un JWT que empieza con `eyJ…`) estaba
escrita dentro de los dos Database Webhooks de las notificaciones. Cualquiera
que la tenga puede leer y cambiar toda la base. Estos pasos la sacan de
ahí y la desactivan. Las apps (POS, registro y tienda) ya usan solo la clave
pública nueva `sb_publishable_…`, así que no se ven afectadas.

Hacerlos **en este orden**. Entre el paso 2 y el 4 las notificaciones push
pueden fallar unos minutos.

## 1. Confirmar que existe la clave secreta nueva

Dashboard → **Project Settings → API Keys** → pestaña de claves nuevas
(*Publishable and secret API keys*). Debe haber una clave secreta llamada
`default` (`sb_secret_…`). Si no hay ninguna, crearla con ese nombre.
No hace falta copiarla: Supabase se la pasa sola a las Edge Functions.

## 2. Cambiar el secreto de los webhooks

El valor actual de `WEBHOOK_SECRET` también quedó expuesto. Generar uno nuevo
en PowerShell:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) -replace '[+/=]', ''
```

Dashboard → **Edge Functions → Secrets** → editar `WEBHOOK_SECRET` y pegar
el valor nuevo. No guardarlo en ningún archivo del repo.

## 3. Volver a publicar las dos funciones

Para cada una (`enviar-notificacion-pedido-listo` y `enviar-aviso-tienda`):

1. Dashboard → **Edge Functions** → la función → **Code**.
2. Reemplazar todo por el contenido de
   `supabase/functions/<nombre>/index.ts` de este repo y **Deploy**.
3. En **Details / Settings** de la función, desactivar **Verify JWT** (o
   *Enforce JWT verification*). La función se protege con el secreto del
   paso 2: si no llega `x-webhook-secret` correcto, responde 401, y si el
   secreto no está configurado no atiende a nadie.

## 4. Rehacer los dos Database Webhooks

Lo más simple es por SQL: abrir
[`supabase/actualizar_webhooks_push.sql`](supabase/actualizar_webhooks_push.sql),
pegarlo en el **SQL Editor**, reemplazar `PEGAR_AQUI_EL_SECRETO_NUEVO` por el
valor del paso 2 y ejecutar. La tabla final debe mostrar los dos webhooks con
`lleva_clave_maestra = false` y `lleva_secreto = true`.

(Desde el Dashboard es lo mismo: **Integrations → Database Webhooks** —en
versiones viejas, **Database → Webhooks**—, editar `pedido_listo_push` y
`avisos_tienda_webhook`, borrar la fila `Authorization` de **HTTP Headers**
y poner el valor nuevo en `x-webhook-secret`.)

## 5. Probar

En el POS, marcar como **listo** un pedido de prueba de un cliente con las
notificaciones activadas: debe llegarle el aviso. En **Edge Functions → la
función → Logs** la llamada debe salir con 200 (un 401 significa que el
secreto del webhook y el de la función no coinciden).

## 6. Borrar funciones viejas

En **Edge Functions**, si aparecen, borrar `reset-cajero-pin`,
`cobrar-plan-culqi` y `resetear-pin-cliente`. Ya no las usa ninguna app.

## 7. Desactivar las claves antiguas

Dashboard → **Project Settings → API Keys** → **Legacy API keys** →
desactivarlas. Con eso la clave `eyJ…` expuesta deja de servir.

Probar enseguida: abrir la tienda, entrar al POS, y repetir la prueba del
paso 5. Si algo falla, se pueden volver a activar desde el mismo lugar
(la desactivación es reversible) y avisar.
