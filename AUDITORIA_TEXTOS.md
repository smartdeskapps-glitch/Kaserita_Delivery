# Auditoría de textos · Kaserita POS y Kaserita Delivery

Fecha: 26 de octubre de 2026. Se revisaron los textos visibles de `Kaserita/src/main.jsx` (unos 440 textos distintos) y `Kaserita - Delivery/src/main.jsx` (unos 95). Estado: aplicado el 26 de octubre de 2026, salvo lo que figura como pendiente al final de este documento.

## Resumen

| # | Problema | POS | Delivery |
|---|---|---|---|
| 1 | Se mezcla "tú" con "vos" | 2 casos | 5 casos |
| 2 | Una misma cosa con varios nombres | Alto | Alto |
| 3 | Errores técnicos que ve la persona | 60 mensajes | 5 mensajes |
| 4 | Jerga que no todos entienden | Medio | Bajo |
| 5 | Mayúsculas y tildes inconsistentes | Medio | Bajo |
| 6 | Textos largos o que sobran | Medio | Bajo |

---

## 1. Vocabulario: una cosa, un nombre

Este es el punto más importante. Hoy la misma cosa tiene varios nombres y la persona no sabe si son lo mismo.

### 1.1 "Catálogo" significa tres cosas distintas (POS)
| Dónde aparece hoy | Qué es en realidad |
|---|---|
| "Quitar del catálogo", "Ya está en tu catálogo", "En tu catálogo" | Tus productos |
| "Aparecer en el catálogo público" | Tu tienda en línea |
| "Importar del Catálogo Maestro", "Catálogo sugerido", "Del catálogo maestro" | La lista de productos que ofrece Kaserita |

**Propuesta:** *Mis productos* · *Tienda en línea* · *Productos de Kaserita*.

### 1.2 La tienda en línea tiene cuatro nombres (POS)
"Tu vitrina", "tienda online", "la tienda", "catálogo público". También "Mi link de pedidos" en el menú.

**Propuesta:** *Tienda en línea* en todo el POS, y "link de pedidos" solo para el enlace.

### 1.3 "Bodega", "tienda" y "local" (Delivery)
El cliente ve "Mis **tiendas**", pero también "Otras **bodegas**", "¿Compraste en otra **bodega**?", "Este **local** está cerrado" y "la **bodega** no tenga delivery". Hay 108 "bodega", 37 "tienda" y 18 "local".

**Propuesta:** para el cliente, *tienda* en todo. "Bodega" solo cuando se habla del tipo de negocio.

### 1.4 "Carrito" y "pedido" (Delivery)
"Tu carrito está vacío" y, en la misma pantalla, "¿Vaciar tu pedido?", "Mi pedido", "Agregar al pedido".

**Propuesta:** *carrito* mientras arma la compra; *pedido* cuando ya lo envió.

### 1.5 "Turno" y "caja" (POS)
"Abrir Turno", "Resumen del turno", pero también "Cerrar caja ahora", "Abrir otra caja", "Usar esta caja", "Seguir con esa caja".

**Propuesta:** *turno* para la persona que atiende; *caja* para el dinero. Usarlos siempre así.

### 1.6 Agotado (Delivery)
Se dice "Sin stock", "Quedan N" y "Agotados por ahora".

**Propuesta:** *Agotado* y *Quedan N*. "Stock" es palabra de oficina.

### 1.7 Entrega (Delivery)
"Delivery", "Envío a domicilio", "Entrega a domicilio", "Retiro", "Retiras en", "Retirado".

**Propuesta:** *Delivery* y *Retiro en tienda* como opciones. Para el pedido ya entregado, *Entregado* o *Retirado*, según el caso.

### 1.8 "Administrador" tiene dos sentidos (POS)
- "Contactá al administrador para habilitarla" → se refiere al equipo de Kaserita.
- "Administrador (acceso completo)" → es un rol de empleado de la bodega.

**Propuesta:** el equipo de Kaserita siempre es *soporte de Kaserita*. "Administrador" queda solo para el rol.

---

## 2. Tratamiento: tú, no vos

La app habla de "tú" casi siempre. Estos textos usan "vos":

