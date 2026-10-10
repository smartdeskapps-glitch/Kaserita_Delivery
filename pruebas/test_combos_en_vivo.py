#!/usr/bin/env python3
"""
Prueba de funcionamiento en vivo de los combos del lado de Delivery.

Qué hace (contra la bodega demo "bodega-demo", con la clave pública de la tienda):
  1. El catálogo de combos se ve completo y un slug inventado no devuelve nada.
  2. Un pedido con un combo se acepta y RESERVA el stock de cada producto del combo.
  3. Un pedido mezclado (combo + producto suelto con precio alterado) se acepta.
  4. Se rechazan: combo repetido, combo inexistente, stock insuficiente,
     cantidades inválidas y código de pedido inválido.
  5. Seguridad: sin sesión no se pueden leer ni borrar pedidos.

Los pedidos aceptados quedan PENDIENTES en la bodega demo y reservan stock
hasta que alguien los elimine desde el POS (menú > "Pedidos por retirar") o
pasen 2 horas. Por eso el script guarda el stock inicial en
pruebas/.baseline_stock.json. Cuando los elimines, corre:

    python pruebas/test_combos_en_vivo.py --verificar-limpieza

y confirma que el stock volvió exactamente a lo de antes.

Uso:
    python pruebas/test_combos_en_vivo.py                  # prueba completa
    python pruebas/test_combos_en_vivo.py --verificar-limpieza

Solo usa la librería estándar de Python 3.
"""
import json
import os
import random
import string
import sys
import urllib.error
import urllib.request

SUPABASE_URL = "https://hzmrsbeamtbloudmxjrp.supabase.co"
ANON_KEY = "sb_publishable_RHAkd7pZIadDnSQClFdjMQ_lrG3p-gw"  # clave pública (la misma de la tienda)
SLUG = "bodega-demo"
BODEGA_ID = "f1c4a872-3230-4f61-89aa-8f7441ef6af1"
RUTA_BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".baseline_stock.json")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------- utilidades
def llamar(metodo, ruta, cuerpo=None, extra=None):
    """Devuelve (http_status, json|texto)."""
    cab = {"apikey": ANON_KEY, "Authorization": "Bearer " + ANON_KEY, "Content-Type": "application/json"}
    cab.update(extra or {})
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(SUPABASE_URL + ruta, data=datos, headers=cab, method=metodo)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            texto = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(texto) if texto.strip() else None)
    except urllib.error.HTTPError as e:
        texto = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(texto)
        except ValueError:
            return e.code, texto


def rpc(nombre, cuerpo):
    return llamar("POST", "/rest/v1/rpc/" + nombre, cuerpo)


def codigo():
    return "QAT" + "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def crear_pedido(items, cod=None):
    cod = cod or codigo()
    est, resp = llamar(
        "POST", "/rest/v1/pedidos_delivery",
        {"codigo_corto": cod, "bodega_id": BODEGA_ID, "items": items},
        {"Prefer": "return=minimal"},
    )
    return est, resp, cod


def stock_por_producto():
    est, prods = rpc("obtener_productos_delivery", {"p_slug": SLUG})
    assert est == 200, f"obtener_productos_delivery -> {est}"
    return {p["id"]: p["stock_disponible"] for p in prods}


def mensaje(resp):
    return resp.get("message", "") if isinstance(resp, dict) else str(resp)


# ---------------------------------------------------------------- mini-framework
resultados = []


def prueba(nombre):
    def deco(fn):
        def corre():
            try:
                fn()
                resultados.append((nombre, True, ""))
                print(f"  OK    {nombre}")
            except AssertionError as e:
                resultados.append((nombre, False, str(e)))
                print(f"  FALLA {nombre}\n        -> {e}")
            except Exception as e:  # error inesperado: también cuenta como falla
                resultados.append((nombre, False, f"{type(e).__name__}: {e}"))
                print(f"  ERROR {nombre}\n        -> {type(e).__name__}: {e}")
        return corre
    return deco


