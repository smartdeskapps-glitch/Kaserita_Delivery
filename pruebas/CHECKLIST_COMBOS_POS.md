# Prueba manual de combos en el POS (Bodega Demo)

Complementa a `test_combos_en_vivo.py` (que prueba el lado de Delivery).
Dura unos 5 minutos. Usa el "Combo QA Gaseosas" (Coca Cola x1 + Galletas Casino x1, S/ 9.50).

Antes de empezar anota el stock de Coca Cola y de Galletas Casino
(menú > Ver Stock).

| # | Paso | Resultado esperado |
|---|------|--------------------|
| 1 | Abrir el POS con turno abierto y entrar a la pestaña **Combos** | Se ven los combos activos con su precio y "Incluye: ..." |
| 2 | Tocar el combo | Entra al carrito como "Combo: Combo QA Gaseosas" a S/ 9.50 |
| 3 | Cobrar en efectivo ("Exacto") | "¡Venta exitosa!" con boleta nueva por S/ 9.50 |
| 4 | Ver Stock | Coca Cola y Galletas Casino bajaron **1 cada una** |
| 5 | Historial: la venta aparece con su boleta y total S/ 9.50 | Ganancia visible (el combo QA deja ~S/ 0.20) |
| 6 | Anular la boleta (con motivo) | "Boleta ... anulada correctamente" |
| 7 | Ver Stock | Coca Cola y Galletas Casino **volvieron** al valor inicial |
| 8 | Total de hoy en Historial | Vuelve a S/ 0.00 (la anulada no suma) |

## Con pedido de la tienda (Delivery)
| # | Paso | Resultado esperado |
|---|------|--------------------|
| 9 | En delivery.smartdeskapps.com/bodega-demo, pedir un combo con una cuenta de cliente | El pedido llega al POS (aviso "Nuevo pedido") |
| 10 | POS > Pedidos por retirar > Pendientes > cargar al carrito | El carrito muestra el combo, no los productos sueltos |
| 11 | Cobrar | El pedido desaparece de Pendientes y pasa al historial como entregado |
| 12 | Ver Stock | Se descontó **una sola vez** (no doble: ni por la reserva ni por la venta) |