| App | Texto hoy | Propuesta |
|---|---|---|
| Delivery | "Apuntá al código QR" | "Apunta al código QR" |
| Delivery | "Armá tu pedido y mandalo por WhatsApp" | "Arma tu pedido y envíalo por WhatsApp" |
| Delivery | "…guardás tus tiendas favoritas…" | "…guardas tus tiendas favoritas…" |
| Delivery | "Entrás con tu cuenta de Google…" | "Entras con tu cuenta de Google…" |
| POS | "Contactá al administrador para habilitarla…" | "Escribe a soporte de Kaserita para habilitarla." |
| POS | "Contactá al administrador para que te asigne otro." | "Escribe a soporte de Kaserita para que te asignen otro." |

---

## 3. Errores que muestran texto técnico

En el POS hay unos 60 avisos que pegan el mensaje crudo de la base de datos, normalmente en inglés. Ejemplos de cómo quedan hoy:

- "No se pudo cargar categorías desde Supabase: …"
- "Error al ajustar stock por merma: …"
- "Error: …" (sin decir qué falló)
- "No se pudo subir la foto: …", "No se pudo guardar el horario: …"

**Propuesta:** un mensaje corto en español que diga qué falló y qué hacer, y el detalle técnico solo en el registro de errores. Por ejemplo: *"No pudimos guardar el horario. Revisa tu conexión e inténtalo de nuevo."*

En Delivery pasa en 5 sitios (activar notificaciones, eliminar cuenta, enviar pedido). Lo más delicado es "Algo salió mal al abrir Kaserita Delivery", que muestra el error técnico debajo; está bien para soporte, pero conviene dejarlo como detalle plegado.

---

## 4. Jerga

| Texto hoy | Dónde | Propuesta |
|---|---|---|
| "Código EAN / de barras", "Código EAN del pack" | Productos, entrada de mercadería | *Código de barras* |
| "EAN o SKU del pack" | Productos | *Código de barras del pack* |
| "Crea la ficha en 3 pasos", "Ficha completa", "Así queda la ficha" | Registrar productos | *Crea el producto en 3 pasos*, *Producto completo* |
| "Quitar vínculo" | Productos | *Desvincular de Kaserita* |
| "Registrar merma" | Mermas | *Registrar pérdida* (y explicar "merma" en la ayuda) |
| "Total contado" | Cierre de caja | *Total contado en caja* |
| "Cliente Varios / Desconocido" | Venta | *Cliente sin registrar* |
| "Modo Demo Local" | Entrada | *Modo demostración* |
| "Debe ser un entero entre 5 y 480." | Duración de servicio | *Escribe un número de 5 a 480 minutos.* |
| "Revisa este apartado" | Formularios | Decir cuál: *Falta completar el precio* |
| "DNI del Usuario" | Inicio de sesión | *Tu DNI* |
| "Ingresar al Sistema" | Inicio de sesión | *Entrar* |
| "Cuenta Vencida" | Inicio de sesión | *Tu cuenta venció* |

---

## 5. Mayúsculas, tildes y formato

El español usa mayúscula solo en la primera palabra. Hoy hay etiquetas en estilo título:

"Nombre Completo", "Límite de Crédito (S/)", "Registrar Nuevo Cliente", "Guardar Cliente", "Guardar Proveedor", "Nuevo Proveedor", "Agregar Nuevo Barbero", "Agregar Nuevo Cajero", "PIN de Acceso", "Medio de Pago", "Precio Venta (S/):", "Precio Costo (S/):", "Stock inicial:".

**Propuesta:** *Nombre completo*, *Registrar cliente*, *Guardar proveedor*, *Agregar barbero*, etc.

Otros detalles:
- Falta tilde en **"Metodos de Pago"** y en las columnas de Excel **"Telefono"**.
- Algunas etiquetas llevan dos puntos y otras no ("Stock inicial:" frente a "Costo por kilo").
- "MI PEDIDO" va en mayúsculas en Delivery; el resto de la app usa minúsculas.
- Los botones mezclan "Guardar", "Guardar cambios" y "Guardar y ajustar stock". Está bien si cada uno dice qué pasa, pero conviene que los nombres se repitan igual en toda la app.

---

## 6. Textos largos o que sobran