def verificar_limpieza():
    if not os.path.exists(RUTA_BASELINE):
        print("No hay stock inicial guardado. Corre primero la prueba completa.")
        return 2
    with open(RUTA_BASELINE, encoding="utf-8") as f:
        base = json.load(f)
    ahora = stock_por_producto()
    difs = {k: (base[k], ahora.get(k)) for k in base if base[k] != ahora.get(k)}
    if difs:
        print("El stock todavía NO volvió al inicial (¿quedan pedidos de prueba pendientes?):")
        for k, (a, b) in difs.items():
            print(f"  producto {k}: antes {a} -> ahora {b}")
        return 1
    print("OK: el stock volvió exactamente al inicial. Los pedidos de prueba ya no reservan nada.")
    return 0


# ---------------------------------------------------------------- pruebas
estado = {}


@prueba("1. El catálogo de combos trae nombre, precio y productos de cada combo")
def t_catalogo():
    est, combos = rpc("obtener_combos_delivery", {"p_slug": SLUG})
    assert est == 200 and isinstance(combos, list), f"HTTP {est}"
    assert len(combos) >= 1, "la bodega demo no tiene combos activos"
    ids_prod = set(estado["stock_inicial"])
    for c in combos:
        assert c["nombre"].strip(), "combo sin nombre"
        assert float(c["precio_venta"]) > 0, f"combo '{c['nombre']}' sin precio"
        assert c["items"], f"combo '{c['nombre']}' sin productos"
        for it in c["items"]:
            assert float(it["cantidad"]) > 0, f"cantidad inválida en '{c['nombre']}'"
            assert it["producto_id"] in ids_prod, (
                f"'{c['nombre']}' incluye un producto que no está en el catálogo público: {it['descripcion']}")
    estado["combos"] = {c["nombre"]: c for c in combos}


@prueba("2. Un slug inventado no devuelve combos (y no da error)")
def t_slug():
    est, combos = rpc("obtener_combos_delivery", {"p_slug": "no-existe-zzz"})
    assert est == 200 and combos == [], f"HTTP {est}, respuesta {combos!r}"


@prueba("3. Pedir un combo se acepta y reserva 1 unidad de CADA producto del combo")
def t_reserva():
    combo = estado["combos"].get("Combo QA Gaseosas")
    assert combo, "no existe el 'Combo QA Gaseosas' en la demo"
    antes = stock_por_producto()
    est, resp, cod = crear_pedido([{"combo_id": combo["id"], "cantidad": 1}])
    assert est in (200, 201, 204), f"el pedido fue rechazado: HTTP {est} {mensaje(resp)}"
    estado["pedidos"].append(cod)
    despues = stock_por_producto()
    for it in combo["items"]:
        pid = it["producto_id"]
        esperado = antes[pid] - float(it["cantidad"])
        assert despues[pid] == esperado, (
            f"{it['descripcion']}: stock disponible {antes[pid]} -> {despues[pid]} (esperado {esperado})")
    tocados = {it["producto_id"] for it in combo["items"]}
    otros = {k: (antes[k], despues[k]) for k in antes if k not in tocados and antes[k] != despues[k]}
    assert not otros, f"cambió el stock de productos que no son del combo: {otros}"


@prueba("4. Pedido mezclado (combo + producto suelto con precio alterado) se acepta y reserva todo")
def t_mezclado():
    combo = estado["combos"].get("Combo Desayuno")
    assert combo, "no existe el 'Combo Desayuno' en la demo"
    est, prods = rpc("obtener_productos_delivery", {"p_slug": SLUG})
    suelto = next(p for p in prods if p["descripcion"].startswith("Aceite Primor"))
    antes = stock_por_producto()
    est, resp, cod = crear_pedido([
        {"combo_id": combo["id"], "cantidad": 1, "precio_venta": 0.01, "descripcion": "hack"},
        {"id": suelto["id"], "cantidad": 1, "precio_venta": 0.01, "descripcion": "hack"},
    ])
    assert est in (200, 201, 204), f"rechazado: HTTP {est} {mensaje(resp)}"
    estado["pedidos"].append(cod)
    despues = stock_por_producto()
    assert despues[suelto["id"]] == antes[suelto["id"]] - 1, "no se reservó el producto suelto"
    for it in combo["items"]:
        pid = it["producto_id"]
        assert despues[pid] == antes[pid] - float(it["cantidad"]), f"no se reservó {it['descripcion']}"