| Texto hoy | Propuesta |
|---|---|
| **Mi link de pedidos**, descripción: "Tus clientes entran a este link, arman su pedido y te lo mandan por WhatsApp con un código, que cargas aquí en caja para cobrar sin escribir nada a mano." | "Tus clientes piden desde este link y te llega el pedido por WhatsApp con un código. Ingresa ese código en caja para cobrar." |
| "Así la vitrina muestra "Abierto" o "Cerrado" en tiempo real. Si no lo configuras, no se muestra ningún aviso." | "La tienda muestra Abierto o Cerrado según este horario." |
| "Aparecer en el catálogo público" / "Oculto: solo entra quien tenga el link" | "Mostrar mi tienda al público" / "Solo entra quien tenga tu link" |
| "Avisar a tus clientes": dos párrafos | Uno: "Avisa a quienes siguen tu tienda que ya recibes pedidos. Máximo una vez por semana." |
| "Toca el círculo para cambiar tu logo." y "Configura tu horario para mostrar Abierto o Cerrado." (tarjeta violeta) | Dejar una sola línea de ayuda a la vez |
| "Lo básico para reconocerlo en la caja y en la tienda." (producto) | Sobra el subtítulo; el título "Datos del producto" basta |
| "Escanea o busca el producto, cuenta lo que tienes físicamente y listo." | "Escanea o busca el producto y cuenta lo que tienes." |
| Delivery: "Este es el catálogo de pedidos de Kaserita. Pídele a tu bodega el link de su catálogo para empezar a pedir." | "Kaserita Delivery te deja pedir a tu tienda de barrio. Pídele su link o escanea su QR." |

---

## 7. Lo que ya está bien (conviene copiar este estilo)

- "Aún no tienes pedidos. Cuando hagas uno, podrás seguirlo aquí paso a paso." (explica qué pasará)
- "No pudimos cargar tus pedidos. Revisa tu conexión e inténtalo de nuevo." (dice qué hacer)
- "Falta elegir la categoría." (dice cuál falta)
- "Se borrarán tu nombre, teléfono, correo, tus tiendas guardadas y el historial de tus pedidos. Esta acción no se puede deshacer." (dice exactamente qué se pierde)
- "Vencidos, rotos, robados o perdidos. Se descuenta del stock." (explica el término)

---

## 8. Decisiones que necesito de ti antes de aplicar

1. **Vocabulario del cliente (Delivery):** ¿usamos *tienda* en todo, en vez de "bodega" y "local"?
2. **Catálogo (POS):** ¿aceptas *Mis productos*, *Tienda en línea* y *Productos de Kaserita*?
3. **Turno y caja:** ¿turno = persona que atiende, caja = el dinero?
4. **Tratamiento:** ¿todo en "tú"?
5. **Errores:** ¿cambio los mensajes técnicos por mensajes cortos en español?

Con eso aplico los cambios por pantalla, empezando por Mi link de pedidos, y los subo cuando me digas.

---

## 9. Qué se aplicó y qué quedó pendiente

**Aplicado en el POS:** tienda en línea (ya no "vitrina" ni "tienda online"), Mis productos / Productos de Kaserita, soporte de Kaserita en vez de "administrador", código de barras en vez de EAN, producto en vez de ficha, pérdida en vez de merma, etiquetas en minúscula, tildes, textos largos acortados y mensajes de error en español.

**Aplicado en Delivery:** tuteo, "tienda" en vez de "bodega" y "local", Agotado, un solo nombre para el pedido y mensajes de error en español.

**Pendiente (a propósito):**
- **Turno y caja (1.5):** no se cambió. "Abrir turno" y "Cerrar caja" se usan en muchas pantallas y cambiar uno solo dejaría dos nombres. Conviene decidirlo con calma.
- **Carrito y pedido (1.4):** en vez de "carrito", se dejó **pedido** en todo Delivery, porque la pantalla "Tu pedido", "Ver pedido", "Agregar al pedido" y "Realizar pedido" ya lo usaban.
- **Delivery, "Retiro" y "Retirado" (1.7):** se mantienen.
- Los textos que llevan variables dentro (por ejemplo los de cierre de caja) no se revisaron uno por uno.