@prueba("5. Un combo repetido en el mismo pedido se rechaza")
def t_repetido():
    combo = estado["combos"]["Combo QA Gaseosas"]
    est, resp, _ = crear_pedido([{"combo_id": combo["id"], "cantidad": 1}, {"combo_id": combo["id"], "cantidad": 1}])
    assert est == 400 and "repetido" in mensaje(resp), f"HTTP {est}: {mensaje(resp)}"


@prueba("6. Un combo que no existe (o de otra bodega) se rechaza")
def t_inexistente():
    est, resp, _ = crear_pedido([{"combo_id": "00000000-0000-0000-0000-000000000000", "cantidad": 1}])
    assert est == 400 and "ya no está disponible" in mensaje(resp), f"HTTP {est}: {mensaje(resp)}"


@prueba("7. Pedir más combos que el stock alcanza se rechaza con el nombre del producto que falta")
def t_sin_stock():
    combo = estado["combos"]["Combo QA Gaseosas"]
    est, resp, _ = crear_pedido([{"combo_id": combo["id"], "cantidad": 9999}])
    assert est == 400 and "No hay suficiente stock" in mensaje(resp), f"HTTP {est}: {mensaje(resp)}"


@prueba("8. Cantidades inválidas (0, negativa, fuera de tope) se rechazan")
def t_cantidades():
    combo = estado["combos"]["Combo QA Gaseosas"]
    for cant in (0, -1, 10000):
        est, resp, _ = crear_pedido([{"combo_id": combo["id"], "cantidad": cant}])
        assert est == 400 and "Cantidad inválida" in mensaje(resp), f"cantidad {cant}: HTTP {est} {mensaje(resp)}"


@prueba("9. Pedido vacío y código de pedido inválido se rechazan")
def t_vacio_y_codigo():
    est, resp, _ = crear_pedido([])
    assert est == 400, f"pedido vacío: HTTP {est}"
    combo = estado["combos"]["Combo QA Gaseosas"]
    est, resp, _ = crear_pedido([{"combo_id": combo["id"], "cantidad": 1}], cod="abc")
    assert est == 400 and "Código de pedido inválido" in mensaje(resp), f"HTTP {est}: {mensaje(resp)}"


@prueba("10. Seguridad: sin sesión no se pueden leer ni borrar pedidos")
def t_seguridad():
    est, resp = llamar("GET", "/rest/v1/pedidos_delivery?select=*&limit=1")
    leyo = est == 200 and isinstance(resp, list) and len(resp) > 0
    assert not leyo, "se pudieron leer pedidos sin iniciar sesión"
    est, resp = llamar("DELETE", "/rest/v1/pedidos_delivery?codigo_corto=like.QAT*", None, {"Prefer": "return=representation"})
    borro = est in (200, 204) and bool(resp)
    assert not borro, "se pudieron borrar pedidos sin iniciar sesión"
    est, resp = llamar("GET", "/rest/v1/combos?select=*&limit=1")
    assert not (est == 200 and resp), "se pudo leer la tabla combos directo sin sesión"


def main():
    if "--verificar-limpieza" in sys.argv:
        return verificar_limpieza()

    print(f"Prueba de combos en vivo - bodega '{SLUG}'\n")
    estado["pedidos"] = []
    estado["stock_inicial"] = stock_por_producto()
    with open(RUTA_BASELINE, "w", encoding="utf-8") as f:
        json.dump(estado["stock_inicial"], f)

    for t in (t_catalogo, t_slug, t_reserva, t_mezclado, t_repetido, t_inexistente,
              t_sin_stock, t_cantidades, t_vacio_y_codigo, t_seguridad):
        t()

    fallas = [r for r in resultados if not r[1]]
    print(f"\n{len(resultados) - len(fallas)} de {len(resultados)} pruebas pasaron.")
    if estado["pedidos"]:
        print("\nQuedaron pedidos de prueba PENDIENTES en la bodega demo (reservan stock):")
        for c in estado["pedidos"]:
            print("  -", c)
        print("Elimínalos desde el POS (menú > Pedidos por retirar > Pendientes) y corre:")
        print("  python pruebas/test_combos_en_vivo.py --verificar-limpieza")
    return 1 if fallas else 0


if __name__ == "__main__":
    sys.exit(main())
