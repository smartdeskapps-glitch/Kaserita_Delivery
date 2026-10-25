import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import {
  formatoMoneda,
  totalPedido,
  totalCarrito as calcularTotalCarrito,
  totalUnidades as calcularTotalUnidades,
  entregaDomicilio,
  costoEnvio as calcularCostoEnvio,
  problemaEntrega as calcularProblemaEntrega,
} from './lib/carrito.js';


const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://hzmrsbeamtbloudmxjrp.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_RHAkd7pZIadDnSQClFdjMQ_lrG3p-gw";
const sbClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Aviso sonoro para el cliente cuando su pedido pasa a "listo" -- mismo
// archivo que usa el dueño en la POS del lado de la bodega. Se crea una
// sola vez (no un Audio nuevo por evento) para no repetir la descarga, y
// recién cuando hace falta: al confirmar un pedido se prepara (ver
// confirmarPedido) y, si no, la primera vez que suena. Antes se descargaba
// (71 KB) en cada visita aunque nadie pidiera nada.
// Solo suena si el cliente tiene la pestaña abierta; para cuando la tiene
// cerrada ya existe el push (ver activarNotificaciones/enviar-notificacion-pedido-listo).
let audioAvisoPedidoListo = null;
function prepararAvisoPedidoListo() {
  if (!audioAvisoPedidoListo) {
    audioAvisoPedidoListo = new Audio("https://cdn.pixabay.com/audio/2025/01/11/audio_5e34842448.mp3");
    audioAvisoPedidoListo.preload = "auto";
  }
  return audioAvisoPedidoListo;
}
function sonarAvisoPedidoListo() {
  try {
    const audio = prepararAvisoPedidoListo();
    audio.currentTime = 0;
    audio.play().catch((err) => console.warn("No se pudo reproducir el aviso sonoro:", err.message));
  } catch (err) {
    console.warn("No se pudo reproducir el aviso sonoro:", err.message);
  }
}

// Los nombres de producto vienen tal cual los cargó la bodega en el POS,
// normalmente TODO EN MAYÚSCULAS (así se ingresan ahí) -- se ven "a los
// gritos" en una vitrina para el cliente. Esto es solo para mostrar acá,
// no toca la descripción real (el POS, el mensaje de WhatsApp y el
// historial de la bodega la siguen viendo como la cargaron).
function tituloProducto(texto) {
  if (!texto) return "";
  return texto
    .toLowerCase()
    .replace(/(^|[\s/(-])([a-záéíóúñ])/g, (_, sep, letra) => sep + letra.toUpperCase());
}

// Fecha relativa cortita para "Mis tiendas" (Hoy, Ayer, Hace 3 días...) --
// nada de fechas exactas, es solo una referencia rápida de cuándo compraste ahí.
function fechaRelativa(fechaIso) {
  const dias = Math.floor((Date.now() - new Date(fechaIso).getTime()) / 86400000);
  if (dias <= 0) return "Hoy";
  if (dias === 1) return "Ayer";
  if (dias < 30) return `Hace ${dias} días`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? "Hace 1 mes" : `Hace ${meses} meses`;
}

// "Abierto ahora" / "Cerrado" en base al horario que cargó el dueño desde
// el POS (bodegas.horario_atencion, un objeto por día de la semana --
// 0=domingo...6=sábado, igual que Date.getDay()). Sin horario configurado
// devuelve null -- ahí la vitrina no muestra ningún indicador, para no
// afirmar algo que el dueño nunca confirmó.
function estadoAtencionBodega(horario) {
  if (!horario) return null;
  const ahora = new Date();
  const cfg = horario[String(ahora.getDay())];
  if (!cfg || !cfg.abierto || !cfg.desde || !cfg.hasta) return { abierto: false };
  const [hDesde, mDesde] = cfg.desde.split(":").map(Number);
  const [hHasta, mHasta] = cfg.hasta.split(":").map(Number);
  const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();
  const minutosDesde = hDesde * 60 + mDesde;
  const minutosHasta = hHasta * 60 + mHasta;
  // Si "hasta" es menor que "desde" el horario cruza la medianoche (ej.
  // 18:00 a 02:00) -- se trata como dos tramos en vez de uno solo.
  const abierto =
    minutosDesde <= minutosHasta
      ? minutosAhora >= minutosDesde && minutosAhora < minutosHasta
      : minutosAhora >= minutosDesde || minutosAhora < minutosHasta;
  return { abierto };
}

function getSlugFromPath() {
  return decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ""));
}

// Clave pública VAPID para las notificaciones push -- es pública a
// propósito (identifica al remitente ante el navegador), la privada vive
// solo en la función de servidor que manda el push.
const VAPID_PUBLIC_KEY = "BOygmWrwaP8XjdL9v-VzAC7ADw36O_W7JcXPitn8nDU_bs6f3ZylCxo4lu2D46ksneRKmBvneNJyDiPxn4EK13k";

function base64UrlAUint8Array(base64Url) {
  const relleno = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + relleno).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Pide permiso de notificaciones, suscribe al navegador al push, y guarda
// la suscripción en la cuenta del cliente -- de ahí la lee la función de
// servidor cuando la bodega marca un pedido como listo.
function mismaClaveVapid(suscripcion) {
  const actual = suscripcion.options && suscripcion.options.applicationServerKey;
  if (!actual) return false;
  const a = new Uint8Array(actual);
  const b = base64UrlAUint8Array(VAPID_PUBLIC_KEY);
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

// Con silencioso = true no pide permiso: solo renueva la suscripción de quien
// ya lo había dado (por ejemplo, tras cambiar las claves del servidor).
async function activarNotificaciones(clienteId, silencioso = false) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (silencioso) return;
    throw new Error("Este navegador no soporta notificaciones push.");
  }
  if (silencioso && Notification.permission !== "granted") return;
  const registro = await navigator.serviceWorker.register("/sw.js");
  const permiso = silencioso ? "granted" : await Notification.requestPermission();
  if (permiso !== "granted") throw new Error("No diste permiso para las notificaciones.");
  let suscripcion = await registro.pushManager.getSubscription();
  // Una suscripción hecha con otra clave del servidor ya no sirve: se rehace.
  if (suscripcion && !mismaClaveVapid(suscripcion)) {
    await suscripcion.unsubscribe();
    suscripcion = null;
  }
  if (!suscripcion) {
    suscripcion = await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlAUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  const { error } = await sbClient
    .from("clientes_delivery")
    .update({ push_subscription: suscripcion.toJSON() })
    .eq("id", clienteId);
  if (error) throw error;
}

// "default" = todavía no se le ha preguntado; "granted"/"denied" = ya decidió;
// "no-soportado" = el navegador no tiene push (p. ej. iPhone sin instalar la app).
function permisoNotificaciones() {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "no-soportado";
  }
  return Notification.permission;
}

function generarCodigoCorto() {
  // Sin caracteres ambiguos (0/O, 1/I) para que sea fácil de leer y transcribir.
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let codigo = "";
  for (let i = 0; i < 6; i++) {
    codigo += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  }
  return codigo;
}

function armarMensajeWhatsapp({ bodegaNombre, items, total, codigo, entrega }) {
  // Los combos van con sus productos debajo (cantidad total a preparar), así
  // la tienda sabe qué armar sin abrir el combo.
  const lineas = items.flatMap((it) => [
    `• ${it.cantidad} x ${it.descripcion} — ${formatoMoneda(it.precio_venta * it.cantidad)}`,
    ...(it.componentes || []).map((c) => `   - ${c.cantidad * it.cantidad} x ${c.descripcion}`),
  ]);
  if (entrega) {
    return [
      `Hola ${bodegaNombre}! Quiero hacer este pedido A DOMICILIO:`,
      "",
      ...lineas,
      "",
      `Productos: ${formatoMoneda(total)}`,
      `Envío: ${formatoMoneda(entrega.costoEnvio)}`,
      `Total a pagar: ${formatoMoneda(total + entrega.costoEnvio)}`,
      `Pago al recibir: ${TEXTO_MEDIO_PAGO[entrega.medioPago] || entrega.medioPago}${entrega.pagaCon ? ` (pago con ${formatoMoneda(entrega.pagaCon)})` : ""}`,
      "",
      `Referencia: ${entrega.referencia}`,
      `Teléfono: ${entrega.telefono}`,
      `Ubicación: ${enlaceMapa(entrega.lat, entrega.lng)}`,
      "",
      `Código de referencia: ${codigo}`,
    ].join("\n");
  }
  return [
    `Hola ${bodegaNombre}! Quiero hacer este pedido:`,
    "",
    ...lineas,
    "",
    `Total: ${formatoMoneda(total)}`,
    `Código de referencia: ${codigo}`,
    "",
    "(muestra este código en caja para cargar el pedido)",
  ].join("\n");
}

// "2026-10-22" -> "jueves 22 de octubre" (sin pasar por UTC: la fecha es la del calendario del cliente).
function formatoFechaCita(iso) {
  const [a, m, d] = String(iso || "").split("-").map(Number);
  if (!a || !m || !d) return iso || "";
  return new Date(a, m - 1, d).toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long" });
}

// Igual que formatoFechaCita pero con la primera letra en mayúscula ("Jueves 22 de octubre"), para mostrar en pantalla.
function fechaCitaTitulo(iso) {
  const t = formatoFechaCita(iso);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Hoy en formato yyyy-mm-dd con la fecha local del celular (para el mínimo del calendario).
function hoyISO() {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}-${String(h.getDate()).padStart(2, "0")}`;
}

// Mensaje de WhatsApp para una reserva en una barbería. El pedido igual queda
// registrado con su código (así el local carga los servicios en caja al llegar);
// el día, la hora y el barbero elegido viajan solo en este mensaje.
function armarMensajeReserva({ bodegaNombre, items, total, codigo, barbero, fecha, hora, agenda }) {
  const lineas = items.flatMap((it) => [
    `• ${it.cantidad} x ${it.descripcion} — ${formatoMoneda(it.precio_venta * it.cantidad)}`,
    ...(it.componentes || []).map((c) => `   - ${c.cantidad * it.cantidad} x ${c.descripcion}`),
  ]);
  return [
    agenda ? `Hola ${bodegaNombre}! Reservé una cita:` : `Hola ${bodegaNombre}! Quiero reservar una cita:`,
    "",
    ...lineas,
    "",
    `Día: ${formatoFechaCita(fecha)}`,
    `Hora: ${hora}`,
    `Barbero: ${barbero || "Cualquiera"}`,
    "",
    `Total: ${formatoMoneda(total)}`,
    `Código de referencia: ${codigo}`,
    "",
    "(muestra este código en caja para cargar los servicios)",
  ].join("\n");
}

// Tono del panel de la tarjeta según la categoría: las categorías las pone cada
// negocio, así que el tono sale de un hash estable del nombre (la misma
// categoría siempre queda del mismo color). Sin categoría: lila de marca.
const TONOS_TARJETA = [
  { t: "#ece0fd", td: "#6a3fc4" },
  { t: "#dfeafd", td: "#3b66b8" },
  { t: "#fde8d6", td: "#c0662a" },
  { t: "#fff1c7", td: "#a97c10" },
  { t: "#dcf3e6", td: "#238458" },
  { t: "#fde3ea", td: "#c0405f" },
];
function tonoCategoria(categoria) {
  if (!categoria) return TONOS_TARJETA[0];
  let h = 0;
  for (const ch of String(categoria).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONOS_TARJETA[h % TONOS_TARJETA.length];
}

function TarjetaProducto({ producto, cantidadEnCarrito, onAgregar, onQuitar, onVerFoto, onAbrir, esFavorito, onToggleFavorito }) {
  const stockPoco = producto.stock_disponible != null && producto.stock_disponible <= 3;
  const tono = tonoCategoria(producto.categoria);
  // Franja inferior del panel: un solo lugar para el aviso que importa.
  const aviso = stockPoco
    ? { texto: `Quedan ${producto.stock_disponible}`, clase: "kc-banda-warn", icono: "fa-triangle-exclamation" }
    : producto.es_destacado
      ? { texto: "Destacado", clase: "", icono: "fa-star" }
      : null;
  return (
    <article
      className={`kc ${cantidadEnCarrito > 0 ? "kc-en" : ""}`}
      style={{ "--t": tono.t, "--td": tono.td }}
    >
      <div className="kc-fw">
        <div
          onClick={onAbrir ? () => onAbrir(producto) : producto.foto_url ? () => onVerFoto(producto) : undefined}
          className={`kc-panel ${onAbrir || producto.foto_url ? "cursor-pointer" : ""}`}
        >
          {producto.foto_url ? (
            <div className="kc-foto">
              <img src={producto.foto_url} alt={tituloProducto(producto.descripcion)} loading="lazy" decoding="async" />
            </div>
          ) : (
            <i className="fa-solid fa-image kc-sinfoto"></i>
          )}
          {aviso && (
            <div className={`kc-banda ${aviso.clase}`}>
              <i className={`fa-solid ${aviso.icono}`}></i>
              {aviso.texto}
            </div>
          )}
        </div>
        <div className="kc-precio"><small>S/</small>{Number(producto.precio_venta).toFixed(2)}</div>
        {onToggleFavorito && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorito(producto.id); }}
            aria-label={esFavorito ? "Quitar de favoritos" : "Agregar a favoritos"}
            className={`kc-circ ${esFavorito ? "kc-circ-on" : ""}`}
          >
            <i className={`${esFavorito ? "fa-solid" : "fa-regular"} fa-heart`}></i>
          </button>
        )}
      </div>
      <div className="kc-body">
        <h3 onClick={onAbrir ? () => onAbrir(producto) : undefined} className={onAbrir ? "cursor-pointer" : ""}>{tituloProducto(producto.descripcion)}</h3>
        {producto.categoria && (
          <div className="kc-chips"><span className="kc-chip">{producto.categoria}</span></div>
        )}
      </div>
      <div className="kc-act">
        {cantidadEnCarrito === 0 ? (
          <button
            onClick={(e) => { volarAlCarrito(e.currentTarget, producto.foto_url, producto.categoria); onAgregar(producto); }}
            className="kc-add"
          >
            Agregar
            <u><i className="fa-solid fa-plus"></i></u>
          </button>
        ) : (
          <div className="kc-st">
            <button onClick={() => onQuitar(producto)} aria-label="Quitar uno"><i className="fa-solid fa-minus"></i></button>
            <span>{cantidadEnCarrito}</span>
            <button
              onClick={(e) => { volarAlCarrito(e.currentTarget, producto.foto_url, producto.categoria); onAgregar(producto); }}
              className="kc-mas"
              aria-label="Agregar uno"
            ><i className="fa-solid fa-plus"></i></button>
          </div>
        )}
      </div>
    </article>
  );
}

// Efecto al agregar: una bolita con la foto del producto vuela desde el botón
// hasta la barra del carrito. Si la barra todavía no existe (primer producto),
// apunta a donde va a aparecer. Se omite con "reducir movimiento".
function volarAlCarrito(origen, fotoUrl, categoria) {
  if (!origen || typeof origen.getBoundingClientRect !== "function") return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const a = origen.getBoundingClientRect();
  const chip = document.querySelector(".kdock-chip");
  const dock = document.querySelector(".kdock");
  const rc = chip ? chip.getBoundingClientRect() : null;
  const rd = dock ? dock.getBoundingClientRect() : null;
  // Si el chip aún no se despliega (primer producto), apunta a donde va a aparecer.
  const b = rc && rc.width > 60
    ? rc
    : rd
      ? { left: rd.left + rd.width * 0.5, top: rd.top, width: 60, height: rd.height }
      : { left: 16, top: window.innerHeight - 76, width: 60, height: 62 };
  const el = document.createElement("div");
  el.className = "kc-vuelo";
  el.style.background = tonoCategoria(categoria).t;
  el.style.left = `${a.left + a.width / 2 - 23}px`;
  el.style.top = `${a.top + a.height / 2 - 23}px`;
  if (fotoUrl) {
    const img = document.createElement("img");
    img.src = fotoUrl;
    img.alt = "";
    el.appendChild(img);
  }
  document.body.appendChild(el);
  const dx = b.left + 34 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const anim = el.animate(
    [
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.6}px, ${dy * 0.5 - 40}px) scale(0.9)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0.2 },
    ],
    { duration: 620, easing: "cubic-bezier(0.5, 0, 0.7, 1)" }
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

// Detalle del producto: hoja que sube desde abajo al tocar una tarjeta. Foto
// grande (con deslizar si tiene más fotos; tocarla la abre a pantalla completa),
// categoría, stock, precio, contador y "Agregar al pedido" con el total.
function HojaProducto({ producto, cantidadEnCarrito, onAgregar, onCerrar, onVerFoto, esFavorito, onToggleFavorito }) {
  const [cantidad, setCantidad] = useState(1);
  const [visible, setVisible] = useState(false);
  const [indice, setIndice] = useState(0);
  const inicioToqueX = useRef(null);
  const botonAgregarRef = useRef(null);
  const fotos = [producto.foto_url, ...(producto.fotos_extra || [])].filter(Boolean);
  const tono = tonoCategoria(producto.categoria);
  const stock = producto.stock_disponible;
  const stockPoco = stock != null && stock <= 3;
  const maximo = stock != null ? Math.max(1, stock - cantidadEnCarrito) : 99;
  const aviso = stockPoco
    ? { texto: `Quedan ${stock}`, clase: "kc-banda-warn", icono: "fa-triangle-exclamation" }
    : producto.es_destacado
      ? { texto: "Destacado", clase: "", icono: "fa-star" }
      : null;

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const cerrar = () => {
    setVisible(false);
    setTimeout(onCerrar, 300);
  };
  const agregar = () => {
    volarAlCarrito(botonAgregarRef.current, fotos[0], producto.categoria);
    for (let i = 0; i < cantidad; i++) onAgregar(producto);
    setTimeout(cerrar, 180);
  };
  const tocarInicio = (e) => { inicioToqueX.current = e.touches[0].clientX; };
  const tocarFin = (e) => {
    if (inicioToqueX.current == null || fotos.length <= 1) return;
    const delta = e.changedTouches[0].clientX - inicioToqueX.current;
    inicioToqueX.current = null;
    if (Math.abs(delta) < 40) return;
    setIndice((i) => (delta < 0 ? (i + 1) % fotos.length : (i - 1 + fotos.length) % fotos.length));
  };

  return (
    <div className="fixed inset-0 z-[28] flex items-end justify-center">
      <div
        onClick={cerrar}
        className={`absolute inset-0 bg-[#140a32]/50 transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}
      ></div>
      <div
        className={`kc-hoja ${visible ? "kc-hoja-on" : ""}`}
        style={{ "--t": tono.t, "--td": tono.td }}
      >
        <div className="kc-hoja-asa"></div>
        <div className="kc-hoja-foto" onTouchStart={tocarInicio} onTouchEnd={tocarFin}>
          <button onClick={cerrar} aria-label="Cerrar" className="kc-hoja-btn left-2.5">
            <i className="fa-solid fa-xmark"></i>
          </button>
          {onToggleFavorito && (
            <button
              onClick={() => onToggleFavorito(producto.id)}
              aria-label={esFavorito ? "Quitar de favoritos" : "Agregar a favoritos"}
              className={`kc-hoja-btn right-2.5 ${esFavorito ? "text-[#6105dc]" : ""}`}
            >
              <i className={`${esFavorito ? "fa-solid" : "fa-regular"} fa-heart`}></i>
            </button>
          )}
          {fotos.length > 0 ? (
            <div className="kc-hoja-img" onClick={() => onVerFoto(producto)}>
              <img src={fotos[indice]} alt={tituloProducto(producto.descripcion)} />
            </div>
          ) : (
            <i className="fa-solid fa-image kc-sinfoto" style={{ fontSize: 44 }}></i>
          )}
          {fotos.length > 1 && (
            <div className="kc-hoja-puntos">
              {fotos.map((_, i) => (
                <span key={i} className={i === indice ? "on" : ""}></span>
              ))}
            </div>
          )}
          {aviso && (
            <div className={`kc-banda ${aviso.clase}`}>
              <i className={`fa-solid ${aviso.icono}`}></i>
              {aviso.texto}
            </div>
          )}
        </div>
        <div className="kc-hoja-cuerpo">
          <div className="flex flex-wrap gap-1.5">
            {producto.categoria && <span className="kc-chip">{producto.categoria}</span>}
            {stock != null && (
              <span className="kc-chip kc-chip-neutro">
                <i className="kc-dot" style={{ background: stockPoco ? "#f59e0b" : "#10b981" }}></i>
                {stockPoco ? `Quedan ${stock}` : `${stock} disponibles`}
              </span>
            )}
            {cantidadEnCarrito > 0 && (
              <span className="kc-chip kc-chip-neutro">Ya tienes {cantidadEnCarrito} en tu pedido</span>
            )}
          </div>
          <h2>{tituloProducto(producto.descripcion)}</h2>
          <div className="kc-hoja-fila">
            <div className="kc-hoja-precio"><small>S/</small>{Number(producto.precio_venta).toFixed(2)}</div>
            <div className="kc-hoja-cant">
              <button onClick={() => setCantidad((c) => Math.max(1, c - 1))} aria-label="Quitar uno">
                <i className="fa-solid fa-minus"></i>
              </button>
              <span>{cantidad}</span>
              <button onClick={() => setCantidad((c) => Math.min(maximo, c + 1))} aria-label="Agregar uno" disabled={cantidad >= maximo}>
                <i className="fa-solid fa-plus"></i>
              </button>
            </div>
          </div>
          <button ref={botonAgregarRef} onClick={agregar} className="kc-hoja-cta">
            Agregar al pedido
            <u>{formatoMoneda(Number(producto.precio_venta) * cantidad)}</u>
          </button>
        </div>
      </div>
    </div>
  );
}

// Tarjeta del carrusel "Destacados": fila horizontal con foto grande (cuadro del
// color de la categoría), nombre, categoría, precio y el control de cantidad
// violeta: "Agregar +" antes de comprar y "- 2 +" después. Tocarla abre el detalle.
function TarjetaDestacado({ producto, cantidadEnCarrito, onAgregar, onQuitar, onAbrir }) {
  const tono = tonoCategoria(producto.categoria);
  const stock = producto.stock_disponible;
  const stockPoco = stock != null && stock <= 3;
  const detener = (fn) => (e) => { e.stopPropagation(); fn(e); };
  return (
    <div
      onClick={() => onAbrir(producto)}
      className="kh"
      style={{ "--t": tono.t, "--td": tono.td }}
    >
      <div className="kh-foto">
        {producto.foto_url ? (
          <div className="kh-img">
            <img src={producto.foto_url} alt={tituloProducto(producto.descripcion)} loading="lazy" decoding="async" />
          </div>
        ) : (
          <i className="fa-solid fa-image kc-sinfoto"></i>
        )}
        <div className={`kh-tab ${stockPoco ? "kh-tab-warn" : ""}`}>
          <i className={`fa-solid ${stockPoco ? "fa-triangle-exclamation" : "fa-star"}`}></i>
          {stockPoco ? `Quedan ${stock}` : "Destacado"}
        </div>
      </div>
      <div className="kh-cuerpo">
        <div>
          <h3>{tituloProducto(producto.descripcion)}</h3>
          {producto.categoria && <span className="kh-chip">{producto.categoria}</span>}
        </div>
        <div className="kh-pie">
          <div className="kh-precio"><small>S/</small>{Number(producto.precio_venta).toFixed(2)}</div>
          {cantidadEnCarrito === 0 ? (
            <button
              className="kh-pildora kh-agregar"
              onClick={detener((e) => { volarAlCarrito(e.currentTarget, producto.foto_url, producto.categoria); onAgregar(producto); })}
            >
              Agregar
              <u><i className="fa-solid fa-plus"></i></u>
            </button>
          ) : (
            <div className="kh-pildora" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => onQuitar(producto)} aria-label="Quitar uno"><i className="fa-solid fa-minus"></i></button>
              <span>{cantidadEnCarrito}</span>
              <button
                onClick={(e) => { volarAlCarrito(e.currentTarget, producto.foto_url, producto.categoria); onAgregar(producto); }}
                aria-label="Agregar uno"
              >
                <i className="fa-solid fa-plus"></i>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TarjetaCombo({ combo, cantidadCombo, productosPorId, onAgregar, onQuitar, ancho }) {
  // Precio "normal" = lo que costaría cada producto suelto, a como está
  // hoy en la vitrina -- así el %OFF y el "ahorras" salen de datos
  // reales, nada cargado a mano en el combo.
  const precioOriginal = (combo.items || []).reduce(
    (acc, it) => acc + it.cantidad * (productosPorId[it.producto_id]?.precio_venta || 0),
    0
  );
  const ahorro = precioOriginal - combo.precio_venta;
  const porcentajeOff = precioOriginal > 0 ? Math.round((ahorro / precioOriginal) * 100) : 0;
  // "Stock limitado": con el stock de hoy de cada producto que lo compone,
  // ¿para cuántos combos más alcanza? El más chico manda.
  const stocksLimitantes = (combo.items || [])
    .map((it) => {
      const prod = productosPorId[it.producto_id];
      if (!prod || prod.stock_disponible == null) return null;
      return Math.floor(prod.stock_disponible / it.cantidad);
    })
    .filter((n) => n != null);
  const maxCombosPosibles = stocksLimitantes.length > 0 ? Math.min(...stocksLimitantes) : null;
  const stockLimitado = maxCombosPosibles != null && maxCombosPosibles > 0 && maxCombosPosibles <= 3;

  // Fotos de lo que incluye, en grupo (la del medio al frente): se ve de un
  // vistazo qué trae el combo. Los productos sin foto se saltan.
  const items = combo.items || [];
  const fotos = items.map((it) => productosPorId[it.producto_id]?.foto_url).filter(Boolean).slice(0, 3);
  const tono = tonoCategoria(null);
  const textoItems = items.map((it) => `${tituloProducto(it.descripcion)} (x${it.cantidad})`).join(", ");
  const aviso = stockLimitado
    ? { texto: "Stock limitado", clase: "kcb-tab-warn", icono: "fa-triangle-exclamation" }
    : ahorro > 0
      ? { texto: `Ahorras ${formatoMoneda(ahorro)}`, clase: "", icono: "fa-tag" }
      : null;
  const foto = (u, clase) => (
    <span className={clase}><img src={u} alt="" loading="lazy" decoding="async" /></span>
  );

  return (
    <div className={`${ancho || "w-60"} shrink-0 kcb`} style={{ "--t": tono.t, "--td": tono.td }}>
      <div className="kcb-fw">
        <div className="kcb-panel">
          {fotos.length === 0 ? (
            <i className="fa-solid fa-gift kc-sinfoto"></i>
          ) : fotos.length >= 3 ? (
            <div className="kcb-fotos">
              {foto(fotos[0], "l")}
              {foto(fotos[1], "c")}
              {foto(fotos[2], "r")}
            </div>
          ) : fotos.length === 2 ? (
            <div className="kcb-fotos dos">
              {foto(fotos[0], "c")}
              {foto(fotos[1], "r")}
            </div>
          ) : (
            <div className="kcb-fotos uno">{foto(fotos[0], "c")}</div>
          )}
          {items.length > 3 && <span className="kcb-mas">+{items.length - 3}</span>}
          {aviso && (
            <div className={`kcb-tab ${aviso.clase}`}>
              <i className={`fa-solid ${aviso.icono}`}></i>
              {aviso.texto}
            </div>
          )}
        </div>
        {porcentajeOff > 0 && <span className="kcb-off">-{porcentajeOff}%</span>}
        <div className="kcb-precio">
          {porcentajeOff > 0 && <s>{formatoMoneda(precioOriginal)}</s>}
          <small>S/</small>{Number(combo.precio_venta).toFixed(2)}
        </div>
      </div>
      <div className="kcb-cuerpo">
        <h3>{combo.nombre}</h3>
        <p>{textoItems}</p>
      </div>
      <div className="kcb-pie">
        <span className="kcb-cant">{items.length} {items.length === 1 ? "producto" : "productos"}</span>
        {cantidadCombo === 0 ? (
          <button className="kh-pildora kh-agregar" onClick={() => onAgregar(combo)}>
            Agregar
            <u><i className="fa-solid fa-plus"></i></u>
          </button>
        ) : (
          <div className="kh-pildora">
            <button onClick={() => onQuitar(combo)} aria-label="Quitar uno"><i className="fa-solid fa-minus"></i></button>
            <span>{cantidadCombo}</span>
            <button onClick={() => onAgregar(combo)} aria-label="Agregar uno"><i className="fa-solid fa-plus"></i></button>
          </div>
        )}
      </div>
    </div>
  );
}

// Las tarjetas se dibujan una vez y solo se repiten si cambian sus propios datos:
// antes, agregar un producto volvía a dibujar TODAS (30+ tarjetas) en cada toque.
const TarjetaProductoMemo = React.memo(TarjetaProducto);
const TarjetaDestacadoMemo = React.memo(TarjetaDestacado);
const TarjetaComboMemo = React.memo(TarjetaCombo);

function VisorFoto({ producto, onCerrar }) {
  const fotos = [producto.foto_url, ...(producto.fotos_extra || [])].filter(Boolean);
  const [indice, setIndice] = useState(0);
  const siguiente = (e) => { e.stopPropagation(); setIndice((i) => (i + 1) % fotos.length); };
  const anterior = (e) => { e.stopPropagation(); setIndice((i) => (i - 1 + fotos.length) % fotos.length); };

  // Deslizar con el dedo en mobile, además de los botones -- se compara la
  // posición X del touch al empezar y al soltar, un swipe de +40px cuenta
  // como "cambiar de foto" (no hace falta librería para esto).
  const inicioToqueX = useRef(null);
  const manejarTouchStart = (e) => { inicioToqueX.current = e.touches[0].clientX; };
  const manejarTouchEnd = (e) => {
    if (inicioToqueX.current == null || fotos.length <= 1) return;
    const delta = e.changedTouches[0].clientX - inicioToqueX.current;
    inicioToqueX.current = null;
    if (Math.abs(delta) < 40) return;
    setIndice((i) => (delta < 0 ? (i + 1) % fotos.length : (i - 1 + fotos.length) % fotos.length));
  };

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-30 p-4" onClick={onCerrar}>
      <button
        onClick={onCerrar}
        className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition"
      >
        <i className="fa-solid fa-xmark text-lg"></i>
      </button>
      <div className="max-w-lg w-full flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <div
          className="relative w-full flex items-center justify-center touch-pan-y"
          onTouchStart={manejarTouchStart}
          onTouchEnd={manejarTouchEnd}
        >
          {fotos.length > 1 && (
            <button
              onClick={anterior}
              className="absolute left-1 w-8 h-8 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition z-10"
            >
              <i className="fa-solid fa-chevron-left"></i>
            </button>
          )}
          <img
            src={fotos[indice]}
            alt={tituloProducto(producto.descripcion)}
            className="max-w-full max-h-[65vh] rounded-[24px] object-contain shadow-2xl"
          />
          {fotos.length > 1 && (
            <button
              onClick={siguiente}
              className="absolute right-1 w-8 h-8 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition z-10"
            >
              <i className="fa-solid fa-chevron-right"></i>
            </button>
          )}
        </div>
        {fotos.length > 1 && (
          <div className="flex gap-1.5">
            {fotos.map((_, i) => (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); setIndice(i); }}
                className={`w-2 h-2 rounded-full transition ${i === indice ? "bg-white" : "bg-white/30"}`}
              />
            ))}
          </div>
        )}
        <p className="text-white text-[15px] font-bold text-center">{tituloProducto(producto.descripcion)}</p>
        {producto.descripcion_larga && (
          <p className="text-white/70 text-xs text-center max-w-sm whitespace-pre-line">{producto.descripcion_larga}</p>
        )}
      </div>
    </div>
  );
}

function PantallaConfirmacion({ bodega, codigo, whatsappUrl, onVolver, onVerPedidos, domicilio, resumen, reserva }) {
  const [copiado, setCopiado] = useState(false);
  const copiarCodigo = async () => {
    try {
      await navigator.clipboard.writeText(codigo);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch (e) {}
  };
  // El pedido ya está registrado y el local lo ve en su sistema; el mensaje de
  // WhatsApp es el aviso directo (y lleva la ubicación en los de domicilio).
  const pasos = reserva?.agenda
    ? [
        { titulo: "Cita reservada", detalle: "Tu hora quedó apartada con tu barbero.", estado: "hecho" },
        { titulo: "Avísale por WhatsApp", detalle: "Es opcional: así saben que vienes.", estado: "actual" },
        { titulo: "Te esperan en el local", detalle: "Si no puedes ir, cancela la cita desde Pedidos.", estado: "pendiente" },
      ]
    : reserva
    ? [
        { titulo: "Reserva registrada", detalle: "El local ya la ve en su sistema.", estado: "hecho" },
        { titulo: "Envíales el mensaje por WhatsApp", detalle: "Así te confirman el horario.", estado: "actual" },
        { titulo: "Te confirman la cita", detalle: "Te responden por WhatsApp si el horario está libre.", estado: "pendiente" },
      ]
    : [
        { titulo: "Pedido registrado", detalle: "El local ya lo ve en su sistema.", estado: "hecho" },
        { titulo: "Avísale por WhatsApp", detalle: "Envía el mensaje para que lo atiendan más rápido.", estado: "actual" },
        { titulo: "El local lo prepara", detalle: domicilio ? "Te avisamos cuando salga en camino." : "Te avisamos cuando esté listo.", estado: "pendiente" },
      ];
  return (
    <div className="max-w-md mx-auto min-h-screen px-4 pt-9 pb-6 flex flex-col gap-3.5">
      <div className="flex flex-col items-center text-center gap-2">
        <div className="relative w-[84px] h-[84px] flex items-center justify-center mb-1">
          <span className="absolute inset-0 rounded-full bg-[#6105dc]/[0.09]"></span>
          <span className="absolute inset-[11px] rounded-full bg-[#6105dc]/[0.14]"></span>
          <span className="relative w-[52px] h-[52px] rounded-full bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] text-white flex items-center justify-center">
            <i className="fa-solid fa-check text-xl"></i>
          </span>
        </div>
        <h1 className="text-[23px] font-extrabold tracking-tight text-[#1c1830]">{reserva?.agenda ? "¡Cita reservada!" : reserva ? "¡Reserva registrada!" : "¡Pedido registrado!"}</h1>
        <p className="text-[13.5px] text-[#78729a] leading-relaxed max-w-[300px]">
          {reserva?.agenda ? (
            <>
              Tu hora en <strong className="text-[#1c1830]">{bodega.nombre}</strong> quedó apartada. Si quieres, avísales por
              WhatsApp.
            </>
          ) : reserva ? (
            <>
              Ya la tiene <strong className="text-[#1c1830]">{bodega.nombre}</strong>. Envíales el mensaje por WhatsApp para
              que te confirmen la hora.
            </>
          ) : domicilio ? (
            <>
              Ya lo tiene <strong className="text-[#1c1830]">{bodega.nombre}</strong>. Avísale por WhatsApp: el mensaje lleva tu
              ubicación y el detalle para que te lo lleven.
            </>
          ) : (
            <>
              Ya lo tiene <strong className="text-[#1c1830]">{bodega.nombre}</strong>. Avísale por WhatsApp para que lo
              atiendan más rápido.
            </>
          )}
        </p>
      </div>

      <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] px-4 py-3.5 flex flex-col">
        {pasos.map((paso, idx) => (
          <div key={paso.titulo} className={`relative flex gap-3 ${idx < pasos.length - 1 ? "pb-3.5" : ""}`}>
            {idx < pasos.length - 1 && (
              <span className={`absolute left-[13px] top-7 bottom-0.5 w-0.5 ${paso.estado === "hecho" ? "bg-[#6105dc]" : "bg-[#e2d6f6]"}`}></span>
            )}
            <span
              className={`w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-bold ${
                paso.estado === "hecho"
                  ? "bg-[#6105dc] text-white"
                  : paso.estado === "actual"
                  ? "bg-white text-[#6105dc] ring-2 ring-[#6105dc] shadow-[0_0_0_6px_rgba(97,5,220,0.14)]"
                  : "bg-[#f4eefe] text-[#78729a]"
              }`}
            >
              {paso.estado === "hecho" ? <i className="fa-solid fa-check text-[11px]"></i> : idx + 1}
            </span>
            <div>
              <p className={`text-sm font-bold leading-snug ${paso.estado === "actual" ? "text-[#4d04b0]" : "text-[#1c1830]"}`}>{paso.titulo}</p>
              <p className="text-[12.5px] text-[#78729a] leading-snug">{paso.detalle}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] pl-[18px] pr-3.5 py-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10.5px] font-bold tracking-[0.08em] uppercase text-[#78729a]">Código del pedido</p>
          <p className="text-[26px] font-mono font-bold tracking-[0.16em] text-[#1c1830] leading-tight">{codigo}</p>
        </div>
        <button
          onClick={copiarCodigo}
          className="h-[38px] px-3.5 rounded-full bg-[#f4eefe] text-[#4d04b0] text-[12.5px] font-bold flex items-center gap-1.5 shrink-0"
        >
          <i className={`fa-regular ${copiado ? "fa-circle-check" : "fa-copy"} text-xs`}></i>
          {copiado ? "Copiado" : "Copiar"}
        </button>
      </div>

      {reserva && (
        <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] flex items-center gap-3 px-3.5 py-3">
          <span className="w-10 h-10 rounded-[14px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
            <i className="fa-regular fa-calendar-check text-sm"></i>
          </span>
          <div className="min-w-0">
            <p className="text-[10.5px] font-bold tracking-[0.07em] uppercase text-[#78729a]">Tu cita</p>
            <p className="text-sm font-bold text-[#1c1830] leading-snug">{fechaCitaTitulo(reserva.fecha)} · {reserva.hora}</p>
            <p className="text-xs text-[#78729a]">Barbero: {reserva.barbero || "Cualquiera"}{bodega.direccion ? ` · ${bodega.direccion}` : ""}</p>
          </div>
        </div>
      )}

      {resumen && !reserva && (
        <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] overflow-hidden">
          {domicilio ? (
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="w-10 h-10 rounded-[14px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
                <i className="fa-solid fa-motorcycle text-sm"></i>
              </span>
              <div className="min-w-0">
                <p className="text-[10.5px] font-bold tracking-[0.07em] uppercase text-[#78729a]">Entregar en</p>
                <p className="text-sm font-bold text-[#1c1830] leading-snug line-clamp-2">{resumen.referencia}</p>
                <p className="text-xs text-[#78729a]">Tel. {resumen.telefono} · ubicación marcada en el mapa</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="w-10 h-10 rounded-[14px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
                <i className="fa-solid fa-store text-sm"></i>
              </span>
              <div className="min-w-0">
                <p className="text-[10.5px] font-bold tracking-[0.07em] uppercase text-[#78729a]">Retiras en</p>
                <p className="text-sm font-bold text-[#1c1830] leading-snug">{bodega.nombre}</p>
                {bodega.direccion && <p className="text-xs text-[#78729a] line-clamp-2">{bodega.direccion}</p>}
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 px-3.5 py-3 border-t border-[#efe6fc]">
            <span className="w-10 h-10 rounded-[14px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
              <i className={`fa-solid ${domicilio ? "fa-money-bill-wave" : "fa-bag-shopping"} text-sm`}></i>
            </span>
            <div className="min-w-0">
              <p className="text-[10.5px] font-bold tracking-[0.07em] uppercase text-[#78729a]">
                {domicilio ? "Pagas al recibir" : `Tu pedido · ${resumen.unidades} producto${resumen.unidades === 1 ? "" : "s"}`}
              </p>
              <p className="text-sm font-bold text-[#1c1830]">Total {formatoMoneda(resumen.total)}</p>
              <p className="text-xs text-[#78729a]">
                {domicilio
                  ? `${TEXTO_MEDIO_PAGO[resumen.medioPago] || ""}${resumen.pagaCon ? `, con ${formatoMoneda(resumen.pagaCon)}` : ""} · incluye envío ${formatoMoneda(resumen.costoEnvio)}`
                  : "Pagas en caja al retirar"}
              </p>
            </div>
          </div>
        </div>
      )}

      {domicilio && (
        <p className="text-[12.5px] text-amber-700 bg-amber-100 rounded-2xl px-3.5 py-2.5 flex items-start gap-2 leading-snug">
          <i className="fa-regular fa-clock mt-0.5"></i>
          <span>Ten el dinero listo. El repartidor te avisa al llegar.</span>
        </p>
      )}

      <div className="flex-1"></div>

      <a
        href={whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="h-14 rounded-full bg-gradient-to-r from-[#8a3df2] to-[#4d04b0] text-white font-bold text-[15.5px] flex items-center justify-center gap-2.5"
      >
        <i className="fa-brands fa-whatsapp text-xl"></i> Enviar por WhatsApp
      </a>
      <div className="flex gap-2">
        {onVerPedidos && (
          <button
            onClick={onVerPedidos}
            className="flex-1 h-[46px] rounded-full bg-white ring-1 ring-[#e6dcf7] text-[#4d04b0] font-semibold text-[13.5px] flex items-center justify-center gap-1.5"
          >
            <i className="fa-solid fa-receipt text-xs"></i> Ver mis pedidos
          </button>
        )}
        <button
          onClick={onVolver}
          className="flex-1 h-[46px] rounded-full bg-white ring-1 ring-[#e6dcf7] text-[#4d04b0] font-semibold text-[13.5px] flex items-center justify-center gap-1.5"
        >
          <i className="fa-solid fa-store text-xs"></i> Volver al catálogo
        </button>
      </div>
    </div>
  );
}

// Hoja inferior (en celular) o cuadro centrado (en pantalla grande) con el
// estilo de la app: fondo violeta oscuro con desenfoque, esquinas muy
// redondeadas, título y botón de cerrar. Las hojas de la app la comparten.
function HojaInferior({ titulo, onCerrar, children, ancho = "sm:max-w-sm", alto = "", sinCerrarFuera = false }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[#1c1830]/45 backdrop-blur-[3px] sm:p-4"
      onClick={sinCerrarFuera ? undefined : onCerrar}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`kd-hoja w-full ${ancho} ${alto} bg-white rounded-t-[28px] sm:rounded-[28px] shadow-2xl flex flex-col min-h-0`}
      >
        <div className="w-[38px] h-1 rounded bg-[#e3d9f5] mx-auto mt-2.5 sm:hidden shrink-0"></div>
        <div className="flex items-center justify-between gap-3 px-[18px] pt-3.5 pb-2 shrink-0">
          <h2 className="text-[17px] font-extrabold tracking-tight text-[#1c1830]">{titulo}</h2>
          {onCerrar && (
            <button onClick={onCerrar} aria-label="Cerrar" className="w-9 h-9 rounded-full bg-[#f4f1f9] text-[#78729a] flex items-center justify-center shrink-0">
              <i className="fa-solid fa-xmark"></i>
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function IconGoogle() {
  return (
    <svg viewBox="0 0 48 48" className="w-4 h-4">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4c-7.4 0-13.8 4.2-17 10.3l-.7.4z" />
      <path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.2-5.1l-6.6-5.4C29.6 35.3 27 36 24 36c-5.2 0-9.6-3.3-11.2-7.9l-6.6 5.1C9.9 39.5 16.4 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.5l6.6 5.4C41.6 35.6 44 30.2 44 24c0-1.3-.1-2.7-.4-3.5z" />
    </svg>
  );
}

function ModalCuenta({ onCerrar, onGoogle }) {
  return (
    <HojaInferior titulo="Ingresar" onCerrar={onCerrar}>
      <div className="px-[18px] pb-6 pt-1 flex flex-col gap-3">
        <div className="flex items-center gap-3 bg-[#f4eefe] rounded-[20px] px-3.5 py-3">
          <span className="w-10 h-10 rounded-full bg-white text-[#6105dc] flex items-center justify-center shrink-0">
            <i className="fa-solid fa-bag-shopping"></i>
          </span>
          <p className="text-[12.5px] leading-snug text-[#4d04b0]">
            Con tu cuenta ves el estado de tus pedidos, guardás tus tiendas favoritas y te avisamos cuando tu pedido esté listo.
          </p>
        </div>
        <button
          type="button"
          onClick={onGoogle}
          className="w-full h-12 rounded-full bg-white ring-1 ring-[#e6dcf7] shadow-sm text-[#1c1830] font-bold text-sm flex items-center justify-center gap-2.5 active:scale-[0.98] transition"
        >
          <IconGoogle /> Continuar con Google
        </button>
        <p className="text-[11.5px] text-[#78729a] text-center">
          Entrás con tu cuenta de Google: no hace falta crear ni recordar ningún PIN.
        </p>
        <p className="text-[11px] text-[#a29cbd] text-center leading-snug">
          Al continuar aceptás los{" "}
          <a href="https://kaserita.smartdeskapps.com/terminos-delivery.html" target="_blank" rel="noopener noreferrer" className="underline">Términos</a> y la{" "}
          <a href="https://kaserita.smartdeskapps.com/privacidad.html" target="_blank" rel="noopener noreferrer" className="underline">Política de privacidad</a>.
        </p>
      </div>
    </HojaInferior>
  );
}

// Se muestra después de entrar con Google por primera vez -- clientes_delivery
// exige un celular único (es lo que identifica al cliente para el dueño de la
// bodega), y Google no lo entrega, así que hace falta este único paso más.
function ModalCompletarPerfil({ inicial, onListo, onCancelar }) {
  const [nombre, setNombre] = useState(inicial.nombre || "");
  const [telefono, setTelefono] = useState("");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");

  const guardar = async (e) => {
    e.preventDefault();
    setError("");
    const tel = telefono.replace(/\D/g, "");
    if (tel.length < 6) return setError("Ingresa un celular válido.");
    if (!nombre.trim()) return setError("Ingresa tu nombre.");
    setCargando(true);
    try {
      const { data: userData } = await sbClient.auth.getUser();
      const { data: cliente, error: errInsert } = await sbClient
        .from("clientes_delivery")
        .insert({ auth_id: userData.user.id, nombre: nombre.trim(), telefono: tel })
        .select()
        .single();
      if (errInsert) {
        throw new Error(
          /duplicate/i.test(errInsert.message)
            ? "Ese celular ya tiene una cuenta creada con otro usuario."
            : "No se pudo crear tu cuenta."
        );
      }
      onListo(cliente);
    } catch (err) {
      setError(err.message || "Algo salió mal, intenta de nuevo.");
    } finally {
      setCargando(false);
    }
  };

  return (
    <HojaInferior titulo="Ya casi, un dato más" sinCerrarFuera>
      <div className="px-[18px] pb-6 pt-1 flex flex-col gap-3">
        <p className="text-[12.5px] text-[#78729a]">Necesitamos tu WhatsApp para poder avisarte de tus pedidos.</p>
        <form onSubmit={guardar} className="flex flex-col gap-2.5">
          <input
            type="text"
            placeholder="Tu nombre"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="w-full h-12 rounded-2xl bg-[#f7f4fc] ring-1 ring-[#efe6fc] px-4 text-sm text-[#1c1830] placeholder-[#a29cbd] focus:outline-none focus:ring-2 focus:ring-[#6105dc]/40"
          />
          <input
            type="tel"
            placeholder="Tu celular (WhatsApp)"
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            className="w-full h-12 rounded-2xl bg-[#f7f4fc] ring-1 ring-[#efe6fc] px-4 text-sm text-[#1c1830] placeholder-[#a29cbd] focus:outline-none focus:ring-2 focus:ring-[#6105dc]/40"
          />
          {error && <p className="text-xs text-rose-600 px-1">{error}</p>}
          <button type="submit" disabled={cargando} className="w-full h-12 rounded-full bg-[#6105dc] hover:bg-[#4d04b0] text-white font-bold text-sm disabled:opacity-50 active:scale-[0.98] transition">
            {cargando ? "Un momento..." : "Continuar"}
          </button>
        </form>
        <button onClick={onCancelar} className="w-full text-center text-xs text-[#78729a] underline">
          Cancelar y salir
        </button>
      </div>
    </HojaInferior>
  );
}

// ---------------------------------------------------------------
// Entrega a domicilio: el local reparte con su propio repartidor. El
// cliente marca su ubicación (GPS o pin en el mapa) y el local la recibe
// en el pedido para reenviarla por WhatsApp.
// ---------------------------------------------------------------
const CENTRO_MAPA_POR_DEFECTO = [-12.0464, -77.0428];
const MEDIOS_PAGO_ENTREGA = [
  { id: "efectivo", texto: "Efectivo", icono: "fa-money-bill-wave" },
  { id: "yape_plin", texto: "Yape / Plin", icono: "fa-mobile-screen" },
  { id: "tarjeta", texto: "Tarjeta", icono: "fa-credit-card" },
];
const TEXTO_MEDIO_PAGO = { efectivo: "Efectivo", yape_plin: "Yape / Plin", tarjeta: "Tarjeta" };
const PIN_MAPA_HTML =
  '<svg viewBox="0 0 24 24" width="40" height="40" style="filter:drop-shadow(0 4px 4px rgba(76,29,149,.35))"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="#7c3aed" stroke="#fff" stroke-width="1.4"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>';

function enlaceMapa(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// Mapa con pin movible (Leaflet + OpenStreetMap: gratis y sin claves).
// Leaflet se carga recién cuando el cliente elige "A domicilio", para no
// sumarle peso a la vitrina de quien solo retira en tienda.
function MapaEntrega({ punto, onCambiar, alto = "h-[200px]", redondeo = "rounded-2xl" }) {
  const contenedorRef = useRef(null);
  const mapaRef = useRef(null);
  const marcadorRef = useRef(null);
  const leafletRef = useRef(null);
  const onCambiarRef = useRef(onCambiar);
  onCambiarRef.current = onCambiar;
  const [falloMapa, setFalloMapa] = useState(false);
  const [listo, setListo] = useState(false);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [leaflet] = await Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]);
        const L = leaflet.default || leaflet;
        if (cancelado || !contenedorRef.current) return;
        leafletRef.current = L;
        const mapa = L.map(contenedorRef.current, { zoomControl: false }).setView(
          punto ? [punto.lat, punto.lng] : CENTRO_MAPA_POR_DEFECTO,
          punto ? 17 : 13
        );
        L.control.zoom({ position: "topright" }).addTo(mapa);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap",
        }).addTo(mapa);
        mapa.on("click", (e) => {
          onCambiarRef.current({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) });
        });
        mapaRef.current = mapa;
        setListo(true);
      } catch (err) {
        console.warn("No se pudo cargar el mapa:", err);
        if (!cancelado) setFalloMapa(true);
      }
    })();
    return () => {
      cancelado = true;
      if (mapaRef.current) {
        mapaRef.current.remove();
        mapaRef.current = null;
        marcadorRef.current = null;
      }
    };
  }, []);

  // El pin sigue al punto elegido (por toque, arrastre o GPS).
  useEffect(() => {
    const L = leafletRef.current;
    const mapa = mapaRef.current;
    if (!listo || !L || !mapa || !punto) return;
    const pos = [punto.lat, punto.lng];
    if (!marcadorRef.current) {
      const icono = L.divIcon({ className: "", html: PIN_MAPA_HTML, iconSize: [40, 40], iconAnchor: [20, 40] });
      const marcador = L.marker(pos, { icon: icono, draggable: true }).addTo(mapa);
      marcador.on("dragend", () => {
        const ll = marcador.getLatLng();
        onCambiarRef.current({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) });
      });
      marcadorRef.current = marcador;
    } else {
      marcadorRef.current.setLatLng(pos);
    }
    mapa.setView(pos, Math.max(mapa.getZoom(), 17));
  }, [punto, listo]);

  if (falloMapa) {
    return (
      <div className={`${alto} ${redondeo} bg-stone-100 flex items-center justify-center text-center px-4 text-xs text-stone-500`}>
        No se pudo cargar el mapa. Usa el botón “Usar mi ubicación actual”.
      </div>
    );
  }
  return (
    <div className={`relative ${alto} ${redondeo} overflow-hidden bg-stone-100`}>
      <div ref={contenedorRef} className="absolute inset-0"></div>
      {!punto && listo && (
        <div className="absolute left-2 bottom-6 z-[500] bg-white/95 rounded-full px-3 py-1 text-[11px] text-stone-600 shadow pointer-events-none">
          Toca el mapa para poner el pin
        </div>
      )}
    </div>
  );
}

const ETIQUETAS_ESTADO_PEDIDO = {
  pendiente: { texto: "En preparación", color: "bg-amber-100 text-amber-700" },
  listo: { texto: "¡Listo para retirar!", color: "bg-violet-100 text-violet-700" },
  en_camino: { texto: "En camino", color: "bg-violet-100 text-violet-700" },
  retirado: { texto: "Retirado", color: "bg-stone-100 text-stone-500" },
  cancelado: { texto: "Cancelado", color: "bg-rose-100 text-rose-600" },
};

// En un pedido a domicilio "listo" quiere decir "armado, sale en breve" y
// el final es "Entregado" (en la base sigue siendo 'retirado').
function etiquetaEstadoPedido(p) {
  if (p.tipo_entrega === "domicilio") {
    if (p.estado === "listo") return { texto: "Listo, sale en breve", color: "bg-violet-100 text-violet-700" };
    if (p.estado === "retirado") return { texto: "Entregado", color: "bg-stone-100 text-stone-500" };
  }
  return ETIQUETAS_ESTADO_PEDIDO[p.estado] || ETIQUETAS_ESTADO_PEDIDO.pendiente;
}

// Los pedidos que todavía se están moviendo; el resto (retirado, cancelado) es historial.
const ESTADOS_EN_CURSO = ["pendiente", "listo", "en_camino"];

// "Hoy, 3:45 p. m." / "Ayer, 9:10 a. m." / "12 oct, 7:30 p. m." (con año si es de otro año).
function fechaPedido(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const ahora = new Date();
  const inicioDia = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((inicioDia(ahora) - inicioDia(d)) / 86400000);
  const hora = d.toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" });
  if (dias === 0) return `Hoy, ${hora}`;
  if (dias === 1) return `Ayer, ${hora}`;
  const opciones = { day: "numeric", month: "short" };
  if (d.getFullYear() !== ahora.getFullYear()) opciones.year = "numeric";
  return `${d.toLocaleDateString("es-PE", opciones)}, ${hora}`;
}

// Pasos visuales de "Mis pedidos": el mismo estado de siempre
// (pendiente/listo/retirado/cancelado) pero mostrado como progreso, no
// solo como una etiqueta de color -- para que el cliente entienda de un
// vistazo en qué momento va su pedido, igual que una app de delivery.
const PASOS_PEDIDO = [
  { texto: "Enviado", icono: "fa-paper-plane" },
  { texto: "Preparando", icono: "fa-kitchen-set" },
  { texto: "Listo", icono: "fa-bell-concierge" },
  { texto: "Retirado", icono: "fa-bag-shopping" },
];
const PASO_ACTUAL_POR_ESTADO = { pendiente: 1, listo: 2, retirado: 3 };
const PASOS_PEDIDO_DOMICILIO = [
  { texto: "Enviado", icono: "fa-paper-plane" },
  { texto: "Preparando", icono: "fa-kitchen-set" },
  { texto: "En camino", icono: "fa-motorcycle" },
  { texto: "Entregado", icono: "fa-house" },
];
const PASO_ACTUAL_DOMICILIO = { pendiente: 1, listo: 1, en_camino: 2, retirado: 3 };

// Con el texto del navegador muy ampliado, cuatro columnas ya no caben sin cortar
// las palabras: el progreso pasa a una lista vertical.
function useTextoGrande() {
  const [grande, setGrande] = useState(false);
  useEffect(() => {
    const medir = () => setGrande(parseFloat(getComputedStyle(document.documentElement).fontSize) >= 24);
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, []);
  return grande;
}

function StepperPedido({ estado, tipoEntrega }) {
  const vertical = useTextoGrande();
  if (estado === "cancelado") {
    return (
      <div className="flex items-center gap-2 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
        <i className="fa-solid fa-circle-xmark text-rose-500 text-xs" aria-hidden="true"></i>
        <span className="text-xs font-semibold text-rose-600">Este pedido fue cancelado</span>
      </div>
    );
  }
  const domicilio = tipoEntrega === "domicilio";
  // En domicilio, "listo" (armado, sale en breve) cae dentro del paso 2: ahí el
  // paso se llama "Listo", para que el progreso diga lo mismo que la etiqueta.
  const pasos = (domicilio ? PASOS_PEDIDO_DOMICILIO : PASOS_PEDIDO).map((paso, i) =>
    domicilio && estado === "listo" && i === 1 ? { texto: "Listo", icono: "fa-bell-concierge" } : paso
  );
  const actual = (domicilio ? PASO_ACTUAL_DOMICILIO : PASO_ACTUAL_POR_ESTADO)[estado] ?? 0;
  // El estado de cada paso se ve de tres formas, no solo por color: un check
  // (hecho), el ícono con halo (actual) o un círculo con borde (pendiente); y
  // un lector de pantalla lo oye como texto.
  return (
    <ol aria-label="Progreso del pedido" className={vertical ? "flex flex-col" : "flex items-start"}>
      {pasos.map((paso, i) => {
        const esActual = i === actual && estado !== "retirado";
        const hecho = i <= actual && !esActual;
        const textoEstado = hecho ? "completado" : esActual ? "paso actual" : "pendiente";
        return (
          <li
            key={paso.texto}
            aria-current={esActual ? "step" : undefined}
            className={vertical ? "relative flex items-center gap-3 pb-4 last:pb-0" : "relative flex-1 min-w-0 flex flex-col items-center gap-1.5"}
          >
            {i < pasos.length - 1 && (
              <span
                aria-hidden="true"
                className={`absolute ${vertical ? "left-[calc(1rem-1px)] top-8 bottom-0 w-0.5" : "top-[15px] left-1/2 w-full h-0.5"} ${i < actual ? "bg-[#6105dc]" : "bg-[#d9d0ec]"}`}
              ></span>
            )}
            <span
              aria-hidden="true"
              className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center text-xs ${
                hecho
                  ? "bg-[#6105dc] text-white"
                  : esActual
                  ? "bg-[#6105dc] text-white shadow-[0_0_0_5px_rgba(97,5,220,0.16)]"
                  : "bg-white text-[#6b6590] border-2 border-[#8f89ab]"
              }`}
            >
              <i className={`fa-solid ${hecho ? "fa-check" : paso.icono}`}></i>
            </span>
            <span className={`text-[0.6875rem] font-semibold leading-tight break-words max-w-full ${vertical ? "text-left" : "text-center"} ${hecho || esActual ? "text-[#4d04b0]" : "text-[#6b6590]"}`}>
              {paso.texto}
              <span className="sr-only"> ({textoEstado})</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function PantallaMisPedidos({ cliente, onVolver, bodegaActualId, onRepetirPedido }) {
  const [pedidos, setPedidos] = useState([]);
  const [nombresBodegas, setNombresBodegas] = useState({});
  const [cargando, setCargando] = useState(true);
  const [activandoPush, setActivandoPush] = useState(false);
  const [avisoPush, setAvisoPush] = useState("");
  const [copiadoId, setCopiadoId] = useState(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [confirmarCancelar, setConfirmarCancelar] = useState(null); // el pedido que se quiere cancelar
  const [cancelando, setCancelando] = useState(false);
  const [errorCancelar, setErrorCancelar] = useState("");
  const [permisoPush, setPermisoPush] = useState(permisoNotificaciones);
  const [anuncio, setAnuncio] = useState("");
  const estadosPrevios = useRef(null); // { [id pedido]: estado } de la lectura anterior

  const copiarCodigoPedido = async (p) => {
    try {
      await navigator.clipboard.writeText(p.codigo_corto);
      setCopiadoId(p.id);
      setTimeout(() => setCopiadoId((actual) => (actual === p.id ? null : actual)), 2000);
    } catch {
      // sin portapapeles: el código igual se ve en pantalla
    }
  };

  const cargar = useCallback((silencioso = false) => {
    if (!silencioso) setCargando(true);
    // Solo los pedidos de la tienda que se tiene abierta (la cuenta del cliente
    // es una sola para todas las tiendas, pero cada tienda muestra los suyos).
    let consulta = sbClient.from("pedidos_seguimiento").select("*");
    if (bodegaActualId) consulta = consulta.eq("bodega_id", bodegaActualId);
    consulta
      .order("creado_en", { ascending: false })
      .then(async ({ data, error }) => {
        setCargando(false);
        if (error) {
          // Un fallo no debe verse como "no tienes pedidos". Si ya había una lista
          // en pantalla y solo falló una actualización en segundo plano, se deja.
          if (!silencioso) setErrorCarga(true);
          return;
        }
        setErrorCarga(false);
        const filas = data || [];
        setPedidos(filas);
        // Si la tienda cambió el estado de un pedido mientras el cliente miraba la
        // pantalla, se anuncia a lectores de pantalla y, si ya está listo, vibra.
        const previos = estadosPrevios.current;
        if (previos) {
          const cambiados = filas.filter((p) => previos[p.id] && previos[p.id] !== p.estado);
          if (cambiados.length) {
            setAnuncio(cambiados.map((p) => `Tu pedido ${p.codigo_corto}: ${etiquetaEstadoPedido(p).texto}`).join(". "));
            if (cambiados.some((p) => p.estado === "listo") && typeof navigator.vibrate === "function") {
              navigator.vibrate([200, 100, 200]);
            }
          }
        }
        estadosPrevios.current = Object.fromEntries(filas.map((p) => [p.id, p.estado]));
        // La cuenta es global por teléfono, no por bodega -- si el cliente
        // compró en más de una, hay que aclarar cuál es cuál.
        const idsUnicos = [...new Set(filas.map((p) => p.bodega_id))];
        if (idsUnicos.length > 1) {
          const { data: bodegas } = await sbClient.rpc("obtener_nombres_bodegas", { p_ids: idsUnicos });
          const mapa = {};
          (bodegas || []).forEach((b) => { mapa[b.bodega_id] = b.nombre; });
          setNombresBodegas(mapa);
        }
      });
  }, [bodegaActualId]);

  useEffect(() => { cargar(); }, [cargar]);

  // En vivo: cualquier cambio en los pedidos de este cliente (la bodega lo
  // marca listo, retirado o cancelado; o él mismo hace uno nuevo) refresca
  // la lista sin recargar. Los celulares suspenden la conexión con la
  // pestaña en segundo plano y se pierden eventos, así que además se
  // vuelve a leer al regresar a la pestaña o al recuperar internet.
  useEffect(() => {
    const canal = sbClient
      .channel(`mis-pedidos-${cliente.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pedidos_seguimiento", filter: `cliente_id=eq.${cliente.id}` },
        () => cargar(true)
      )
      .subscribe();
    const alVolver = () => {
      if (document.visibilityState === "visible") cargar(true);
    };
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("online", alVolver);
    return () => {
      sbClient.removeChannel(canal);
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("online", alVolver);
    };
  }, [cliente.id, cargar]);

  const activarPush = async () => {
    setAvisoPush("");
    setActivandoPush(true);
    try {
      await activarNotificaciones(cliente.id);
      setAvisoPush("¡Listo! Te avisaremos aquí cuando tu pedido esté listo.");
    } catch (err) {
      setAvisoPush(err.message || "No se pudo activar.");
    } finally {
      setActivandoPush(false);
      setPermisoPush(permisoNotificaciones());
    }
  };

  const pedirCancelar = (p) => {
    setErrorCancelar("");
    setConfirmarCancelar(p);
  };

  const cerrarConfirmacion = useCallback(() => {
    setConfirmarCancelar(null);
    setErrorCancelar("");
  }, []);

  const confirmarCancelacion = async () => {
    if (!confirmarCancelar || cancelando) return;
    setCancelando(true);
    setErrorCancelar("");
    const { error } = await sbClient.rpc("cancelar_seguimiento_pedido", { p_id: confirmarCancelar.id });
    setCancelando(false);
    if (error) {
      // Lo más común: la tienda ya lo despachó y ya no se puede cancelar.
      setErrorCancelar("No pudimos cancelar el pedido. Puede que la tienda ya lo haya despachado. Actualizamos tu lista.");
      cargar(true);
      return;
    }
    cerrarConfirmacion();
    cargar(true);
  };

  // Escape cierra la confirmación (salvo mientras se cancela).
  useEffect(() => {
    if (!confirmarCancelar) return undefined;
    const alTeclear = (e) => { if (e.key === "Escape" && !cancelando) cerrarConfirmacion(); };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, [confirmarCancelar, cancelando, cerrarConfirmacion]);

  const enCurso = pedidos.filter((p) => ESTADOS_EN_CURSO.includes(p.estado));
  const anteriores = pedidos.filter((p) => !ESTADOS_EN_CURSO.includes(p.estado));

  const detalleProductos = (p) => (
    <>
      <div className="text-[0.78125rem] text-[#6b6590] space-y-1">
        {(p.items || []).map((it, i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <span>{it.cantidad} × {it.combo_id ? it.descripcion : tituloProducto(it.descripcion)}</span>
            <span className="shrink-0 tabular-nums">{formatoMoneda(it.precio_venta * it.cantidad)}</span>
          </div>
        ))}
      </div>
      {p.cita_fecha && (
        <p className="text-xs text-[#6b6590] pt-2 border-t border-[#efe6fc]">
          Cita: {fechaCitaTitulo(p.cita_fecha)} · {p.cita_hora}
          {p.cita_barbero ? ` · ${p.cita_barbero}` : ""}
        </p>
      )}
      {p.tipo_entrega === "domicilio" && (
        <div className="text-xs text-[#6b6590] space-y-1 pt-2 border-t border-[#efe6fc]">
          <div className="flex items-center justify-between gap-2">
            <span>Envío a domicilio</span>
            <span className="shrink-0 tabular-nums">{formatoMoneda(p.costo_envio)}</span>
          </div>
          {p.entrega_referencia && (
            <p className="flex items-start gap-1.5">
              <i className="fa-solid fa-location-dot mt-0.5 text-[#6b6590]" aria-hidden="true"></i>
              <span>{p.entrega_referencia}</span>
            </p>
          )}
          {p.medio_pago && <p>Pagas al recibir: {TEXTO_MEDIO_PAGO[p.medio_pago] || p.medio_pago}</p>}
        </div>
      )}
    </>
  );

  const botonPedirDeNuevo = (p) =>
    p.bodega_id === bodegaActualId && (
      <button
        onClick={() => onRepetirPedido(p)}
        className="min-h-11 text-xs font-bold text-[#4d04b0] bg-[#f4eefe] hover:bg-[#ece0fd] rounded-full px-3.5 flex items-center gap-1.5"
      >
        <i className="fa-solid fa-rotate-right text-[0.6875rem]" aria-hidden="true"></i> Pedir de nuevo
      </button>
    );

  // Pedido que sigue en marcha: tarjeta completa con progreso (y ticket de retiro).
  const renderPedidoEnCurso = (p) => {
    // Retiro en tienda aún sin retirar: el código va como ticket, a la vista,
    // porque es lo que se muestra en caja.
    const mostrarTicket = p.tipo_entrega !== "domicilio" && (p.estado === "pendiente" || p.estado === "listo");
    const listo = p.estado === "listo";
    return (
      <div key={p.id} className="bg-white rounded-[26px] ring-1 ring-[#efe6fc] p-3.5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              {mostrarTicket ? (
                <span className="font-bold text-sm text-[#1c1830] truncate">{nombresBodegas[p.bodega_id] || "Pedido"}</span>
              ) : (
                <>
                  <span className="font-mono font-bold text-sm tracking-wide text-[#1c1830]">{p.codigo_corto}</span>
                  {nombresBodegas[p.bodega_id] && (
                    <span className="text-[0.6875rem] text-[#6b6590] truncate">{nombresBodegas[p.bodega_id]}</span>
                  )}
                </>
              )}
            </div>
            <p className="text-xs text-[#6b6590] mt-0.5">{fechaPedido(p.creado_en)}</p>
          </div>
          {/* Con el ticket "listo" a la vista, la etiqueta repetiría lo mismo. */}
          {!(mostrarTicket && listo) && (
            <span className={`text-[0.6875rem] font-bold px-2.5 py-1 rounded-full shrink-0 ${etiquetaEstadoPedido(p).color}`}>
              {etiquetaEstadoPedido(p).texto}
            </span>
          )}
        </div>

        <div className="py-0.5">
          <StepperPedido estado={p.estado} tipoEntrega={p.tipo_entrega} />
        </div>

        {detalleProductos(p)}

        {mostrarTicket && (
          <div
            className={`relative rounded-[20px] px-3.5 py-3.5 text-center ${
              listo ? "bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] text-white" : "bg-[#f4eefe]"
            }`}
          >
            <span className="absolute -left-2 top-1/2 -mt-2 w-4 h-4 rounded-full bg-white ring-1 ring-[#efe6fc]"></span>
            <span className="absolute -right-2 top-1/2 -mt-2 w-4 h-4 rounded-full bg-white ring-1 ring-[#efe6fc]"></span>
            <p className={`text-[0.6875rem] font-bold tracking-[0.08em] uppercase ${listo ? "text-white" : "text-[#6b6590]"}`}>
              {listo ? "¡Listo para retirar!" : "Tu código de retiro"}
            </p>
            <div className={`border-t-2 border-dashed my-2.5 ${listo ? "border-white/40" : "border-[#d9cdf3]"}`}></div>
            <button
              type="button"
              onClick={() => copiarCodigoPedido(p)}
              aria-label={`Copiar código ${p.codigo_corto}`}
              className={`min-h-11 px-2 font-mono text-[1.875rem] font-extrabold tracking-[0.2em] leading-tight ${listo ? "text-white" : "text-[#1c1830]"}`}
            >
              {p.codigo_corto}
            </button>
            <p className={`text-xs mt-0.5 ${listo ? "text-white" : "text-[#6b6590]"}`}>
              {copiadoId === p.id
                ? "¡Código copiado!"
                : listo
                ? "Muéstralo en caja y pagas al retirar"
                : "Lo necesitarás al retirar · toca para copiar"}
            </p>
          </div>
        )}

        <div className="flex items-baseline justify-between pt-2.5 border-t border-[#efe6fc]">
          <span className="text-xs font-semibold text-[#6b6590]">Total</span>
          <span className="text-lg font-extrabold tracking-tight text-[#1c1830] tabular-nums">{formatoMoneda(totalPedido(p))}</span>
        </div>

        <div className="flex items-center justify-between gap-2">
          {(p.estado === "pendiente" || p.estado === "listo") ? (
            <button
              onClick={() => pedirCancelar(p)}
              className="min-h-11 -ml-2 px-2 text-xs font-semibold text-rose-600 underline underline-offset-2"
            >
              Cancelar pedido
            </button>
          ) : <span></span>}
          {botonPedirDeNuevo(p)}
        </div>
      </div>
    );
  };

  // Pedido terminado (retirado o cancelado): una fila compacta que se abre para ver el detalle.
  const renderPedidoAnterior = (p) => (
    <details key={p.id} className="group bg-white rounded-[22px] ring-1 ring-[#efe6fc]">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer min-h-14 px-3.5 py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono font-bold text-sm tracking-wide text-[#1c1830]">{p.codigo_corto}</span>
            {nombresBodegas[p.bodega_id] && (
              <span className="text-[0.6875rem] text-[#6b6590] truncate">{nombresBodegas[p.bodega_id]}</span>
            )}
          </div>
          <p className="text-xs text-[#6b6590] mt-0.5">{fechaPedido(p.creado_en)}</p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className="text-sm font-extrabold text-[#1c1830] tabular-nums">{formatoMoneda(totalPedido(p))}</span>
          <span className={`text-[0.6875rem] font-bold px-2.5 py-0.5 rounded-full ${etiquetaEstadoPedido(p).color}`}>
            {etiquetaEstadoPedido(p).texto}
          </span>
        </div>
        <i className="fa-solid fa-chevron-down text-xs text-[#6b6590] transition-transform motion-reduce:transition-none group-open:rotate-180" aria-hidden="true"></i>
      </summary>
      <div className="px-3.5 pb-3.5 pt-3 space-y-3 border-t border-[#efe6fc]">
        {detalleProductos(p)}
        {p.bodega_id === bodegaActualId && <div className="flex justify-end">{botonPedirDeNuevo(p)}</div>}
      </div>
    </details>
  );

  return (
    <div className="max-w-md mx-auto px-4 space-y-4 pb-32">
      <div className="sticky top-0 z-20 -mx-4 px-4 pt-6 pb-3 bg-[#fafaf9]/90 backdrop-blur flex items-center gap-3">
        <button
          onClick={onVolver}
          aria-label="Volver"
          className="w-11 h-11 rounded-full bg-white ring-1 ring-[#efe6fc] text-[#4d04b0] flex items-center justify-center shrink-0"
        >
          <i className="fa-solid fa-arrow-left text-sm" aria-hidden="true"></i>
        </button>
        <h1 className="text-[1.375rem] font-extrabold tracking-tight text-[#1c1830]">Mis pedidos</h1>
      </div>

      {permisoPush === "default" && (
        <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] px-3.5 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-[13px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
              <i className="fa-solid fa-bell text-sm" aria-hidden="true"></i>
            </span>
            <p className="text-xs text-[#6b6590] leading-snug">Activa las notificaciones para enterarte apenas tu pedido esté listo.</p>
          </div>
          <button
            onClick={activarPush}
            disabled={activandoPush}
            className="shrink-0 min-h-11 px-4 rounded-full bg-[#6105dc] text-white text-xs font-bold disabled:opacity-50"
          >
            {activandoPush ? "Activando..." : "Activar"}
          </button>
        </div>
      )}
      <p role="status" className={avisoPush ? "text-xs text-[#6b6590]" : "sr-only"}>{avisoPush}</p>
      <p role="status" aria-live="polite" className="sr-only">{anuncio}</p>

      {cargando ? (
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="sr-only">Cargando tus pedidos</span>
          {[0, 1].map((i) => (
            <div key={i} aria-hidden="true" className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] p-3.5 space-y-3 animate-pulse motion-reduce:animate-none">
              <div className="flex items-center justify-between gap-3">
                <div className="h-4 w-28 rounded-full bg-[#efe6fc]"></div>
                <div className="h-5 w-20 rounded-full bg-[#f4eefe]"></div>
              </div>
              <div className="flex items-center gap-3">
                {[0, 1, 2, 3].map((j) => (
                  <div key={j} className="flex-1 flex flex-col items-center gap-1.5">
                    <div className="w-8 h-8 rounded-full bg-[#efe6fc]"></div>
                    <div className="h-2.5 w-10 rounded-full bg-[#f4eefe]"></div>
                  </div>
                ))}
              </div>
              <div className="h-3 w-2/3 rounded-full bg-[#f4eefe]"></div>
            </div>
          ))}
        </div>
      ) : errorCarga ? (
        <div role="alert" className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] px-4 py-7 flex flex-col items-center text-center gap-2">
          <span className="w-[52px] h-[52px] rounded-full bg-[#fff1f3] text-[#e11d48] flex items-center justify-center">
            <i className="fa-solid fa-triangle-exclamation text-xl" aria-hidden="true"></i>
          </span>
          <h2 className="text-[1.0625rem] font-extrabold text-[#1c1830]">No pudimos cargar tus pedidos</h2>
          <p className="text-[0.78125rem] text-[#6b6590] leading-snug">Revisa tu conexión e inténtalo de nuevo.</p>
          <button
            onClick={() => cargar()}
            className="mt-1 h-11 px-6 rounded-full bg-[#6105dc] text-white text-sm font-bold active:scale-[0.98] transition-transform"
          >
            Reintentar
          </button>
        </div>
      ) : pedidos.length === 0 ? (
        <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] px-4 py-8 flex flex-col items-center text-center gap-2">
          <span className="w-[52px] h-[52px] rounded-full bg-[#f4eefe] text-[#4d04b0] flex items-center justify-center">
            <i className="fa-solid fa-bag-shopping text-xl" aria-hidden="true"></i>
          </span>
          <h2 className="text-[1.0625rem] font-extrabold text-[#1c1830]">Aún no tienes pedidos</h2>
          <p className="text-[0.78125rem] text-[#6b6590] leading-snug">Cuando hagas uno, podrás seguirlo aquí paso a paso.</p>
          <button
            onClick={onVolver}
            className="mt-1 h-11 px-6 rounded-full bg-[#6105dc] text-white text-sm font-bold active:scale-[0.98] transition-transform"
          >
            Ver la tienda
          </button>
        </div>
      ) : (
        <>
          {enCurso.length > 0 && (
            <section aria-labelledby="pedidos-en-curso" className="space-y-3">
              <h2 id="pedidos-en-curso" className="px-1 text-[0.8125rem] font-bold text-[#6b6590]">
                En curso <span className="font-semibold">({enCurso.length})</span>
              </h2>
              {enCurso.map(renderPedidoEnCurso)}
            </section>
          )}
          {anteriores.length > 0 && (
            <section aria-labelledby="pedidos-anteriores" className="space-y-2">
              <h2 id="pedidos-anteriores" className="px-1 text-[0.8125rem] font-bold text-[#6b6590]">
                Anteriores <span className="font-semibold">({anteriores.length})</span>
              </h2>
              {anteriores.map(renderPedidoAnterior)}
            </section>
          )}
        </>
      )}
      {confirmarCancelar && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-6 bg-[#1c1830]/45 backdrop-blur-[3px]"
          onClick={() => !cancelando && cerrarConfirmacion()}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cancelar-titulo"
            aria-describedby="cancelar-detalle"
            onClick={(e) => e.stopPropagation()}
            className="kd-pop w-full max-w-sm bg-white rounded-[28px] px-[18px] pt-[22px] pb-[18px] flex flex-col items-center text-center gap-2 shadow-[0_24px_50px_-18px_rgba(28,24,48,0.5)]"
          >
            <span className="w-[52px] h-[52px] rounded-full bg-[#fff1f3] text-[#e11d48] flex items-center justify-center">
              <i className="fa-solid fa-ban text-xl" aria-hidden="true"></i>
            </span>
            <h3 id="cancelar-titulo" className="text-[1.125rem] font-extrabold text-[#1c1830]">¿Cancelar este pedido?</h3>
            <p id="cancelar-detalle" className="text-[0.78125rem] text-[#6b6590] leading-snug">
              Pedido <span className="font-mono font-bold text-[#1c1830]">{confirmarCancelar.codigo_corto}</span>
              {nombresBodegas[confirmarCancelar.bodega_id] ? ` en ${nombresBodegas[confirmarCancelar.bodega_id]}` : ""}. Esta acción no se puede deshacer.
            </p>
            {errorCancelar && <p role="alert" className="text-xs text-rose-600 text-left w-full">{errorCancelar}</p>}
            <div className="w-full flex gap-2 mt-1">
              <button
                autoFocus
                onClick={cerrarConfirmacion}
                disabled={cancelando}
                className="flex-1 h-[46px] rounded-full bg-[#f4eefe] text-[#4d04b0] text-sm font-bold disabled:opacity-50 active:scale-[0.98] transition-transform"
              >
                Mantener pedido
              </button>
              <button
                onClick={confirmarCancelacion}
                disabled={cancelando}
                className="flex-1 h-[46px] rounded-full bg-[#e11d48] text-white text-sm font-bold disabled:opacity-40 active:scale-[0.98] transition-transform"
              >
                {cancelando ? "Cancelando..." : "Cancelar pedido"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Kaserita no tiene sus propios códigos QR con un formato especial -- son
// links comunes (https://.../slug-de-la-bodega). Esto acepta tanto un link
// completo como el slug pegado a mano, y navega directo al catálogo. La
// visita queda registrada sola por el useEffect de bodegas_visitadas que
// ya corre en cualquier página de bodega con sesión iniciada.
function irAlSlugDesdeTexto(texto) {
  let destino = (texto || "").trim();
  if (!destino) return;
  try {
    const url = new URL(destino);
    destino = url.pathname.replace(/^\/+/, "");
  } catch {
    destino = destino.replace(/^\/+/, "");
  }
  if (!destino) return;
  window.location.href = `/${destino}`;
}

// Las dos formas de recibir el pedido en una tienda de "Mis tiendas": retiro
// (siempre gratis) y delivery (costo y pedido mínimo, o apagado si la tienda no
// reparte). Si los datos no llegaron (aún no se corrió migration_36) no muestra
// nada, y la tarjeta queda como antes.
function ModalidadesEntrega({ t, oscuro = false }) {
  if (typeof t.delivery_domicilio !== "boolean") return null;
  const reparte = t.delivery_domicilio;
  const costo = Number(t.costo_envio || 0);
  const minimo = Number(t.pedido_minimo || 0);
  const caja = (activa) =>
    oscuro ? (activa ? "bg-white/[0.17]" : "bg-white/[0.08]") : activa ? "bg-[#f4eefe]" : "bg-[#f6f5f8]";
  const icono = (activa) =>
    oscuro ? (activa ? "text-white" : "text-white/45") : activa ? "text-[#6105dc]" : "text-[#c4c0d6]";
  const titulo = (activa) =>
    oscuro ? (activa ? "text-white" : "text-white/60") : activa ? "text-[#1c1830]" : "text-[#a8a3c2]";
  const detalle = (activa) =>
    oscuro ? (activa ? "text-white/85" : "text-white/55") : activa ? "text-[#78729a]" : "text-[#a8a3c2]";
  const textoMinimo = minimo > 0 ? ` · mín. S/ ${Number.isInteger(minimo) ? minimo : minimo.toFixed(2)}` : "";
  const casilla = (activa, iconoFa, nombre, texto) => (
    <div className={`rounded-2xl px-2.5 py-2 flex items-center gap-2 leading-tight ${caja(activa)}`}>
      <i className={`fa-solid ${iconoFa} text-[15px] shrink-0 ${icono(activa)}`}></i>
      <span className="min-w-0 text-[11.5px]">
        <b className={`block text-xs ${titulo(activa)}`}>{nombre}</b>
        <span className={detalle(activa)}>{texto}</span>
      </span>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-2">
      {casilla(true, "fa-bag-shopping", "Retiro", "Gratis")}
      {casilla(
        reparte,
        "fa-motorcycle",
        "Delivery",
        reparte ? `${costo > 0 ? formatoMoneda(costo) : "Gratis"}${textoMinimo}` : "No disponible"
      )}
    </div>
  );
}

function PantallaMisTiendas({ onVolver, esInicio = false }) {
  const [tiendas, setTiendas] = useState([]);
  const [ultimoPedidoPorBodega, setUltimoPedidoPorBodega] = useState({});
  const [ultimaVisitaPorBodega, setUltimaVisitaPorBodega] = useState({});
  const [favoritas, setFavoritas] = useState(() => new Set());
  const [idHabitual, setIdHabitual] = useState(null);
  // Items del último pedido (no cancelado) de cada bodega -- para "Pedir de nuevo".
  const [itemsUltimoPedido, setItemsUltimoPedido] = useState({});
  const [busqueda, setBusqueda] = useState("");
  const [cargando, setCargando] = useState(true);
  const [modalPegarLink, setModalPegarLink] = useState(false);
  const [linkPegado, setLinkPegado] = useState("");
  const [escaneando, setEscaneando] = useState(false);
  const [errorCamara, setErrorCamara] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  // BarcodeDetector es nativo del navegador (Chrome/Android) -- nada de
  // librerías nuevas, pero no existe en Safari/iOS, así que el botón de
  // escanear solo aparece donde realmente puede funcionar.
  const soportaEscaneo = typeof window !== "undefined" && "BarcodeDetector" in window;

  const detenerEscaneo = useCallback(() => {
    setEscaneando(false);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => detenerEscaneo(), [detenerEscaneo]);

  const iniciarEscaneo = async () => {
    setErrorCamara("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setEscaneando(true);
    } catch {
      setErrorCamara("No se pudo acceder a la cámara. Revisa los permisos, o pega el enlace directamente.");
    }
  };

  useEffect(() => {
    if (!escaneando || !videoRef.current || !streamRef.current) return;
    const video = videoRef.current;
    video.srcObject = streamRef.current;
    video.play().catch(() => {});
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    let activo = true;
    const detectar = async () => {
      if (!activo) return;
      try {
        const codigos = await detector.detect(video);
        if (codigos.length > 0) {
          activo = false;
          const valor = codigos[0].rawValue;
          detenerEscaneo();
          irAlSlugDesdeTexto(valor);
          return;
        }
      } catch {
        // ignorado -- un frame sin QR legible no es un error, se reintenta solo
      }
      if (activo) requestAnimationFrame(detectar);
    };
    requestAnimationFrame(detectar);
    return () => { activo = false; };
  }, [escaneando, detenerEscaneo]);

  useEffect(() => {
    // "Mis tiendas" sale de bodegas_visitadas (cualquier bodega a la que
    // entró el cliente logueado, haya pedido algo o no) -- antes salía
    // solo de pedidos_seguimiento, así que una bodega que solo se miró
    // nunca aparecía. obtener_nombres_bodegas de paso deja afuera
    // cualquier bodega que haya dejado de ofrecer delivery desde entonces.
    sbClient
      .from("bodegas_visitadas")
      .select("bodega_id, visto_en, favorita")
      .order("visto_en", { ascending: false })
      // Si todavía no se corrió migration_34 (no existe "favorita"), se vuelve a pedir sin esa columna.
      .then((r1) => (r1.error ? sbClient.from("bodegas_visitadas").select("bodega_id, visto_en").order("visto_en", { ascending: false }) : r1))
      .then(async ({ data: visitas }) => {
        const filasRecientes = visitas || [];
        // Las tiendas que sigue van primero; dentro de cada grupo, la más reciente arriba.
        const filas = filasRecientes.slice().sort((a, b) => Number(!!b.favorita) - Number(!!a.favorita));
        setFavoritas(new Set(filas.filter((v) => v.favorita).map((v) => v.bodega_id)));
        setIdHabitual(filasRecientes[0]?.bodega_id || null);
        const idsEnOrden = filas.map((v) => v.bodega_id);
        if (idsEnOrden.length === 0) {
          setCargando(false);
          return;
        }
        const visitasPorId = {};
        filas.forEach((v) => { visitasPorId[v.bodega_id] = v.visto_en; });
        setUltimaVisitaPorBodega(visitasPorId);
        const [{ data: bodegas }, { data: pedidos }] = await Promise.all([
          sbClient.rpc("obtener_nombres_bodegas", { p_ids: idsEnOrden }),
          sbClient.from("pedidos_seguimiento").select("bodega_id, creado_en, estado, items").order("creado_en", { ascending: false }),
        ]);
        const ultimos = {};
        const itemsUltimos = {};
        (pedidos || []).forEach((p) => {
          if (!ultimos[p.bodega_id]) ultimos[p.bodega_id] = p.creado_en;
          if (!itemsUltimos[p.bodega_id] && p.estado !== "cancelado" && Array.isArray(p.items) && p.items.length > 0) {
            itemsUltimos[p.bodega_id] = p.items;
          }
        });
        setUltimoPedidoPorBodega(ultimos);
        setItemsUltimoPedido(itemsUltimos);
        const porId = {};
        (bodegas || []).forEach((b) => { porId[b.bodega_id] = b; });
        setTiendas(idsEnOrden.map((id) => porId[id]).filter(Boolean));
        setCargando(false);
      });
  }, []);

  const tiendasFiltradas = useMemo(() => {
    const b = busqueda.trim().toLowerCase();
    if (!b) return tiendas;
    return tiendas.filter((t) => t.nombre?.toLowerCase().includes(b));
  }, [tiendas, busqueda]);

  // Seguir / dejar de seguir una tienda desde esta lista. La política de la
  // tabla solo deja modificar filas del propio cliente, así que basta con el bodega_id.
  const alternarFavorita = async (bodegaId) => {
    const nueva = !favoritas.has(bodegaId);
    const cambiar = (activa) =>
      setFavoritas((prev) => {
        const n = new Set(prev);
        if (activa) n.add(bodegaId);
        else n.delete(bodegaId);
        return n;
      });
    cambiar(nueva);
    const { error: err } = await sbClient.from("bodegas_visitadas").update(nueva ? { favorita: true, avisos: true } : { favorita: false }).eq("bodega_id", bodegaId);
    if (err) cambiar(!nueva);
  };

  // "Pedir de nuevo": deja el carrito de esa tienda armado con lo de su último
  // pedido (mismo lugar donde la vitrina guarda su carrito) y abre la tienda.
  // Los productos que ya no existan o no tengan stock se descartan solos al
  // cargar el catálogo, y el servidor vuelve a validar precio y stock al enviar.
  const pedirDeNuevo = (t) => {
    const items = itemsUltimoPedido[t.bodega_id] || [];
    const carritoNuevo = {};
    const combosNuevo = {};
    items.forEach((it) => {
      if (it.combo_id) combosNuevo[it.combo_id] = (combosNuevo[it.combo_id] || 0) + it.cantidad;
      else if (it.id) carritoNuevo[it.id] = (carritoNuevo[it.id] || 0) + it.cantidad;
    });
    try {
      localStorage.setItem(`kd_carrito_${t.slug}`, JSON.stringify(carritoNuevo));
      localStorage.setItem(`kd_carrito_combos_${t.slug}`, JSON.stringify(combosNuevo));
    } catch {
      // sin almacenamiento: se abre la tienda igual, con el carrito vacío
    }
    window.location.href = `/${t.slug}`;
  };

  return (
    <div className={`max-w-md mx-auto px-4 py-6 space-y-4 ${esInicio ? "pb-16" : "pb-32"}`}>
      <div className="flex items-center gap-3">
        {!esInicio && (
          <button
            onClick={onVolver}
            aria-label="Volver"
            className="w-10 h-10 rounded-full bg-white ring-1 ring-[#efe6fc] text-[#4d04b0] flex items-center justify-center shrink-0"
          >
            <i className="fa-solid fa-arrow-left text-sm"></i>
          </button>
        )}
        <h1 className="text-[22px] font-extrabold tracking-tight text-[#1c1830]">{esInicio ? "Tus bodegas" : "Mis tiendas"}</h1>
        {tiendas.length > 0 && (
          <span className="bg-[#ece0fd] text-[#4d04b0] text-[11.5px] font-bold px-2.5 py-0.5 rounded-full">
            {tiendas.length} guardada{tiendas.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {tiendas.length > 1 && (
        <div className="relative">
          <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-[#a29cbd] text-sm"></i>
          <input
            type="text"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar entre mis bodegas..."
            className="w-full bg-white border border-[#e6dcf7] rounded-full pl-11 pr-4 py-3 text-sm text-stone-800 placeholder-[#a29cbd] focus:outline-none focus:border-[#6105dc]/45 focus:ring-4 focus:ring-[#6105dc]/[0.07]"
          />
        </div>
      )}

      {cargando ? (
        <p className="text-center text-stone-400 py-10">Cargando...</p>
      ) : tiendas.length === 0 ? (
        <div className="text-center text-[#78729a] py-10 space-y-2">
          <i className="fa-solid fa-store text-2xl block text-[#cfc4ea]"></i>
          <p>Todavía no compraste en ninguna bodega.</p>
          <p className="text-xs">En cuanto hagas tu primer pedido, aparecerá aquí.</p>
        </div>
      ) : tiendasFiltradas.length === 0 ? (
        <p className="text-center text-[#78729a] py-10">No encontramos ninguna bodega con ese nombre.</p>
      ) : (
        <div className="space-y-3">
          {(() => {
            const habitualTienda = !busqueda.trim() ? tiendasFiltradas.find((t) => t.bodega_id === idHabitual) : null;
            const otras = tiendasFiltradas.filter((t) => t.bodega_id !== habitualTienda?.bodega_id);
            const indicadorAtencion = (estado, oscuro) =>
              estado ? (
                <span
                  className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1 shrink-0 ${
                    oscuro
                      ? "bg-white/20 text-white"
                      : estado.abierto
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-stone-100 text-stone-500"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${estado.abierto ? (oscuro ? "bg-green-300" : "bg-emerald-500") : oscuro ? "bg-white/50" : "bg-stone-400"}`}></span>
                  {estado.abierto ? "Abierto" : "Cerrado"}
                </span>
              ) : null;
            return (
              <>
                {habitualTienda && (() => {
                  const t = habitualTienda;
                  const estado = estadoAtencionBodega(t.horario_atencion);
                  const itemsUlt = itemsUltimoPedido[t.bodega_id];
                  const totalUlt = (itemsUlt || []).reduce((acc, it) => acc + it.precio_venta * it.cantidad, 0);
                  const resumen = (itemsUlt || [])
                    .map((it) => `${it.cantidad > 1 ? `${it.cantidad}× ` : ""}${it.combo_id ? it.descripcion : tituloProducto(it.descripcion)}`)
                    .join(", ");
                  return (
                    <div className="rounded-[30px] p-4 bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] text-white flex flex-col gap-3">
                      <div className="flex items-center gap-3">
                        <div className="w-[54px] h-[54px] rounded-[18px] bg-white/20 overflow-hidden shrink-0 flex items-center justify-center">
                          {t.logo_url ? (
                            <img src={t.logo_url} alt={t.nombre} className="w-full h-full object-cover" />
                          ) : (
                            <span className="font-extrabold text-xl">{t.nombre?.charAt(0).toUpperCase()}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-bold text-[17px] leading-tight">{t.nombre}</p>
                            {indicadorAtencion(estado, true)}
                          </div>
                          {t.direccion && (
                            <p className="text-xs text-white/80 flex items-center gap-1 mt-0.5">
                              <i className="fa-solid fa-location-dot text-[10px] shrink-0"></i>
                              <span className="line-clamp-1">{t.direccion}</span>
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => alternarFavorita(t.bodega_id)}
                          title={favoritas.has(t.bodega_id) ? "Dejar de seguir" : "Seguir esta tienda"}
                          className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center shrink-0 active:scale-90 transition"
                        >
                          <i className={`${favoritas.has(t.bodega_id) ? "fa-solid" : "fa-regular"} fa-heart text-sm`}></i>
                        </button>
                      </div>

                      <ModalidadesEntrega t={t} oscuro />

                      {itemsUlt ? (
                        <div className="bg-white/15 rounded-[20px] px-3.5 py-3 text-[12.5px] leading-relaxed">
                          <p className="text-[11px] font-bold uppercase tracking-wider text-white/75 mb-0.5">
                            Tu último pedido · {fechaRelativa(ultimoPedidoPorBodega[t.bodega_id]).toLowerCase()}
                          </p>
                          <span className="line-clamp-2">{resumen}</span>
                          <strong className="block mt-0.5">{formatoMoneda(totalUlt)}</strong>
                        </div>
                      ) : (
                        <p className="text-xs text-white/80">Todavía no hiciste pedidos en esta bodega.</p>
                      )}

                      <div className="flex gap-2">
                        {itemsUlt && (
                          <button
                            type="button"
                            onClick={() => pedirDeNuevo(t)}
                            className="flex-1 h-11 rounded-full bg-white text-[#4d04b0] font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition"
                          >
                            <i className="fa-solid fa-rotate-right text-xs"></i> Pedir de nuevo
                          </button>
                        )}
                        <a
                          href={`/${t.slug}`}
                          className={`flex-1 h-11 rounded-full font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition ${
                            itemsUlt ? "bg-white/20 text-white" : "bg-white text-[#4d04b0]"
                          }`}
                        >
                          Ver catálogo
                        </a>
                      </div>
                    </div>
                  );
                })()}

                {otras.length > 0 && (
                  <p className="text-xs font-bold uppercase tracking-wider text-[#78729a] px-1 pt-1">Otras bodegas</p>
                )}
                {otras.map((t) => {
                  const estado = estadoAtencionBodega(t.horario_atencion);
                  const sigue = favoritas.has(t.bodega_id);
                  return (
                    <div key={t.bodega_id} className="bg-white rounded-[26px] ring-1 ring-[#efe6fc] p-2.5 flex flex-col gap-2.5">
                     <div className="flex items-center gap-3">
                      <div className="w-[54px] h-[54px] rounded-[18px] bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] overflow-hidden shrink-0 flex items-center justify-center text-white">
                        {t.logo_url ? (
                          <img src={t.logo_url} alt={t.nombre} className="w-full h-full object-cover" />
                        ) : (
                          <span className="font-extrabold text-xl">{t.nombre?.charAt(0).toUpperCase()}</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-[14.5px] text-[#1c1830] leading-tight truncate">{t.nombre}</p>
                        <div className="flex items-center gap-1.5 mt-1 text-xs text-[#78729a] min-w-0">
                          {indicadorAtencion(estado, false)}
                          <span className="truncate">
                            {ultimoPedidoPorBodega[t.bodega_id]
                              ? fechaRelativa(ultimoPedidoPorBodega[t.bodega_id])
                              : ultimaVisitaPorBodega[t.bodega_id]
                              ? `Visto: ${fechaRelativa(ultimaVisitaPorBodega[t.bodega_id]).toLowerCase()}`
                              : "Sin pedidos todavía"}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => alternarFavorita(t.bodega_id)}
                        title={sigue ? "Dejar de seguir" : "Seguir esta tienda"}
                        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 active:scale-90 transition ${
                          sigue ? "bg-[#f4eefe] text-[#6105dc]" : "bg-white ring-1 ring-[#efe6fc] text-[#a29cbd]"
                        }`}
                      >
                        <i className={`${sigue ? "fa-solid" : "fa-regular"} fa-heart text-sm`}></i>
                      </button>
                      <a
                        href={`/${t.slug}`}
                        aria-label={`Ver catálogo de ${t.nombre}`}
                        className="w-9 h-9 rounded-full bg-[#6105dc] text-white flex items-center justify-center shrink-0 active:scale-90 transition"
                      >
                        <i className="fa-solid fa-arrow-right text-xs"></i>
                      </a>
                     </div>
                     <ModalidadesEntrega t={t} />
                    </div>
                  );
                })}
              </>
            );
          })()}

          <div className="rounded-[26px] border-[1.5px] border-dashed border-[#d9cdf3] bg-white/60 p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#ece0fd] text-[#4d04b0] flex items-center justify-center shrink-0">
              <i className="fa-solid fa-plus"></i>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-[#1c1830] leading-tight">¿Compraste en otra bodega?</p>
              <p className="text-xs text-[#78729a] mt-0.5">Escanea su QR o pega el link</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {soportaEscaneo && (
                <button
                  type="button"
                  onClick={iniciarEscaneo}
                  aria-label="Escanear QR"
                  className="h-9 w-9 rounded-full bg-white ring-1 ring-[#e6dcf7] text-[#4d04b0] flex items-center justify-center"
                >
                  <i className="fa-solid fa-qrcode text-xs"></i>
                </button>
              )}
              <button
                type="button"
                onClick={() => { setLinkPegado(""); setModalPegarLink(true); }}
                className="h-9 px-3.5 rounded-full bg-white ring-1 ring-[#e6dcf7] text-[#4d04b0] text-xs font-semibold flex items-center gap-1.5"
              >
                <i className="fa-solid fa-link text-[11px]"></i> Pegar
              </button>
            </div>
          </div>
          {errorCamara && <p className="text-[11px] text-rose-600 px-1">{errorCamara}</p>}
        </div>
      )}

      {escaneando && (
        <div className="fixed inset-0 bg-black z-50 flex flex-col items-center justify-center">
          <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover"></video>
          <div className="absolute inset-0 bg-black/30"></div>
          <div className="relative z-10 w-56 h-56 border-4 border-white/70 rounded-2xl"></div>
          <p className="relative z-10 text-white text-sm font-semibold mt-4 bg-black/50 px-3 py-1.5 rounded-full">Apuntá al código QR</p>
          <button
            onClick={detenerEscaneo}
            className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-white/20 backdrop-blur text-white flex items-center justify-center"
          >
            <i className="fa-solid fa-xmark text-lg"></i>
          </button>
        </div>
      )}

      {modalPegarLink && (
        <HojaInferior titulo="Pegar link de la bodega" onCerrar={() => setModalPegarLink(false)}>
          <div className="px-[18px] pb-6 pt-1 flex flex-col gap-3">
            <input
              type="text"
              value={linkPegado}
              onChange={(e) => setLinkPegado(e.target.value)}
              placeholder="https://delivery.smartdeskapps.com/bodega-demo"
              className="w-full h-12 rounded-2xl bg-[#f7f4fc] ring-1 ring-[#efe6fc] px-4 text-sm text-[#1c1830] placeholder-[#a29cbd] focus:outline-none focus:ring-2 focus:ring-[#6105dc]/40"
              autoFocus
            />
            <button
              onClick={() => irAlSlugDesdeTexto(linkPegado)}
              disabled={!linkPegado.trim()}
              className="w-full h-12 rounded-full bg-[#6105dc] hover:bg-[#4d04b0] text-white font-bold text-sm disabled:opacity-50 active:scale-[0.98] transition"
            >
              Ir a la tienda
            </button>
          </div>
        </HojaInferior>
      )}
    </div>
  );
}

// "Mi perfil": datos de la cuenta que la clienta puede editar (nombre y teléfono
// de contacto), la dirección que se guarda en este dispositivo para no
// escribirla en cada pedido, y las notificaciones. El correo es el de Google
// con el que entra, así que no se edita. La forma de pago no se guarda acá:
// se elige al hacer cada pedido.
function PantallaPerfil({ cliente, onActualizado, onVolver, direccion, onEditarDireccion, onInstalar, onSalir }) {
  const [confirmarEliminar, setConfirmarEliminar] = useState(false);
  const [textoConfirmar, setTextoConfirmar] = useState("");
  const [eliminando, setEliminando] = useState(false);
  const [errorEliminar, setErrorEliminar] = useState("");

  // Borra la cuenta y sus datos (migration_37_eliminar_mi_cuenta.sql) y vuelve
  // al inicio con todo limpio.
  const eliminarCuenta = async () => {
    setEliminando(true);
    setErrorEliminar("");
    const { error } = await sbClient.rpc("eliminar_mi_cuenta");
    if (error) {
      setEliminando(false);
      setErrorEliminar(
        error.code === "PGRST202" || /could not find the function/i.test(error.message || "")
          ? "Esta opción todavía no está disponible. Inténtalo de nuevo más tarde."
          : error.message || "No se pudo eliminar la cuenta."
      );
      return;
    }
    try { await sbClient.auth.signOut({ scope: "local" }); } catch (e) { /* la sesión ya no existe */ }
    try {
      Object.keys(localStorage).filter((k) => k.startsWith("kd_")).forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* sin almacenamiento */ }
    window.location.href = window.location.origin + "/";
  };

  const [editando, setEditando] = useState(null); // "nombre" | "telefono" | null
  const [valor, setValor] = useState("");
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [correo, setCorreo] = useState("");
  const [pushActivo, setPushActivo] = useState(false);
  const [novedades, setNovedades] = useState(true);
  const [avisoNotif, setAvisoNotif] = useState("");

  useEffect(() => {
    sbClient.auth.getUser().then(({ data }) => setCorreo(data?.user?.email || ""));
    (async () => {
      try {
        if ("serviceWorker" in navigator && "PushManager" in window && Notification.permission === "granted") {
          const reg = await navigator.serviceWorker.getRegistration();
          const sub = await reg?.pushManager.getSubscription();
          setPushActivo(!!sub && localStorage.getItem("kd_push_apagado") !== "1");
        }
      } catch {
        // sin soporte de notificaciones: el interruptor queda apagado
      }
    })();
    sbClient
      .from("bodegas_visitadas")
      .select("avisos")
      .then(({ data }) => {
        if (data && data.length > 0) setNovedades(data.every((v) => v.avisos !== false));
      });
  }, []);

  const empezarEdicion = (campo) => {
    setEditando(campo);
    setValor(campo === "nombre" ? cliente.nombre || "" : cliente.telefono || "");
    setError("");
  };

  const guardar = async () => {
    const limpio = valor.trim();
    let cambios;
    if (editando === "nombre") {
      if (limpio.length < 2) return setError("Escribe tu nombre.");
      cambios = { nombre: limpio };
    } else {
      const digitos = limpio.replace(/\D/g, "");
      if (digitos.length < 7 || digitos.length > 15) return setError("Ingresa un teléfono válido.");
      cambios = { telefono: digitos };
    }
    setGuardando(true);
    const { error: err } = await sbClient.from("clientes_delivery").update(cambios).eq("id", cliente.id);
    setGuardando(false);
    if (err) {
      setError(err.code === "23505" ? "Ese teléfono ya está registrado en otra cuenta." : "No se pudo guardar. Intenta de nuevo.");
      return;
    }
    onActualizado({ ...cliente, ...cambios });
    setEditando(null);
    setError("");
  };

  const alternarPush = async () => {
    setAvisoNotif("");
    if (pushActivo) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        await sub?.unsubscribe();
        await sbClient.from("clientes_delivery").update({ push_subscription: null }).eq("id", cliente.id);
        localStorage.setItem("kd_push_apagado", "1");
        setPushActivo(false);
      } catch {
        setAvisoNotif("No se pudieron apagar las notificaciones.");
      }
    } else {
      try {
        localStorage.removeItem("kd_push_apagado");
        await activarNotificaciones(cliente.id);
        setPushActivo(true);
      } catch (err) {
        setAvisoNotif(err.message || "No se pudieron activar las notificaciones.");
      }
    }
  };

  const alternarNovedades = async () => {
    const nuevo = !novedades;
    setNovedades(nuevo);
    // La política de la tabla solo deja tocar filas propias; el filtro es solo porque
    // Supabase no acepta un UPDATE sin condición.
    const { error: err } = await sbClient.from("bodegas_visitadas").update({ avisos: nuevo }).neq("bodega_id", "00000000-0000-0000-0000-000000000000");
    if (err) setNovedades(!nuevo);
  };

  const desde = cliente.creado_en
    ? new Date(cliente.creado_en).toLocaleDateString("es-PE", { month: "long", year: "numeric" })
    : "";

  const filaEditable = (campo, icono, etiqueta, texto) => (
    <div className="px-3.5 py-3 border-t border-[#efe6fc] first:border-t-0">
      {editando === campo ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold text-[#78729a]">{etiqueta}</p>
          <input
            type={campo === "telefono" ? "tel" : "text"}
            inputMode={campo === "telefono" ? "tel" : undefined}
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            maxLength={campo === "telefono" ? 20 : 60}
            autoFocus
            className="w-full bg-white border border-[#e6dcf7] rounded-full px-4 py-2.5 text-sm text-stone-800 focus:outline-none focus:border-[#6105dc]/45 focus:ring-4 focus:ring-[#6105dc]/[0.07]"
          />
          {error && <p className="text-xs text-rose-600">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={guardar}
              disabled={guardando}
              className="flex-1 h-10 rounded-full bg-[#6105dc] text-white text-sm font-bold disabled:opacity-50"
            >
              {guardando ? "Guardando..." : "Guardar"}
            </button>
            <button onClick={() => { setEditando(null); setError(""); }} className="flex-1 h-10 rounded-full bg-white ring-1 ring-[#e6dcf7] text-[#4d04b0] text-sm font-semibold">
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
            <i className={`fa-solid ${icono} text-sm`}></i>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#78729a]">{etiqueta}</p>
            <p className="text-sm font-bold text-[#1c1830] truncate">{texto}</p>
          </div>
          <button onClick={() => empezarEdicion(campo)} aria-label={`Editar ${etiqueta.toLowerCase()}`} className="text-[#6105dc] w-8 h-8 flex items-center justify-center">
            <i className="fa-solid fa-pen text-xs"></i>
          </button>
        </div>
      )}
    </div>
  );

  const interruptor = (activo, onClick, etiqueta) => (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={etiqueta}
      onClick={onClick}
      className={`relative w-11 h-[26px] rounded-full shrink-0 transition-colors ${activo ? "bg-[#6105dc]" : "bg-[#d9d5e2]"}`}
    >
      <span className={`absolute top-[3px] w-5 h-5 rounded-full bg-white transition-all ${activo ? "left-[21px]" : "left-[3px]"}`}></span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-20 overflow-y-auto bg-gradient-to-br from-[#f4effc] via-[#f9f8fb] to-[#f5f4f8]">
      <div className="kd-entra relative max-w-md mx-auto px-4 pt-5 pb-28 flex flex-col gap-3 min-h-full" style={{ "--d": direccionEntrada }}>
        <div className="flex items-center gap-3">
          <button onClick={onVolver} aria-label="Volver" className="w-10 h-10 rounded-full bg-white ring-1 ring-[#efe6fc] text-[#4d04b0] flex items-center justify-center">
            <i className="fa-solid fa-arrow-left text-sm"></i>
          </button>
          <h1 className="text-[22px] font-extrabold tracking-tight text-[#1c1830]">Mi perfil</h1>
        </div>

        <div className="flex items-center gap-3.5 px-0.5 py-1">
          <span className="w-14 h-14 rounded-full bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] text-white text-2xl font-extrabold flex items-center justify-center shrink-0">
            {(cliente.nombre || "?").charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="text-[17px] font-bold text-[#1c1830] truncate">{cliente.nombre}</p>
            {desde && <p className="text-[12.5px] text-[#78729a]">Cliente desde {desde}</p>}
          </div>
        </div>

        <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] overflow-hidden">
          <p className="text-[11px] font-bold tracking-[0.08em] uppercase text-[#78729a] px-3.5 pt-3 pb-1">Datos personales</p>
          {filaEditable("nombre", "fa-user", "Nombre", cliente.nombre)}
          {filaEditable("telefono", "fa-mobile-screen", "Teléfono de contacto", cliente.telefono)}
          <div className="px-3.5 py-3 border-t border-[#efe6fc] flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
              <i className="fa-regular fa-envelope text-sm"></i>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-[#78729a]">Correo (Google)</p>
              <p className="text-sm font-bold text-[#1c1830] truncate">{correo || "—"}</p>
            </div>
            <span className="text-[11px] text-[#a29cbd] flex items-center gap-1 shrink-0">
              <i className="fa-solid fa-lock text-[10px]"></i> Fijo
            </span>
          </div>
        </div>

        <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] overflow-hidden">
          <p className="text-[11px] font-bold tracking-[0.08em] uppercase text-[#78729a] px-3.5 pt-3 pb-1">Entrega</p>
          <div className="px-3.5 py-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
              <i className="fa-solid fa-location-dot text-sm"></i>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-[#78729a]">Dirección guardada en este dispositivo</p>
              <p className="text-sm font-bold text-[#1c1830] line-clamp-2">
                {direccion.referencia || (direccion.tiene ? "Ubicación marcada en el mapa" : "Todavía no guardaste una dirección")}
              </p>
            </div>
            <button onClick={onEditarDireccion} className="text-[12.5px] font-bold text-[#6105dc] shrink-0">
              {direccion.tiene ? "Cambiar" : "Agregar"}
            </button>
          </div>
        </div>

        <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] overflow-hidden">
          <p className="text-[11px] font-bold tracking-[0.08em] uppercase text-[#78729a] px-3.5 pt-3 pb-1">Notificaciones</p>
          <div className="px-3.5 py-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
              <i className="fa-solid fa-bell text-sm"></i>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-[#1c1830]">Estado de mis pedidos</p>
              <p className="text-xs text-[#78729a]">Aviso cuando esté listo o en camino</p>
            </div>
            {interruptor(pushActivo, alternarPush, "Notificaciones de mis pedidos")}
          </div>
          <div className="px-3.5 py-3 border-t border-[#efe6fc] flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
              <i className="fa-solid fa-heart text-sm"></i>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-[#1c1830]">Novedades de mis tiendas</p>
              <p className="text-xs text-[#78729a]">Cuando abren o suman delivery</p>
            </div>
            {interruptor(novedades, alternarNovedades, "Novedades de mis tiendas")}
          </div>
          {avisoNotif && <p className="text-xs text-rose-600 px-3.5 pb-3">{avisoNotif}</p>}
        </div>

        {onInstalar && (
          <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] overflow-hidden">
            <p className="text-[11px] font-bold tracking-[0.08em] uppercase text-[#78729a] px-3.5 pt-3 pb-1">Cuenta</p>
            <button onClick={onInstalar} className="w-full px-3.5 py-3 flex items-center gap-3 text-left">
              <span className="w-9 h-9 rounded-xl bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
                <i className="fa-solid fa-download text-sm"></i>
              </span>
              <p className="text-sm font-bold text-[#1c1830] flex-1">Instalar la app</p>
              <i className="fa-solid fa-chevron-right text-xs text-[#a29cbd]"></i>
            </button>
          </div>
        )}

        <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] overflow-hidden">
          <p className="text-[11px] font-bold tracking-[0.08em] uppercase text-[#78729a] px-3.5 pt-3 pb-1">Legal</p>
          {[
            ["fa-shield-halved", "Política de privacidad", "https://kaserita.smartdeskapps.com/privacidad.html"],
            ["fa-file-lines", "Términos y condiciones", "https://kaserita.smartdeskapps.com/terminos-delivery.html"],
          ].map(([icono, texto, url], i) => (
            <a
              key={texto}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={`px-3.5 py-3 flex items-center gap-3 ${i > 0 ? "border-t border-[#efe6fc]" : ""}`}
            >
              <span className="w-9 h-9 rounded-xl bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
                <i className={`fa-solid ${icono} text-sm`}></i>
              </span>
              <p className="text-sm font-bold text-[#1c1830] flex-1">{texto}</p>
              <i className="fa-solid fa-arrow-up-right-from-square text-[11px] text-[#a29cbd]"></i>
            </a>
          ))}
        </div>

        <div className="flex-1"></div>
        <button
          onClick={onSalir}
          className="h-12 rounded-full bg-white ring-1 ring-rose-200 text-rose-600 font-bold text-sm flex items-center justify-center gap-2"
        >
          <i className="fa-solid fa-right-from-bracket text-xs"></i> Cerrar sesión
        </button>
        <button
          onClick={() => { setTextoConfirmar(""); setErrorEliminar(""); setConfirmarEliminar(true); }}
          className="text-[12.5px] font-semibold text-[#78729a] underline py-1"
        >
          Eliminar mi cuenta
        </button>
      </div>

      {confirmarEliminar && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-6 bg-[#1c1830]/45 backdrop-blur-[3px]"
          onClick={() => !eliminando && setConfirmarEliminar(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="kd-pop w-full max-w-sm bg-white rounded-[28px] px-[18px] pt-[22px] pb-[18px] flex flex-col items-center text-center gap-2 shadow-[0_24px_50px_-18px_rgba(28,24,48,0.5)]"
          >
            <span className="w-[52px] h-[52px] rounded-full bg-[#fff1f3] text-[#e11d48] flex items-center justify-center">
              <i className="fa-solid fa-user-xmark text-xl"></i>
            </span>
            <h3 className="text-[18px] font-extrabold text-[#1c1830]">¿Eliminar tu cuenta?</h3>
            <p className="text-[12.5px] text-[#78729a] leading-snug">
              Se borrarán tu nombre, teléfono, correo, tus tiendas guardadas y el historial de tus pedidos. Esta acción no se puede deshacer.
            </p>
            <label className="w-full text-left text-[11.5px] font-semibold text-[#78729a] mt-1.5">
              Para confirmar, escribe <span className="font-extrabold text-[#e11d48]">ELIMINAR</span>
              <input
                type="text"
                value={textoConfirmar}
                onChange={(e) => setTextoConfirmar(e.target.value)}
                autoCapitalize="characters"
                autoComplete="off"
                className="mt-1.5 w-full h-11 rounded-2xl bg-[#f7f4fc] ring-1 ring-[#efe6fc] px-4 text-sm font-bold tracking-wider text-[#1c1830] focus:outline-none focus:ring-2 focus:ring-[#e11d48]/40"
              />
            </label>
            {errorEliminar && <p className="text-xs text-rose-600 text-left w-full">{errorEliminar}</p>}
            <div className="w-full flex gap-2 mt-1">
              <button
                onClick={() => setConfirmarEliminar(false)}
                disabled={eliminando}
                className="flex-1 h-[46px] rounded-full bg-[#f4eefe] text-[#4d04b0] text-sm font-bold disabled:opacity-50 active:scale-[0.98] transition-transform"
              >
                Mejor no
              </button>
              <button
                onClick={eliminarCuenta}
                disabled={eliminando || textoConfirmar.trim().toUpperCase() !== "ELIMINAR"}
                className="flex-1 h-[46px] rounded-full bg-[#e11d48] text-white text-sm font-bold disabled:opacity-40 active:scale-[0.98] transition-transform"
              >
                {eliminando ? "Eliminando..." : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Barra inferior con efecto vidrio. Se muestra en las pantallas principales
// (vitrina, Mis tiendas, Mis pedidos y Perfil) para poder moverse entre ellas
// sin tener que volver atrás.
// Recuerda la pestaña anterior para animar: la cápsula de la barra viaja desde
// donde estaba (aunque la barra se vuelva a montar al cambiar de pantalla) y la
// pantalla nueva entra por el lado hacia donde nos movemos.
const ORDEN_PESTANAS = ["inicio", "pedidos", "tiendas", "perfil"];
let pestanaPrevia = 0;
let pestanaActual = 0;
let direccionEntrada = 0;
function marcarPestana(id) {
  const i = ORDEN_PESTANAS.indexOf(id);
  direccionEntrada = i >= pestanaActual ? 1 : -1;
  pestanaActual = i;
}

function BarraNavegacion({ activa, contadorPedidos, onInicio, onTiendas, onPedidos, onPerfil, carrito, acciones }) {
  const tabs = [
    { id: "inicio", icono: "fa-house", texto: "Inicio", onClick: onInicio },
    { id: "pedidos", icono: "fa-receipt", texto: "Pedidos", contador: contadorPedidos, onClick: onPedidos },
    { id: "tiendas", icono: "fa-store", texto: "Mis tiendas", onClick: onTiendas },
    { id: "perfil", icono: "fa-user", texto: "Perfil", onClick: onPerfil },
  ];
  const indice = Math.max(0, ORDEN_PESTANAS.indexOf(activa));
  const [pos, setPos] = useState(pestanaPrevia);
  useEffect(() => {
    // Dos cuadros: primero se pinta la cápsula en su lugar anterior y luego se
    // mueve al nuevo, para que el navegador anime el recorrido.
    let r2;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setPos(indice));
    });
    pestanaPrevia = indice;
    pestanaActual = indice;
    return () => {
      cancelAnimationFrame(r1);
      if (r2) cancelAnimationFrame(r2);
    };
  }, [indice]);

  // Dock que se transforma: con productos en el pedido, las pestañas se encogen
  // a un botón redondo (la pestaña actual) y el espacio lo ocupa el chip del
  // carrito. Tocar el botón redondo despliega las pestañas otra vez.
  const [desplegada, setDesplegada] = useState(false);
  const [abanico, setAbanico] = useState(false);
  const cantidad = carrito ? carrito.cantidad : 0;
  const modoCarrito = cantidad > 0 && !desplegada;
  const cantidadPrevia = useRef(0);
  useEffect(() => {
    // Al agregar algo, el dock vuelve a mostrar el chip del carrito.
    if (cantidad > cantidadPrevia.current) { setDesplegada(false); setAbanico(false); }
    cantidadPrevia.current = cantidad;
  }, [cantidad]);
  useEffect(() => {
    // Las pestañas desplegadas con carrito se pliegan solas a los 4 segundos.
    if (!desplegada || abanico) return;
    const id = setTimeout(() => setDesplegada(false), 4000);
    return () => clearTimeout(id);
  }, [desplegada, abanico]);

  const hayAbanico = !!(acciones && acciones.length > 0);
  const tocar = (t) => {
    if (modoCarrito) { setDesplegada(true); return; }
    if (t.id === "perfil" && hayAbanico) { setAbanico((v) => !v); return; }
    setAbanico(false);
    t.onClick();
  };

  return (
    <>
      <div className={`kdock-velo ${abanico ? "on" : ""}`} onClick={() => setAbanico(false)}></div>
      <nav className="kdock-nav" aria-label="Navegación">
        <svg width="0" height="0" className="absolute" aria-hidden="true">
          <filter id="kdock-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b" />
            <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" />
          </filter>
        </svg>
        <div className={`kdock ${modoCarrito ? "kdock-carrito" : ""}`}>
          {hayAbanico && (
            <>
              {/* Las burbujas de color van en una capa con filtro "líquido": salen del botón como gotas. */}
              <div className={`kdock-goo ${abanico ? "on" : ""}`} aria-hidden="true">
                <span className="kdock-gs"></span>
                {acciones.map((a, k) => (
                  <span key={a.texto} className="kdock-gb" style={{ background: a.color, bottom: 72 + 52 * k, "--k": k, "--dy": `${62 + 52 * k}px` }}></span>
                ))}
              </div>
              <div className={`kdock-fan ${abanico ? "on" : ""}`}>
                {acciones.map((a, k) => (
                  <button
                    key={a.texto}
                    className="kdock-fi"
                    style={{ "--k": k, "--dy": `${62 + 52 * k}px`, order: -k }}
                    tabIndex={abanico ? 0 : -1}
                    onClick={() => { setAbanico(false); a.onClick(); }}
                  >
                    <span>{a.texto}</span>
                    <i><b className={`fa-solid ${a.icono}`}></b></i>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="kdock-tabs">
            <div
              aria-hidden="true"
              className="kdock-capsula"
              style={{ transform: `translateX(${pos * 100}%)` }}
            ></div>
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => tocar(t)}
                className={`kdock-tab ${t.id === activa ? "on" : ""}`}
              >
                <i className={`fa-solid ${t.icono}`}></i>
                <span>{t.texto}</span>
                {t.contador > 0 && <em>{t.contador}</em>}
              </button>
            ))}
          </div>
          {carrito && (
            <div className="kdock-chipwrap">
              {cantidad > 0 && (
                <span className="kdock-cnt">{cantidad} {cantidad === 1 ? "producto" : "productos"}</span>
              )}
              <div className="kdock-chip" key={cantidad}>
                <div className="flex shrink-0 pl-0.5">
                  {carrito.miniaturas.slice(-3).map((m, i) => (
                    <span key={m.id} className={`kc-mini ${i > 0 ? "-ml-3" : ""}`} style={{ background: tonoCategoria(m.categoria).t }}>
                      {m.foto ? (
                        <img src={m.foto} alt="" />
                      ) : (
                        <i className={`fa-solid ${m.categoria === "combo" ? "fa-gift" : "fa-bag-shopping"} text-[11px] text-[#6105dc]/60`}></i>
                      )}
                    </span>
                  ))}
                  {carrito.miniaturas.length > 3 && (
                    <span className="kc-mini -ml-3 !bg-[#ffc81a] text-[#1c1830] text-[11px] font-extrabold">+{carrito.miniaturas.length - 3}</span>
                  )}
                </div>
                <div className="kdock-tx">
                  <small>MI PEDIDO</small>
                  <b>{formatoMoneda(carrito.total)}</b>
                </div>
                <button className="kdock-ver" onClick={carrito.onVer} tabIndex={modoCarrito ? 0 : -1}>
                  Ver pedido <i className="fa-solid fa-arrow-right text-[10px]"></i>
                </button>
              </div>
            </div>
          )}
        </div>
      </nav>
    </>
  );
}

function App() {
  const [slug] = useState(getSlugFromPath());
  const [estadoBodega, setEstadoBodega] = useState("cargando"); // cargando | ok | no-encontrada | sin-slug
  const [bodega, setBodega] = useState(null);
  const [productos, setProductos] = useState([]);
  const [cargandoProductos, setCargandoProductos] = useState(false);
  const [carrito, setCarrito] = useState({}); // { [producto_id]: cantidad }
  // Combos: paquetes de varios productos a precio especial (ver
  // migration_25_combos.sql) -- carrito propio, separado del de productos,
  // porque un combo no es un producto de la tabla "productos".
  const [combos, setCombos] = useState([]);
  const [carritoCombos, setCarritoCombos] = useState({}); // { [combo_id]: cantidad }
  // true recién después de intentar restaurar el carrito guardado -- evita
  // que el efecto de guardado (abajo) pise el localStorage con el carrito
  // vacío inicial antes de que la restauración llegue a aplicarse.
  const [carritoListo, setCarritoListo] = useState(false);
  const [carritoAbierto, setCarritoAbierto] = useState(false);
  const [confirmarVaciarAbierto, setConfirmarVaciarAbierto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [pedidoConfirmado, setPedidoConfirmado] = useState(null); // { codigo, whatsappUrl, domicilio, reserva }
  // Barbería: { barberos: [{id, nombre}] } si la tienda es de una barbería (obtener_barberia_delivery).
  const [barberia, setBarberia] = useState(null);
  const [reservaBarbero, setReservaBarbero] = useState(""); // nombre del barbero elegido; "" = cualquiera
  const [reservaFecha, setReservaFecha] = useState("");
  const [reservaHora, setReservaHora] = useState("");
  // Barbería con agenda: horas libres del día elegido, según lo que hay en el carrito.
  const [horasLibres, setHorasLibres] = useState({ cargando: false, horas: [], duracion: 0 });
  const [refrescoHoras, setRefrescoHoras] = useState(0);
  // Entrega: "retiro" (en tienda) o "domicilio" (el local reparte).
  const [tipoEntrega, setTipoEntrega] = useState("retiro");
  const [ubicacionEntrega, setUbicacionEntrega] = useState(null); // { lat, lng }
  const [referenciaEntrega, setReferenciaEntrega] = useState("");
  const [telefonoEntrega, setTelefonoEntrega] = useState("");
  const [medioPagoEntrega, setMedioPagoEntrega] = useState("efectivo");
  const [pagaConEntrega, setPagaConEntrega] = useState("");
  const [obteniendoGps, setObteniendoGps] = useState(false);
  const [errorGps, setErrorGps] = useState("");
  const [ubicacionAbierta, setUbicacionAbierta] = useState(false); // pantalla "Confirmar ubicación"
  const [pagoAbierto, setPagoAbierto] = useState(false); // opciones de pago desplegadas
  const [entregaListo, setEntregaListo] = useState(false);
  // "Seguir tienda": corazón de la vitrina + si quiere recibir avisos de esta tienda.
  const [tiendaSeguida, setTiendaSeguida] = useState(false);
  const [avisosTienda, setAvisosTienda] = useState(true);
  const [avisoSeguir, setAvisoSeguir] = useState("");
  // Pedidos en curso del cliente (para la tarjeta de seguimiento y el contador de "Pedidos").
  const [pedidosActivos, setPedidosActivos] = useState([]);
  const [perfilAbierto, setPerfilAbierto] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [categoriaActiva, setCategoriaActiva] = useState("");
  const [fotoAmpliada, setFotoAmpliada] = useState(null); // producto
  const [productoDetalleId, setProductoDetalleId] = useState(null); // id del producto en la hoja de detalle
  const [modalTodosCombos, setModalTodosCombos] = useState(false);
  const [modalTodosDestacados, setModalTodosDestacados] = useState(false);
  // Puntitos de página de los carruseles de combos/destacados -- se
  // calculan a partir del scroll real (no hay librería de carrusel acá),
  // redondeando a qué tarjeta completa quedó más visible.
  const comboScrollRef = useRef(null);
  const [comboActivo, setComboActivo] = useState(0);
  const destacadoScrollRef = useRef(null);
  const [destacadoActivo, setDestacadoActivo] = useState(0);
  const manejarScrollCombos = () => {
    const el = comboScrollRef.current;
    const anchoTarjeta = el?.firstElementChild?.offsetWidth;
    if (!el || !anchoTarjeta) return;
    setComboActivo(Math.round(el.scrollLeft / anchoTarjeta));
  };
  const manejarScrollDestacados = () => {
    const el = destacadoScrollRef.current;
    const anchoTarjeta = el?.firstElementChild?.offsetWidth;
    if (!el || !anchoTarjeta) return;
    setDestacadoActivo(Math.round(el.scrollLeft / anchoTarjeta));
  };
  const [clienteSesion, setClienteSesion] = useState(null); // fila de clientes_delivery, o null
  const [modalCuentaAbierto, setModalCuentaAbierto] = useState(false);
  // Sesión de Google ya validada por Supabase Auth, pero todavía sin fila en
  // clientes_delivery (primera vez que entra así) -- falta pedirle el celular.
  const [completarPerfilGoogle, setCompletarPerfilGoogle] = useState(null);
  const [vistaMisPedidos, setVistaMisPedidos] = useState(false);
  const [vistaMisTiendas, setVistaMisTiendas] = useState(false);
  const [eventoInstalacion, setEventoInstalacion] = useState(null);
  const [instruccionesIOSAbiertas, setInstruccionesIOSAbiertas] = useState(false);
  const [ultimaBodega, setUltimaBodega] = useState(null); // { slug, nombre, logo_url }, para la home general
  // Favoritos: solo local al celular (localStorage por bodega), no hace
  // falta cuenta ni tabla nueva -- es para encontrar rápido lo de
  // siempre, no una lista que necesite verse desde otro dispositivo.
  const [favoritos, setFavoritos] = useState(() => new Set());
  const [soloFavoritos, setSoloFavoritos] = useState(false);

  // Safari en iPhone/iPad no tiene beforeinstallprompt -- ahí instalar
  // SIEMPRE es manual (botón Compartir -> Agregar a inicio), no hay forma
  // de disparar el instalador desde el código. esIOS detecta esto para
  // mostrar instrucciones en vez de un botón que nunca aparecería.
  const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const yaInstalada = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;

  useEffect(() => {
    // Chrome en Android muestra su propio aviso para instalar, pero se
    // minimiza solo a los pocos segundos si no se toca -- después de eso
    // no vuelve a aparecer solo. Guardamos el evento para poder disparar
    // la instalación nosotros mismos con un botón fijo en el header.
    const alDisponible = (e) => {
      e.preventDefault();
      setEventoInstalacion(e);
    };
    const alInstalar = () => setEventoInstalacion(null);
    window.addEventListener("beforeinstallprompt", alDisponible);
    window.addEventListener("appinstalled", alInstalar);
    return () => {
      window.removeEventListener("beforeinstallprompt", alDisponible);
      window.removeEventListener("appinstalled", alInstalar);
    };
  }, []);

  const instalarApp = async () => {
    if (!eventoInstalacion) return;
    eventoInstalacion.prompt();
    await eventoInstalacion.userChoice;
    setEventoInstalacion(null);
  };

  useEffect(() => {
    // Si el navegador ya tenía sesión guardada (de una visita anterior, o de
    // volver recién de Google), la restaura sin pedir celular/PIN de nuevo.
    sbClient.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return;
      const { data } = await sbClient.from("clientes_delivery").select("*").maybeSingle();
      if (data) {
        setClienteSesion(data);
      } else {
        // Entró con Google por primera vez -- ya está autenticado, pero
        // todavía no existe su fila en clientes_delivery (falta el celular).
        setCompletarPerfilGoogle({
          nombre: session.user.user_metadata?.full_name || session.user.user_metadata?.name || "",
        });
      }
    });
  }, []);

  useEffect(() => {
    if (!clienteSesion) return;
    if (localStorage.getItem("kd_push_apagado") === "1") return;
    activarNotificaciones(clienteSesion.id, true).catch(() => {});
  }, [clienteSesion?.id]);

  // Datos de entrega: se guardan por bodega igual que el carrito, para que
  // no se pierdan si el cliente tiene que ir y volver de Google para entrar.
  useEffect(() => {
    if (!slug) return;
    try {
      let g = JSON.parse(localStorage.getItem(`kd_entrega_${slug}`) || "null");
      // Sin datos de esta tienda, se usa la dirección guardada de la última vez (de cualquier tienda).
      if (!g) g = JSON.parse(localStorage.getItem("kd_direccion_guardada") || "null");
      if (g) {
        if (g.tipo === "domicilio") setTipoEntrega("domicilio");
        if (g.ubicacion && typeof g.ubicacion.lat === "number" && typeof g.ubicacion.lng === "number") setUbicacionEntrega(g.ubicacion);
        if (typeof g.referencia === "string") setReferenciaEntrega(g.referencia);
        if (typeof g.telefono === "string") setTelefonoEntrega(g.telefono);
        if (g.medioPago) setMedioPagoEntrega(g.medioPago);
      }
    } catch {
      // sin datos guardados: se empieza de cero
    }
    setEntregaListo(true);
  }, [slug]);

  useEffect(() => {
    if (!slug || !entregaListo) return;
    try {
      localStorage.setItem(
        `kd_entrega_${slug}`,
        JSON.stringify({ tipo: tipoEntrega, ubicacion: ubicacionEntrega, referencia: referenciaEntrega, telefono: telefonoEntrega, medioPago: medioPagoEntrega })
      );
      if (ubicacionEntrega || referenciaEntrega.trim()) {
        localStorage.setItem("kd_direccion_guardada", JSON.stringify({ ubicacion: ubicacionEntrega, referencia: referenciaEntrega, telefono: telefonoEntrega }));
      }
    } catch {
      // ignorado -- en el peor caso hay que volver a escribirlos
    }
  }, [slug, entregaListo, tipoEntrega, ubicacionEntrega, referenciaEntrega, telefonoEntrega, medioPagoEntrega]);

  // El teléfono de contacto arranca con el de su cuenta si todavía no escribió otro.
  useEffect(() => {
    if (clienteSesion?.telefono) setTelefonoEntrega((t) => t || clienteSesion.telefono);
  }, [clienteSesion?.telefono]);

  useEffect(() => {
    // Aviso en vivo: mientras el cliente tenga sesión y la pestaña abierta
    // (en cualquier pantalla, no solo "Mis pedidos"), suena apenas la bodega
    // marca su pedido como "listo" -- filtrado por RLS al propio cliente_id,
    // igual que cualquier otra consulta.
    if (!clienteSesion) return;
    const canal = sbClient
      .channel(`cliente-seguimiento-${clienteSesion.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "pedidos_seguimiento", filter: `cliente_id=eq.${clienteSesion.id}` },
        (payload) => {
          if ((payload.new.estado === "listo" || payload.new.estado === "en_camino") && payload.old?.estado !== payload.new.estado) {
            sonarAvisoPedidoListo();
          }
        }
      )
      .subscribe();
    return () => { sbClient.removeChannel(canal); };
  }, [clienteSesion]);

  // El carrito vive solo en memoria (useState) por defecto, así que
  // cualquier recarga de página (sin querer, o el viaje de ida y vuelta a
  // Google para loguearse) lo borraría. Se guarda en localStorage por
  // bodega y se restaura al entrar, mismo patrón que favoritos.
  useEffect(() => {
    if (!slug) return;
    try {
      const carritoGuardado = localStorage.getItem(`kd_carrito_${slug}`);
      const combosGuardado = localStorage.getItem(`kd_carrito_combos_${slug}`);
      if (carritoGuardado) setCarrito(JSON.parse(carritoGuardado));
      if (combosGuardado) setCarritoCombos(JSON.parse(combosGuardado));
    } catch {
      // ignorado -- si el JSON quedó corrupto, simplemente se empieza con el carrito vacío
    } finally {
      setCarritoListo(true);
    }
  }, [slug]);

  useEffect(() => {
    if (!slug || !carritoListo) return;
    try {
      localStorage.setItem(`kd_carrito_${slug}`, JSON.stringify(carrito));
    } catch {
      // ignorado -- en el peor caso no sobrevive a un reinicio del navegador
    }
  }, [carrito, carritoListo, slug]);

  useEffect(() => {
    if (!slug || !carritoListo) return;
    try {
      localStorage.setItem(`kd_carrito_combos_${slug}`, JSON.stringify(carritoCombos));
    } catch {
      // ignorado -- en el peor caso no sobrevive a un reinicio del navegador
    }
  }, [carritoCombos, carritoListo, slug]);

  const iniciarConGoogle = async () => {
    // Nunca window.location.href a secas: después de volver de Google esa URL
    // queda con parámetros del propio login (token/código) pegados, y si se
    // reintenta el login mandando esa URL "sucia" como destino, Google la
    // rechaza. Con origin+pathname siempre se manda la URL limpia del catálogo.
    await sbClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
  };

  const salir = async () => {
    await sbClient.auth.signOut();
    setClienteSesion(null);
    setCompletarPerfilGoogle(null);
    setVistaMisPedidos(false);
  };

  useEffect(() => {
    // Limpieza oportunista: de paso en cada visita, borra pedidos sin usar
    // de más de 2 horas (de cualquier bodega, no solo esta). No hace falta
    // ningún cron aparte -- se apoya en el tráfico normal del sitio. Se
    // ignora el resultado a propósito: si falla, simplemente se borra en
    // otra visita.
    const dosHorasAtras = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sbClient.from("pedidos_delivery").delete().eq("usado", false).lt("creado_en", dosHorasAtras).then(() => {});
  }, []);

  // Productos, combos y barbería se piden al mismo tiempo que la bodega (antes
  // esperaban a que la bodega respondiera: dos viajes seguidos al servidor, que en
  // datos móviles se nota). Se usan una sola vez; si la bodega no existe o está
  // cerrada, el resultado simplemente se descarta.
  const precargaRef = useRef(null);
  if (slug && !precargaRef.current) {
    precargaRef.current = {
      productos: sbClient.rpc("obtener_productos_delivery", { p_slug: slug }).then((r) => r),
      combos: sbClient.rpc("obtener_combos_delivery", { p_slug: slug }).then((r) => r),
      barberia: sbClient.rpc("obtener_barberia_delivery", { p_slug: slug }).then((r) => r),
    };
  }
  const tomarPrecarga = (clave, pedir) => {
    const lista = precargaRef.current;
    const promesa = lista && lista[clave];
    if (lista) lista[clave] = null;
    return promesa || pedir();
  };

  useEffect(() => {
    if (!slug) {
      setEstadoBodega("sin-slug");
      return;
    }
    (async () => {
      const { data, error: err } = await sbClient
        .rpc("obtener_bodega_delivery", { p_slug: slug })
        .maybeSingle();
      if (err || !data) {
        setEstadoBodega("no-encontrada");
        return;
      }
      setBodega(data);
      // abierta = false: la bodega está desactivada o se le venció la
      // suscripción (migration_39). Se compara con false para que, si la
      // función todavía no devuelve ese campo, la tienda siga abierta.
      setEstadoBodega(data.abierta === false ? "cerrada" : "ok");
    })();
  }, [slug]);

  // Antes acá se armaba un manifest.json distinto por bodega (start_url =
  // esa bodega), así que cada bodega que el cliente visitaba terminaba
  // instalándose como un ícono/app separado en el celular. Ahora se deja el
  // manifest.json estático de siempre (una sola app "Kaserita", start_url
  // "/") y en su lugar se recuerda la última bodega vista para que la
  // pantalla de inicio (sin slug) pueda ofrecer volver a ella con un toque.
  useEffect(() => {
    if (estadoBodega !== "ok" || !bodega) return;
    try {
      localStorage.setItem(
        "kd_ultima_bodega",
        JSON.stringify({ slug, nombre: bodega.nombre, logo_url: bodega.logo_url || null })
      );
    } catch {
      // ignorado -- si localStorage no está disponible, simplemente no se ofrece el atajo
    }
  }, [estadoBodega, bodega, slug]);

  useEffect(() => {
    if (slug) return; // el atajo solo hace falta en la home general (sin bodega en la URL)
    try {
      const guardada = localStorage.getItem("kd_ultima_bodega");
      if (guardada) setUltimaBodega(JSON.parse(guardada));
    } catch {
      // ignorado -- si el JSON quedó corrupto, simplemente no se ofrece el atajo
    }
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    try {
      const guardados = localStorage.getItem(`kd_favoritos_${slug}`);
      setFavoritos(new Set(guardados ? JSON.parse(guardados) : []));
    } catch {
      setFavoritos(new Set());
    }
  }, [slug]);

  const toggleFavorito = useCallback((productoId) => {
    setFavoritos((prev) => {
      const nuevo = new Set(prev);
      if (nuevo.has(productoId)) nuevo.delete(productoId);
      else nuevo.add(productoId);
      try {
        localStorage.setItem(`kd_favoritos_${slug}`, JSON.stringify([...nuevo]));
      } catch {
        // ignorado -- en el peor caso el favorito no sobrevive a un reinicio del navegador
      }
      return nuevo;
    });
  }, [slug]);

  useEffect(() => {
    // Registra la visita para "Mis tiendas" -- se guarda aunque el cliente
    // no llegue a pedir nada, así no "desaparece" una bodega que solo miró.
    if (estadoBodega !== "ok" || !bodega || !clienteSesion) return;
    sbClient
      .from("bodegas_visitadas")
      .upsert(
        { cliente_id: clienteSesion.id, bodega_id: bodega.bodega_id, visto_en: new Date().toISOString() },
        { onConflict: "cliente_id,bodega_id" }
      )
      .then(() =>
        // Después de registrar la visita, se lee si la sigue y si tiene los avisos activados.
        sbClient
          .from("bodegas_visitadas")
          .select("favorita, avisos")
          .eq("cliente_id", clienteSesion.id)
          .eq("bodega_id", bodega.bodega_id)
          .maybeSingle()
      )
      .then(({ data }) => {
        if (data) {
          setTiendaSeguida(!!data.favorita);
          setAvisosTienda(data.avisos !== false);
        }
      });
  }, [estadoBodega, bodega, clienteSesion]);

  useEffect(() => {
    if (!clienteSesion) {
      setPedidosActivos([]);
      return;
    }
    let vivo = true;
    const cargar = () =>
      sbClient
        .from("pedidos_seguimiento")
        .select("id, bodega_id, codigo_corto, estado, tipo_entrega, creado_en")
        .in("estado", ["pendiente", "listo", "en_camino"])
        .order("creado_en", { ascending: false })
        .limit(20)
        .then(({ data }) => {
          if (vivo && data) setPedidosActivos(data);
        });
    cargar();
    const canal = sbClient
      .channel(`pedidos-activos-${clienteSesion.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pedidos_seguimiento", filter: `cliente_id=eq.${clienteSesion.id}` },
        cargar
      )
      .subscribe();
    const alVolver = () => {
      if (document.visibilityState === "visible") cargar();
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      vivo = false;
      sbClient.removeChannel(canal);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [clienteSesion?.id]);

  const mostrarAvisoSeguir = (texto) => {
    setAvisoSeguir(texto);
    setTimeout(() => setAvisoSeguir(""), 4500);
  };

  const guardarPreferenciaTienda = async (cambios) => {
    const { error: err } = await sbClient.from("bodegas_visitadas").upsert(
      { cliente_id: clienteSesion.id, bodega_id: bodega.bodega_id, visto_en: new Date().toISOString(), ...cambios },
      { onConflict: "cliente_id,bodega_id" }
    );
    return !err;
  };

  const alternarSeguirTienda = async () => {
    if (!clienteSesion) {
      iniciarConGoogle();
      return;
    }
    const nuevo = !tiendaSeguida;
    setTiendaSeguida(nuevo);
    const ok = await guardarPreferenciaTienda(nuevo ? { favorita: true, avisos: true } : { favorita: false });
    if (!ok) {
      setTiendaSeguida(!nuevo);
      mostrarAvisoSeguir("No se pudo guardar. Intenta de nuevo.");
      return;
    }
    if (!nuevo) {
      mostrarAvisoSeguir(`Dejaste de seguir a ${bodega.nombre}.`);
      return;
    }
    setAvisosTienda(true);
    try {
      await activarNotificaciones(clienteSesion.id);
      mostrarAvisoSeguir(`Ahora sigues a ${bodega.nombre}. Te avisaremos de sus novedades.`);
    } catch {
      mostrarAvisoSeguir(`Sigues a ${bodega.nombre}, pero activa las notificaciones del navegador para recibir sus avisos.`);
    }
  };

  const alternarAvisosTienda = async () => {
    const nuevo = !avisosTienda;
    setAvisosTienda(nuevo);
    const ok = await guardarPreferenciaTienda({ avisos: nuevo });
    if (!ok) {
      setAvisosTienda(!nuevo);
      mostrarAvisoSeguir("No se pudo guardar. Intenta de nuevo.");
      return;
    }
    mostrarAvisoSeguir(nuevo ? "Avisos activados para esta tienda." : "No recibirás avisos de esta tienda.");
  };

  useEffect(() => {
    if (estadoBodega !== "ok" || !bodega) return;
    setCargandoProductos(true);
    tomarPrecarga("productos", () => sbClient.rpc("obtener_productos_delivery", { p_slug: slug }).then((r) => r))
      .then(({ data, error: err }) => {
        if (!err) {
          const ordenados = (data || []).slice().sort((a, b) =>
            a.descripcion.localeCompare(b.descripcion)
          );
          setProductos(ordenados);
        }
        setCargandoProductos(false);
      });
    tomarPrecarga("combos", () => sbClient.rpc("obtener_combos_delivery", { p_slug: slug }).then((r) => r))
      .then(({ data, error: err }) => {
        if (!err) setCombos(data || []);
      });
  }, [estadoBodega, bodega]);

  // ¿Es una barbería? Si la función no existe o falla, la tienda se ve como siempre.
  useEffect(() => {
    if (estadoBodega !== "ok" || !bodega) return;
    tomarPrecarga("barberia", () => sbClient.rpc("obtener_barberia_delivery", { p_slug: slug }).then((r) => r))
      .then(({ data, error: err }) => {
        if (!err && data?.es_barberia) setBarberia({ barberos: data.barberos || [], agenda: data.agenda === true });
      });
  }, [estadoBodega, bodega]);

  const estadoHorario = useMemo(() => estadoAtencionBodega(bodega?.horario_atencion), [bodega]);

  const categorias = useMemo(() => {
    const set = new Set();
    productos.forEach((p) => {
      const sinStock = p.stock_disponible != null && p.stock_disponible <= 0;
      if (p.categoria && !sinStock) set.add(p.categoria);
    });
    return Array.from(set).sort();
  }, [productos]);

  const productosFiltrados = useMemo(() => {
    const b = busqueda.trim().toLowerCase();
    return productos.filter((p) => {
      if (p.stock_disponible != null && p.stock_disponible <= 0) return false;
      if (soloFavoritos && !favoritos.has(p.id)) return false;
      if (categoriaActiva && p.categoria !== categoriaActiva) return false;
      if (b && !p.descripcion.toLowerCase().includes(b)) return false;
      return true;
    });
  }, [productos, busqueda, categoriaActiva, soloFavoritos, favoritos]);

  // Carrusel de "destacados" (estilo hero de app de delivery) -- solo se
  // muestra en la vista home (sin búsqueda ni categoría activa). Usa todos
  // los productos que el dueño marcó a mano (es_destacado, desde "Editar
  // Producto" en el POS -- ahora se puede marcar más de uno); si no marcó
  // ninguno, cae al comportamiento anterior (el primero con foto) para no
  // dejar la home sin hero mientras el dueño no elige uno.
  const productosDestacados = useMemo(() => {
    if (busqueda.trim() || categoriaActiva || soloFavoritos) return [];
    const marcados = productosFiltrados.filter((p) => p.es_destacado && p.foto_url);
    if (marcados.length > 0) return marcados;
    const primero = productosFiltrados.find((p) => p.foto_url);
    return primero ? [primero] : [];
  }, [busqueda, categoriaActiva, soloFavoritos, productosFiltrados]);

  // Agotados: se muestran aparte (no en el grid principal) -- solo en la
  // vista home, con el mismo criterio de búsqueda que el resto (si el
  // cliente busca algo puntual, tiene sentido que también le salga si está
  // agotado).
  const productosAgotados = useMemo(() => {
    if (categoriaActiva || soloFavoritos) return [];
    const b = busqueda.trim().toLowerCase();
    return productos.filter((p) => {
      if (!(p.stock_disponible != null && p.stock_disponible <= 0)) return false;
      if (b && !p.descripcion.toLowerCase().includes(b)) return false;
      return true;
    });
  }, [productos, busqueda, categoriaActiva, soloFavoritos]);

  const productosPorId = useMemo(() => {
    const m = {};
    productos.forEach((p) => (m[p.id] = p));
    return m;
  }, [productos]);

  const combosPorId = useMemo(() => {
    const m = {};
    combos.forEach((c) => (m[c.id] = c));
    return m;
  }, [combos]);

  const itemsCarrito = useMemo(
    () =>
      Object.entries(carrito)
        .filter(([, cant]) => cant > 0)
        .map(([id, cantidad]) => ({ ...productosPorId[id], cantidad }))
        .filter((it) => it.id),
    [carrito, productosPorId]
  );

  const itemsCarritoCombos = useMemo(
    () =>
      Object.entries(carritoCombos)
        .filter(([, cant]) => cant > 0)
        .map(([id, cantidad]) => ({ ...combosPorId[id], cantidad }))
        .filter((it) => it.id),
    [carritoCombos, combosPorId]
  );

  const totalCarrito = useMemo(
    () => calcularTotalCarrito(itemsCarrito, itemsCarritoCombos),
    [itemsCarrito, itemsCarritoCombos]
  );
  const esBarberia = !!barberia;
  // En una barbería hay cita: los servicios (sin stock) y los combos piden día y hora.
  // Si el carrito solo tiene productos (una pomada), se pide como cualquier pedido.
  const requiereCita = esBarberia && (itemsCarrito.some((it) => it.stock_disponible == null) || itemsCarritoCombos.length > 0);
  // Una barbería no hace delivery de servicios: se retira / se asiste en el local.
  const entregaDisponible = !!bodega?.delivery_domicilio && !esBarberia;
  const esDomicilio = !esBarberia && entregaDomicilio(bodega, tipoEntrega);
  const costoEnvio = calcularCostoEnvio(bodega, esDomicilio);
  const totalConEnvio = totalCarrito + costoEnvio;
  const telefonoEntregaLimpio = telefonoEntrega.replace(/\D/g, "");
  const pedidoMinimo = Number(bodega?.pedido_minimo) || 0;
  // Qué le falta al cliente para poder enviar un pedido a domicilio.
  const problemaReserva = !requiereCita
    ? ""
    : !reservaFecha
    ? "Elige el día de tu cita."
    : reservaFecha < hoyISO()
    ? "El día de la cita no puede ser anterior a hoy."
    : !reservaHora
    ? "Elige la hora de tu cita."
    : "";
  // Agenda real: la barbería cargó horarios, así que la hora se elige entre las libres.
  const agendaActiva = !!barberia?.agenda;
  const reservaBarberoId = (barberia?.barberos || []).find((b) => b.nombre === reservaBarbero)?.id || null;
  const itemsAgenda = JSON.stringify([
    ...itemsCarrito.map((it) => ({ id: it.id, cantidad: it.cantidad })),
    ...itemsCarritoCombos.map((it) => ({ combo_id: it.id, cantidad: it.cantidad })),
  ]);
  useEffect(() => {
    if (!agendaActiva || !requiereCita || !reservaFecha || reservaFecha < hoyISO()) {
      setHorasLibres({ cargando: false, horas: [], duracion: 0 });
      return undefined;
    }
    let vivo = true;
    setHorasLibres((h) => ({ ...h, cargando: true }));
    sbClient
      .rpc("obtener_disponibilidad_barberia", {
        p_slug: slug,
        p_fecha: reservaFecha,
        p_items: JSON.parse(itemsAgenda),
        p_barbero: reservaBarberoId,
      })
      .then(({ data, error: err }) => {
        if (!vivo) return;
        const horas = !err && Array.isArray(data?.horas) ? data.horas : [];
        setHorasLibres({ cargando: false, horas, duracion: data?.duracion || 0 });
        setReservaHora((h) => (horas.includes(h) ? h : ""));
      });
    return () => { vivo = false; };
  }, [agendaActiva, requiereCita, reservaFecha, reservaBarberoId, itemsAgenda, refrescoHoras]);
  const problemaEntrega = problemaReserva || calcularProblemaEntrega({
    esDomicilio,
    ubicacion: ubicacionEntrega,
    referencia: referenciaEntrega,
    telefono: telefonoEntrega,
    total: totalCarrito,
    totalConEnvio,
    pedidoMinimo,
    medioPago: medioPagoEntrega,
    pagaCon: pagaConEntrega,
  });
  const totalUnidades = useMemo(
    () => calcularTotalUnidades(itemsCarrito, itemsCarritoCombos),
    [itemsCarrito, itemsCarritoCombos]
  );

  const abrirDetalle = useCallback((prod) => setProductoDetalleId(prod.id), []);
  const abrirDetalleDesdeDestacados = useCallback((prod) => {
    setModalTodosDestacados(false);
    setProductoDetalleId(prod.id);
  }, []);
  const agregarAlCarrito = useCallback((producto) => {
    setCarrito((c) => ({ ...c, [producto.id]: (c[producto.id] || 0) + 1 }));
  }, []);

  const quitarDelCarrito = useCallback((producto) => {
    setCarrito((c) => {
      const actual = c[producto.id] || 0;
      if (actual <= 1) {
        const { [producto.id]: _quitado, ...resto } = c;
        return resto;
      }
      return { ...c, [producto.id]: actual - 1 };
    });
  }, []);

  const agregarComboAlCarrito = useCallback((combo) => {
    setCarritoCombos((c) => ({ ...c, [combo.id]: (c[combo.id] || 0) + 1 }));
  }, []);

  const quitarComboDelCarrito = useCallback((combo) => {
    setCarritoCombos((c) => {
      const actual = c[combo.id] || 0;
      if (actual <= 1) {
        const { [combo.id]: _quitado, ...resto } = c;
        return resto;
      }
      return { ...c, [combo.id]: actual - 1 };
    });
  }, []);

  // "Pedir de nuevo" desde el historial -- solo tiene sentido para un
  // pedido de la MISMA bodega que se está viendo (PantallaMisPedidos.js
  // ya filtra el botón por eso), así que acá se valida contra el
  // catálogo cargado ahora mismo: un producto pudo dejar de existir o
  // quedarse sin stock desde que se hizo ese pedido.
  const repetirPedido = useCallback((pedido) => {
    const nuevoCarrito = {};
    const nuevoCarritoCombos = {};
    let saltados = 0;
    (pedido.items || []).forEach((it) => {
      if (it.combo_id) {
        if (combosPorId[it.combo_id]) {
          nuevoCarritoCombos[it.combo_id] = (nuevoCarritoCombos[it.combo_id] || 0) + it.cantidad;
        } else {
          saltados++;
        }
      } else if (it.id) {
        const prod = productosPorId[it.id];
        const sinStock = prod?.stock_disponible != null && prod.stock_disponible <= 0;
        if (prod && !sinStock) {
          nuevoCarrito[it.id] = (nuevoCarrito[it.id] || 0) + it.cantidad;
        } else {
          saltados++;
        }
      }
    });
    setCarrito(nuevoCarrito);
    setCarritoCombos(nuevoCarritoCombos);
    setError(saltados > 0 ? `${saltados} producto${saltados === 1 ? "" : "s"} de ese pedido ya no ${saltados === 1 ? "está disponible" : "están disponibles"} y no se agregó al carrito.` : "");
    setVistaMisPedidos(false);
    setCarritoAbierto(true);
  }, [productosPorId, combosPorId]);

  const usarMiUbicacion = () => {
    setErrorGps("");
    if (!navigator.geolocation) {
      setErrorGps("Tu navegador no permite obtener la ubicación. Márcala tocando el mapa.");
      return;
    }
    setObteniendoGps(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUbicacionEntrega({ lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) });
        setObteniendoGps(false);
      },
      (err) => {
        setObteniendoGps(false);
        setErrorGps(
          err.code === 1
            ? "No diste permiso de ubicación. Puedes marcarla tocando el mapa."
            : "No pudimos obtener tu ubicación. Márcala tocando el mapa."
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  // "Vaciar" abre un cuadro propio de confirmación (antes era el confirm() del navegador).
  const vaciarPedido = () => setConfirmarVaciarAbierto(true);
  const vaciarPedidoConfirmado = () => {
    setConfirmarVaciarAbierto(false);
    setCarrito({});
    setCarritoCombos({});
    setCarritoAbierto(false);
  };

  const confirmarPedido = async () => {
    if (itemsCarrito.length === 0 && itemsCarritoCombos.length === 0) return;
    if (problemaEntrega) {
      setError(problemaEntrega);
      return;
    }
    setEnviando(true);
    setError("");
    let codigo = generarCodigoCorto();
    const items = [
      ...itemsCarrito.map((it) => ({
        id: it.id,
        descripcion: it.descripcion,
        precio_venta: it.precio_venta,
        cantidad: it.cantidad,
      })),
      ...itemsCarritoCombos.map((it) => ({
        combo_id: it.id,
        descripcion: `Combo: ${it.nombre}`,
        precio_venta: it.precio_venta,
        cantidad: it.cantidad,
        // Solo para el mensaje de WhatsApp: el pedido guardado lo arma el
        // servidor (validar_pedido_delivery), que ignora lo que llegue acá.
        componentes: (it.items || [])
          .filter((c) => c.descripcion)
          .map((c) => ({ descripcion: c.descripcion, cantidad: Number(c.cantidad || 0) })),
      })),
    ];
    const insertarPedido = (codigoPedido) => sbClient.from("pedidos_delivery").insert({
      codigo_corto: codigoPedido,
      bodega_id: bodega.bodega_id,
      items,
      cliente_id: clienteSesion?.id || null,
      ...(requiereCita
        ? {
            cita_fecha: reservaFecha,
            cita_hora: reservaHora,
            cita_barbero: reservaBarbero || null,
            ...(agendaActiva ? { cita_barbero_id: reservaBarberoId } : {}),
          }
        : {}),
      ...(esDomicilio
        ? {
            tipo_entrega: "domicilio",
            entrega_lat: ubicacionEntrega.lat,
            entrega_lng: ubicacionEntrega.lng,
            entrega_referencia: referenciaEntrega.trim(),
            telefono_contacto: telefonoEntregaLimpio,
            medio_pago: medioPagoEntrega,
            paga_con: medioPagoEntrega === "efectivo" && pagaConEntrega ? Number(pagaConEntrega) : null,
          }
        : {}),
    });
    let { error: err } = await insertarPedido(codigo);
    // 23505 = otro cliente generó justo el mismo código corto (es único):
    // se reintenta con uno nuevo en vez de mostrarle un error.
    for (let intento = 0; intento < 3 && err?.code === "23505"; intento++) {
      codigo = generarCodigoCorto();
      ({ error: err } = await insertarPedido(codigo));
    }
    setEnviando(false);
    if (err) {
      const msg = err.message || "";
      setError(
        msg.includes("Demasiados pedidos")
          ? "Hiciste varios pedidos seguidos. Espera unos minutos e inténtalo de nuevo."
          : msg.includes("suficiente stock")
          ? `${msg} Baja la cantidad e intenta de nuevo.`
          : err.code === "P0001" && msg
          ? msg
          : "No se pudo generar el pedido. Inténtalo de nuevo en un momento."
      );
      // La hora pudo haberla tomado otro cliente: se vuelven a pedir las horas libres.
      if (agendaActiva && requiereCita) setRefrescoHoras((n) => n + 1);
      return;
    }
    // El pedido ya existe: se deja listo el sonido de "tu pedido está listo".
    prepararAvisoPedidoListo();
    let barberoCita = reservaBarbero;
    if (agendaActiva && requiereCita) {
      // Con "Cualquiera" el servidor elige el barbero: se lee el que quedó asignado.
      const { data: guardado } = await sbClient
        .from("pedidos_seguimiento")
        .select("cita_barbero")
        .eq("codigo_corto", codigo)
        .maybeSingle();
      if (guardado?.cita_barbero) barberoCita = guardado.cita_barbero;
    }
    const reserva = requiereCita
      ? { fecha: reservaFecha, hora: reservaHora, barbero: barberoCita, agenda: agendaActiva }
      : null;
    const mensaje = reserva
      ? armarMensajeReserva({ bodegaNombre: bodega.nombre, items, total: totalCarrito, codigo, ...reserva })
      : armarMensajeWhatsapp({
      bodegaNombre: bodega.nombre,
      items,
      total: totalCarrito,
      codigo,
      entrega: esDomicilio
        ? {
            costoEnvio,
            medioPago: medioPagoEntrega,
            pagaCon: medioPagoEntrega === "efectivo" && pagaConEntrega ? Number(pagaConEntrega) : null,
            referencia: referenciaEntrega.trim(),
            telefono: telefonoEntregaLimpio,
            lat: ubicacionEntrega.lat,
            lng: ubicacionEntrega.lng,
          }
        : null,
    });
    const telefono = (bodega.telefono || "").replace(/\D/g, "");
    const whatsappUrl = `https://wa.me/${telefono}?text=${encodeURIComponent(mensaje)}`;
    setPedidoConfirmado({
      codigo,
      whatsappUrl,
      domicilio: esDomicilio,
      reserva,
      resumen: {
        unidades: totalUnidades,
        total: totalConEnvio,
        costoEnvio,
        referencia: referenciaEntrega.trim(),
        telefono: telefonoEntregaLimpio,
        medioPago: medioPagoEntrega,
        pagaCon: medioPagoEntrega === "efectivo" && pagaConEntrega ? Number(pagaConEntrega) : null,
      },
    });
    setPagaConEntrega("");
    setReservaFecha("");
    setReservaHora("");
    setReservaBarbero("");
    setCarrito({});
    setCarritoCombos({});
    setCarritoAbierto(false);
  };

  if (estadoBodega === "sin-slug") {
    return (
      <>
        {clienteSesion ? (
          <div className="max-w-md mx-auto px-4 pt-4">
            <div className="flex items-center justify-between mb-1">
              <img src="/logo-horizontal-delivery.svg" alt="Kaserita Delivery" width="2824" height="746" className="h-8 w-auto" />
              <button onClick={salir} className="h-8 px-3.5 rounded-full bg-white ring-1 ring-[#efe6fc] text-xs font-bold text-[#78729a]">
                Cerrar sesión
              </button>
            </div>
          </div>
        ) : null}
        {clienteSesion ? (
          <PantallaMisTiendas esInicio />
        ) : (
          <div className="max-w-md mx-auto px-4 py-14 flex flex-col items-center text-center gap-5">
            <img src="/logo-vertical-delivery.svg" alt="Kaserita Delivery" width="1490" height="1386" className="w-44 h-auto" />
            <div className="space-y-1.5">
              <h1 className="sr-only">Kaserita Delivery</h1>
              <p className="text-sm text-[#78729a]">Este es el catálogo de pedidos de Kaserita.</p>
              <p className="text-sm text-[#78729a]">Pídele a tu bodega el link de su catálogo para empezar a pedir.</p>
            </div>
            {ultimaBodega && (
              <a
                href={`/${ultimaBodega.slug}`}
                className="w-full flex items-center gap-3 bg-white ring-1 ring-[#efe6fc] rounded-[26px] p-2.5 text-left active:scale-[0.99] transition"
              >
                <div className="w-[52px] h-[52px] rounded-[18px] bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] overflow-hidden shrink-0 flex items-center justify-center text-white font-extrabold text-lg">
                  {ultimaBodega.logo_url ? (
                    <img src={ultimaBodega.logo_url} alt={ultimaBodega.nombre} className="w-full h-full object-cover" />
                  ) : (
                    ultimaBodega.nombre?.charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#78729a]">Seguir viendo</p>
                  <p className="font-bold text-[14.5px] text-[#1c1830] truncate">{ultimaBodega.nombre}</p>
                </div>
                <span className="w-9 h-9 rounded-full bg-[#6105dc] text-white flex items-center justify-center shrink-0">
                  <i className="fa-solid fa-arrow-right text-xs"></i>
                </span>
              </a>
            )}
            <button
              onClick={() => setModalCuentaAbierto(true)}
              className="h-11 px-6 rounded-full bg-white ring-1 ring-[#e6dcf7] text-[#4d04b0] text-sm font-bold active:scale-[0.98] transition"
            >
              Ingresa para ver tus bodegas guardadas
            </button>
          </div>
        )}
        {modalCuentaAbierto && (
          <ModalCuenta
            onCerrar={() => setModalCuentaAbierto(false)}
            onGoogle={iniciarConGoogle}
          />
        )}
        {completarPerfilGoogle && (
          <ModalCompletarPerfil
            inicial={completarPerfilGoogle}
            onListo={(cliente) => { setClienteSesion(cliente); setCompletarPerfilGoogle(null); }}
            onCancelar={async () => {
              await sbClient.auth.signOut();
              window.location.href = window.location.origin + window.location.pathname;
            }}
          />
        )}
      </>
    );
  }

  if (estadoBodega === "cargando") {
    return (
      <div className="max-w-md mx-auto px-4 py-24 flex flex-col items-center gap-3 text-[#78729a]">
        <i className="fa-solid fa-spinner fa-spin text-2xl text-[#6105dc]"></i>
        <p className="text-sm font-semibold">Cargando...</p>
      </div>
    );
  }

  if (estadoBodega === "no-encontrada") {
    return (
      <div className="max-w-md mx-auto px-4 py-20 flex flex-col items-center text-center gap-3">
        <span className="w-16 h-16 rounded-full bg-[#f4eefe] text-[#6105dc] flex items-center justify-center">
          <i className="fa-solid fa-circle-exclamation text-2xl"></i>
        </span>
        <h1 className="text-lg font-extrabold text-[#1c1830]">No encontramos este catálogo</h1>
        <p className="text-sm text-[#78729a]">Puede que el link esté mal escrito o que la bodega no tenga delivery habilitado.</p>
      </div>
    );
  }

  if (estadoBodega === "cerrada") {
    return (
      <div className="max-w-md mx-auto px-4 py-20 flex flex-col items-center text-center gap-3">
        {bodega?.logo_url ? (
          <img src={bodega.logo_url} alt="" className="w-16 h-16 rounded-full object-cover ring-1 ring-[#efe6fc]" />
        ) : (
          <span className="w-16 h-16 rounded-full bg-[#f4eefe] text-[#6105dc] flex items-center justify-center">
            <i className="fa-solid fa-store text-2xl"></i>
          </span>
        )}
        <h1 className="text-lg font-extrabold text-[#1c1830]">{bodega?.nombre || "Esta tienda"} no está recibiendo pedidos por ahora</h1>
        <p className="text-sm text-[#78729a]">Vuelve a intentarlo más tarde.</p>
      </div>
    );
  }

  if (pedidoConfirmado) {
    return (
      <PantallaConfirmacion
        bodega={bodega}
        codigo={pedidoConfirmado.codigo}
        whatsappUrl={pedidoConfirmado.whatsappUrl}
        domicilio={pedidoConfirmado.domicilio}
        reserva={pedidoConfirmado.reserva}
        resumen={pedidoConfirmado.resumen}
        onVerPedidos={clienteSesion ? () => { setPedidoConfirmado(null); setVistaMisPedidos(true); } : undefined}
        onVolver={() => setPedidoConfirmado(null)}
      />
    );
  }

  // Navegación de la barra inferior: cada pestaña deja abierta solo su pantalla.
  const irAInicio = () => {
    marcarPestana("inicio");
    setVistaMisTiendas(false);
    setVistaMisPedidos(false);
    setPerfilAbierto(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const irATiendas = () => {
    if (!clienteSesion) return setModalCuentaAbierto(true);
    marcarPestana("tiendas");
    setVistaMisPedidos(false);
    setPerfilAbierto(false);
    setVistaMisTiendas(true);
  };
  const irAPedidos = () => {
    if (!clienteSesion) return setModalCuentaAbierto(true);
    marcarPestana("pedidos");
    setVistaMisTiendas(false);
    setPerfilAbierto(false);
    setVistaMisPedidos(true);
  };
  const irAPerfil = () => {
    if (!clienteSesion) return setModalCuentaAbierto(true);
    marcarPestana("perfil");
    setVistaMisTiendas(false);
    setVistaMisPedidos(false);
    setPerfilAbierto(true);
  };
  // El contador y el aviso cuentan solo los pedidos en curso de esta tienda.
  const pedidosActivosAqui = bodega?.bodega_id
    ? pedidosActivos.filter((pa) => pa.bodega_id === bodega.bodega_id)
    : pedidosActivos;
  // Opciones del menú en abanico de "Perfil" (de abajo hacia arriba). Solo con
  // sesión iniciada; sin sesión, tocar Perfil pide entrar como siempre.
  const accionesPerfil = (conDireccion) => {
    if (!clienteSesion) return null;
    const a = [{ icono: "fa-user", texto: "Mi perfil", color: "#6105dc", onClick: irAPerfil }];
    if (conDireccion) a.push({ icono: "fa-location-dot", texto: "Mi dirección", color: "#0ea5e9", onClick: () => setUbicacionAbierta(true) });
    if (eventoInstalacion || (esIOS && !yaInstalada)) {
      a.push({ icono: "fa-download", texto: "Instalar app", color: "#f59e0b", onClick: () => { if (eventoInstalacion) instalarApp(); else setInstruccionesIOSAbiertas(true); } });
    }
    a.push({ icono: "fa-right-from-bracket", texto: "Cerrar sesión", color: "#e11d48", onClick: () => { setPerfilAbierto(false); salir(); } });
    return a;
  };
  // Miniaturas de lo agregado para el chip del dock: un combo muestra la foto de
  // su primer producto; sin foto, un ícono.
  const miniaturasDock = () => [
    ...itemsCarrito.map((it) => ({ id: `p${it.id}`, foto: it.foto_url, categoria: it.categoria })),
    ...itemsCarritoCombos.map((c) => ({
      id: `c${c.id}`,
      foto: productosPorId[c.items?.[0]?.producto_id]?.foto_url,
      categoria: "combo",
    })),
  ];
  const barraNavegacion = (activa) => (
    <BarraNavegacion
      activa={activa}
      contadorPedidos={pedidosActivosAqui.length}
      onInicio={irAInicio}
      onTiendas={irATiendas}
      onPedidos={irAPedidos}
      onPerfil={irAPerfil}
      acciones={accionesPerfil(false)}
    />
  );

  if (vistaMisPedidos && clienteSesion) {
    return (
      <>
        <div className="kd-entra relative" style={{ "--d": direccionEntrada }}>
          <PantallaMisPedidos
            cliente={clienteSesion}
            onVolver={() => setVistaMisPedidos(false)}
            bodegaActualId={bodega?.bodega_id}
            onRepetirPedido={repetirPedido}
          />
        </div>
        {barraNavegacion("pedidos")}
      </>
    );
  }

  if (vistaMisTiendas && clienteSesion) {
    return (
      <>
        <div className="kd-entra relative" style={{ "--d": direccionEntrada }}>
          <PantallaMisTiendas onVolver={() => setVistaMisTiendas(false)} />
        </div>
        {barraNavegacion("tiendas")}
      </>
    );
  }

  return (
    <div className="kd-entra relative max-w-3xl mx-auto pb-48" style={{ "--d": direccionEntrada }}>
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <div className="w-[46px] h-[46px] rounded-2xl bg-[#f4eefe] overflow-hidden shrink-0">
          {bodega.logo_url ? (
            <img src={bodega.logo_url} alt={bodega.nombre} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] text-white font-bold">
              {bodega.nombre?.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h1 className="text-base font-bold text-[#1c1830] truncate">{bodega.nombre}</h1>
            {estadoHorario && (
              <span
                className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-1 ${
                  estadoHorario.abierto ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-500"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${estadoHorario.abierto ? "bg-emerald-500" : "bg-stone-400"}`}></span>
                {estadoHorario.abierto ? "Abierto" : "Cerrado"}
              </span>
            )}
          </div>
          {bodega.direccion ? (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(bodega.direccion)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-stone-400 truncate flex items-center gap-1 hover:text-violet-600"
            >
              <i className="fa-solid fa-location-dot text-[10px] shrink-0"></i>
              <span className="truncate">{bodega.direccion}</span>
            </a>
          ) : (
            <p className="text-xs text-stone-400 truncate">Armá tu pedido y mandalo por WhatsApp</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={alternarSeguirTienda}
            title={tiendaSeguida ? "Dejar de seguir esta tienda" : "Seguir esta tienda"}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition ${tiendaSeguida ? "bg-[#f4eefe] text-[#6105dc]" : "bg-white ring-1 ring-[#efe6fc] text-[#4d04b0]"}`}
          >
            <i className={`${tiendaSeguida ? "fa-solid" : "fa-regular"} fa-heart text-xs`}></i>
          </button>
          {tiendaSeguida && clienteSesion && (
            <button
              onClick={alternarAvisosTienda}
              title={avisosTienda ? "Avisos activados (toca para apagarlos)" : "Avisos apagados (toca para activarlos)"}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition ${avisosTienda ? "bg-[#f4eefe] text-[#6105dc]" : "bg-white ring-1 ring-[#efe6fc] text-[#a29cbd]"}`}
            >
              <i className={`fa-solid ${avisosTienda ? "fa-bell" : "fa-bell-slash"} text-xs`}></i>
            </button>
          )}
          {!clienteSesion && (
            <button
              onClick={() => setModalCuentaAbierto(true)}
              className="h-9 px-4 rounded-full bg-[#6105dc] text-white text-xs font-bold"
            >
              Ingresar
            </button>
          )}
        </div>
      </header>

      {(() => {
        const activoAqui = pedidosActivosAqui[0];
        if (!activoAqui) return null;
        const et = etiquetaEstadoPedido(activoAqui);
        const otros = pedidosActivosAqui.length - 1;
        return (
          <div className="mx-4 mt-2 mb-1 rounded-[22px] bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] text-white px-3.5 py-3 flex items-center gap-3">
            <span className="w-10 h-10 rounded-[14px] bg-white/20 shrink-0 flex items-center justify-center">
              <i className={`fa-solid ${activoAqui.estado === "en_camino" ? "fa-motorcycle" : activoAqui.estado === "listo" ? "fa-bell" : "fa-kitchen-set"} text-sm`}></i>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-bold leading-tight">Tu pedido · {activoAqui.codigo_corto}</p>
              <p className="text-xs text-white/85">
                {et.texto}
                {otros > 0 ? ` · ${otros} más en curso` : ""}
              </p>
            </div>
            <button onClick={() => setVistaMisPedidos(true)} className="shrink-0 h-8 px-3.5 rounded-full bg-white text-[#4d04b0] text-xs font-bold">
              Ver
            </button>
          </div>
        );
      })()}

      {avisoSeguir && (
        <div className="fixed bottom-48 left-1/2 -translate-x-1/2 z-40 max-w-[90%] bg-stone-900 text-white text-xs px-4 py-2.5 rounded-full shadow-lg text-center">
          {avisoSeguir}
        </div>
      )}

      {productos.length > 0 && (
        <div className="px-4 pt-3 pb-2 bg-[#f7f5fb]/90 backdrop-blur sticky top-0 z-20 space-y-2.5">
          <div className="relative">
            <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-[#a29cbd] text-sm"></i>
            <input
              type="text"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar producto..."
              className="w-full bg-white border border-[#e6dcf7] rounded-full pl-11 pr-4 py-3 text-sm text-stone-800 placeholder-[#a29cbd] focus:outline-none focus:border-[#6105dc]/45 focus:ring-4 focus:ring-[#6105dc]/[0.07]"
            />
          </div>
          {categorias.length > 0 && (
            <div className="relative -mx-4">
              {/* Categorías: solo texto, en píldoras que se deslizan de lado. */}
              <div className="flex gap-2 overflow-x-auto hide-scrollbar px-4 py-1">
                <button
                  onClick={() => { setCategoriaActiva(""); setSoloFavoritos(false); }}
                  className={`kcat ${categoriaActiva === "" && !soloFavoritos ? "kcat-on" : ""}`}
                >
                  Todos
                </button>
                {favoritos.size > 0 && (
                  <button
                    onClick={() => { setSoloFavoritos((v) => !v); setCategoriaActiva(""); }}
                    className={`kcat ${soloFavoritos ? "kcat-on" : ""}`}
                  >
                    Favoritos
                  </button>
                )}
                {categorias.map((c) => (
                  <button
                    key={c}
                    onClick={() => { setCategoriaActiva(c); setSoloFavoritos(false); }}
                    className={`kcat ${categoriaActiva === c ? "kcat-on" : ""}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <div className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-[#f7f5fb] to-transparent"></div>
            </div>
          )}
        </div>
      )}

      {combos.length > 0 && !busqueda.trim() && !categoriaActiva && !soloFavoritos && (
        <div className="pt-4">
          <div className="px-4 flex items-center justify-between mb-2">
            <p className="text-sm font-bold text-stone-800 flex items-center gap-1.5">
              <i className="fa-solid fa-gift text-[#6105dc]"></i> Combos con descuento
            </p>
            {combos.length > 2 && (
              <button onClick={() => setModalTodosCombos(true)} className="text-xs font-semibold text-violet-600">
                Ver todos
              </button>
            )}
          </div>
          <div
            ref={comboScrollRef}
            onScroll={manejarScrollCombos}
            className="flex overflow-x-auto hide-scrollbar px-4 pb-1 snap-x snap-mandatory scroll-pl-4"
          >
            {combos.map((combo) => (
              <div key={combo.id} className="w-[88%] shrink-0 snap-start pr-3 last:pr-0">
                <TarjetaComboMemo
                  combo={combo}
                  cantidadCombo={carritoCombos[combo.id] || 0}
                  productosPorId={productosPorId}
                  onAgregar={agregarComboAlCarrito}
                  onQuitar={quitarComboDelCarrito}
                  ancho="w-full"
                />
              </div>
            ))}
          </div>
          {combos.length > 1 && (
            <div className="flex items-center justify-center gap-1.5 pt-2">
              {combos.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${i === comboActivo ? "w-5 bg-[#6105dc]" : "w-1.5 bg-[#d9cdf3]"}`}
                ></span>
              ))}
            </div>
          )}
        </div>
      )}

      {productosDestacados.length > 0 && (
        <div className="pt-4">
          <div className="px-4 flex items-center justify-between mb-2">
            <p className="text-sm font-bold text-stone-800 flex items-center gap-1.5">
              <i className="fa-solid fa-star text-[#6105dc]"></i> Destacados
            </p>
            {productosDestacados.length > 2 && (
              <button onClick={() => setModalTodosDestacados(true)} className="text-xs font-semibold text-violet-600">
                Ver todos
              </button>
            )}
          </div>
          <div
            ref={destacadoScrollRef}
            onScroll={manejarScrollDestacados}
            className="flex overflow-x-auto hide-scrollbar px-4 pb-1 snap-x snap-mandatory scroll-pl-4"
          >
            {productosDestacados.map((p) => (
              <div key={p.id} className="w-[88%] shrink-0 snap-start pr-3 last:pr-0">
                <TarjetaDestacadoMemo
                  producto={p}
                  cantidadEnCarrito={carrito[p.id] || 0}
                  onAgregar={agregarAlCarrito}
                  onQuitar={quitarDelCarrito}
                  onAbrir={abrirDetalle}
                />
              </div>
            ))}
          </div>
          {productosDestacados.length > 1 && (
            <div className="flex items-center justify-center gap-1.5 pt-2">
              {productosDestacados.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${i === destacadoActivo ? "w-5 bg-[#6105dc]" : "w-1.5 bg-[#d9cdf3]"}`}
                ></span>
              ))}
            </div>
          )}
        </div>
      )}

      <main className="px-4 py-4">
        {!cargandoProductos && productosFiltrados.length > 0 && (
          <div className="flex items-center justify-between mb-3">
            <p className="text-base font-bold text-[#1c1830]">Todos los productos</p>
            <span className="text-xs font-semibold text-[#6105dc]">{productosFiltrados.length} productos</span>
          </div>
        )}
        {cargandoProductos ? (
          <p className="text-center text-stone-400 py-10">Cargando catálogo...</p>
        ) : productos.length === 0 ? (
          <p className="text-center text-stone-400 py-10">Esta bodega todavía no tiene productos publicados.</p>
        ) : productosFiltrados.length === 0 ? (
          <div className="text-center text-stone-400 py-10">
            <p>{soloFavoritos ? "Todavía no marcaste ningún favorito." : "No encontramos productos con ese criterio."}</p>
            <button
              onClick={() => { setBusqueda(""); setCategoriaActiva(""); setSoloFavoritos(false); }}
              className="text-violet-600 text-sm font-semibold underline mt-2"
            >
              Limpiar filtros
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
            {productosFiltrados.map((p) => (
              <TarjetaProductoMemo
                key={p.id}
                producto={p}
                cantidadEnCarrito={carrito[p.id] || 0}
                onAgregar={agregarAlCarrito}
                onQuitar={quitarDelCarrito}
                onVerFoto={setFotoAmpliada}
                onAbrir={abrirDetalle}
                esFavorito={favoritos.has(p.id)}
                onToggleFavorito={toggleFavorito}
              />
            ))}
          </div>
        )}
      </main>

      {productosAgotados.length > 0 && (
        <div className="px-4 pb-4">
          <p className="text-sm font-bold text-stone-500 flex items-center gap-1.5 mb-2">
            <i className="fa-solid fa-box-open text-stone-400"></i> Agotados por ahora
          </p>
          <div className="bg-white ring-1 ring-[#efe6fc] rounded-2xl divide-y divide-[#f4eefe]">
            {productosAgotados.map((p) => {
              return (
                <div key={p.id} className="flex items-center gap-3 p-3">
                  <div className="w-11 h-11 rounded-xl bg-stone-100 flex items-center justify-center overflow-hidden shrink-0 grayscale opacity-70">
                    {p.foto_url ? (
                      <img src={p.foto_url} alt={tituloProducto(p.descripcion)} className="w-full h-full object-contain p-0.5 mix-blend-multiply" />
                    ) : (
                      <i className="fa-solid fa-image text-stone-300"></i>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-stone-600 truncate">{tituloProducto(p.descripcion)}</p>
                    <p className="text-xs text-stone-400">Sin stock</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <BarraNavegacion
        activa={perfilAbierto ? "perfil" : "inicio"}
        contadorPedidos={pedidosActivosAqui.length}
        onInicio={irAInicio}
        onTiendas={irATiendas}
        onPedidos={irAPedidos}
        onPerfil={irAPerfil}
        carrito={
          totalUnidades > 0 && !carritoAbierto
            ? { cantidad: totalUnidades, total: totalCarrito, miniaturas: miniaturasDock(), onVer: () => setCarritoAbierto(true) }
            : null
        }
        acciones={accionesPerfil(true)}
      />

      {perfilAbierto && clienteSesion && (
        <PantallaPerfil
          cliente={clienteSesion}
          onActualizado={setClienteSesion}
          onVolver={() => setPerfilAbierto(false)}
          direccion={{ referencia: referenciaEntrega.trim(), tiene: !!ubicacionEntrega }}
          onEditarDireccion={() => setUbicacionAbierta(true)}
          onInstalar={
            eventoInstalacion || (esIOS && !yaInstalada)
              ? () => { if (eventoInstalacion) instalarApp(); else setInstruccionesIOSAbiertas(true); }
              : null
          }
          onSalir={() => { setPerfilAbierto(false); salir(); }}
        />
      )}

      {carritoAbierto && (
        <div className="fixed inset-0 z-30 flex flex-col bg-gradient-to-br from-[#f4effc] via-[#f9f8fb] to-[#f5f4f8]">
          <div className="max-w-md w-full mx-auto flex flex-col h-full min-h-0">
            <div className="flex items-center gap-3 px-4 pt-4 pb-2.5">
              <button
                onClick={() => setCarritoAbierto(false)}
                aria-label="Volver"
                className="w-10 h-10 rounded-full bg-white ring-1 ring-[#efe6fc] text-[#4d04b0] flex items-center justify-center shrink-0"
              >
                <i className="fa-solid fa-arrow-left text-sm"></i>
              </button>
              <h2 className="flex-1 text-[19px] font-extrabold tracking-tight text-[#1c1830]">{requiereCita ? "Tu reserva" : "Tu pedido"}</h2>
              {(itemsCarrito.length > 0 || itemsCarritoCombos.length > 0) && (
                <button onClick={vaciarPedido} className="text-[12.5px] font-semibold text-[#6105dc]">
                  Vaciar
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-3 [&>*]:shrink-0">
              {itemsCarrito.length === 0 && itemsCarritoCombos.length === 0 ? (
                <div className="text-center py-16 space-y-3">
                  <i className="fa-solid fa-bag-shopping text-3xl text-[#cfc4ea] block"></i>
                  <p className="text-[#78729a]">Tu carrito está vacío.</p>
                  <button
                    onClick={() => setCarritoAbierto(false)}
                    className="h-11 px-6 rounded-full bg-[#6105dc] text-white text-sm font-bold"
                  >
                    Volver a la tienda
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 px-0.5">
                    <div className="w-10 h-10 rounded-[14px] bg-gradient-to-br from-[#8a3df2] to-[#4d04b0] overflow-hidden shrink-0 flex items-center justify-center text-white font-bold">
                      {bodega.logo_url ? (
                        <img src={bodega.logo_url} alt={bodega.nombre} className="w-full h-full object-cover" />
                      ) : (
                        bodega.nombre?.charAt(0).toUpperCase()
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[14.5px] font-bold text-[#1c1830] truncate">{bodega.nombre}</p>
                      {estadoHorario && (
                        <p className="text-xs text-[#78729a]">{estadoHorario.abierto ? "Abierto ahora" : "Cerrado ahora"}</p>
                      )}
                    </div>
                  </div>

                  {!esBarberia && (
                  <div className="grid grid-cols-2 gap-1.5 bg-white rounded-[22px] p-1.5 ring-1 ring-[#efe6fc]">
                    {[
                      ["domicilio", "Delivery", "fa-motorcycle", entregaDisponible ? formatoMoneda(Number(bodega?.costo_envio) || 0) : "No disponible"],
                      ["retiro", "Retiro", "fa-store", "Gratis"],
                    ].map(([id, texto, icono, detalle]) => {
                      const deshabilitado = id === "domicilio" && !entregaDisponible;
                      const seleccionado = (esDomicilio ? "domicilio" : "retiro") === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          disabled={deshabilitado}
                          onClick={() => {
                            setTipoEntrega(id);
                            setError("");
                            if (id === "domicilio" && !ubicacionEntrega) setUbicacionAbierta(true);
                          }}
                          className={`rounded-[17px] py-2.5 px-2 flex flex-col items-center gap-0.5 transition ${
                            seleccionado ? "bg-[#6105dc] text-white" : deshabilitado ? "text-[#cfc4ea] cursor-not-allowed" : "text-[#78729a]"
                          }`}
                        >
                          <span className="text-sm font-bold flex items-center gap-2">
                            <i className={`fa-solid ${icono} text-xs`}></i> {texto}
                          </span>
                          <span className={`text-[11.5px] ${seleccionado ? "text-white/85" : ""}`}>{detalle}</span>
                        </button>
                      );
                    })}
                  </div>
                  )}
                  {!esBarberia && !entregaDisponible && (
                    <p className="text-[11px] text-[#78729a] -mt-1.5 px-1">Este local no tiene entrega a domicilio por ahora.</p>
                  )}

                  <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] overflow-hidden">
                    {esDomicilio ? (
                      <button type="button" onClick={() => setUbicacionAbierta(true)} className="w-full text-left flex items-center gap-3 px-3.5 py-3">
                        <span className="w-[62px] h-[62px] rounded-2xl bg-[#f4eefe] text-[#6105dc] shrink-0 flex items-center justify-center">
                          <i className="fa-solid fa-location-dot text-2xl"></i>
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[10.5px] font-bold tracking-[0.07em] uppercase text-[#78729a]">Entregar en</span>
                          <span className="block text-sm font-bold text-[#1c1830] leading-snug line-clamp-2">
                            {ubicacionEntrega ? referenciaEntrega.trim() || "Ubicación marcada en el mapa" : "Marca dónde te lo llevamos"}
                          </span>
                          <span className="block text-xs text-[#78729a]">
                            {ubicacionEntrega ? telefonoEntrega || "Falta tu teléfono" : "Toca para elegir en el mapa"}
                          </span>
                        </span>
                        <span className="text-[12.5px] font-bold text-[#6105dc] shrink-0">{ubicacionEntrega ? "Cambiar" : "Marcar"}</span>
                      </button>
                    ) : (
                      <div className="flex items-center gap-3 px-3.5 py-3">
                        <span className="w-[62px] h-[62px] rounded-2xl bg-[#f4eefe] text-[#6105dc] shrink-0 flex items-center justify-center">
                          <i className="fa-solid fa-store text-2xl"></i>
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[10.5px] font-bold tracking-[0.07em] uppercase text-[#78729a]">Retiras en</span>
                          <span className="block text-sm font-bold text-[#1c1830] leading-snug">{bodega.nombre}</span>
                          {bodega.direccion && <span className="block text-xs text-[#78729a] line-clamp-2">{bodega.direccion}</span>}
                        </span>
                        {bodega.direccion && (
                          <a
                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(bodega.direccion)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[12.5px] font-bold text-[#6105dc] shrink-0"
                          >
                            Ver mapa
                          </a>
                        )}
                      </div>
                    )}

                    {requiereCita ? (
                      <div className="px-3.5 py-3 border-t border-[#efe6fc] flex flex-col gap-2.5">
                        <div className="flex items-center gap-3">
                          <span className="w-10 h-10 rounded-[14px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
                            <i className="fa-regular fa-calendar-check text-sm"></i>
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm font-bold text-[#1c1830]">Elige tu cita</span>
                            <span className="block text-xs text-[#78729a]">
                              {agendaActiva ? "Elige una hora libre con tu barbero" : "El local te confirma el horario por WhatsApp"}
                            </span>
                          </span>
                        </div>
                        {agendaActiva ? (
                          <>
                            <div className="grid grid-cols-2 gap-2">
                              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#78729a]">
                                Barbero
                                <select
                                  value={reservaBarbero}
                                  onChange={(e) => { setReservaBarbero(e.target.value); setReservaHora(""); setError(""); }}
                                  className="h-11 rounded-xl bg-[#f9f8fb] ring-1 ring-[#efe6fc] px-2.5 text-sm font-semibold text-[#1c1830]"
                                >
                                  <option value="">Cualquiera</option>
                                  {(barberia?.barberos || []).map((b) => (
                                    <option key={b.id} value={b.nombre}>{b.nombre}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#78729a]">
                                Día
                                <input
                                  type="date"
                                  min={hoyISO()}
                                  value={reservaFecha}
                                  onChange={(e) => { setReservaFecha(e.target.value); setReservaHora(""); setError(""); }}
                                  className="h-11 rounded-xl bg-[#f9f8fb] ring-1 ring-[#efe6fc] px-2.5 text-sm font-semibold text-[#1c1830]"
                                />
                              </label>
                            </div>
                            {reservaFecha && (
                              <div className="flex flex-col gap-1.5">
                                <span className="text-[11px] font-semibold text-[#78729a]">
                                  Hora{horasLibres.duracion > 0 ? ` · tu cita dura unos ${horasLibres.duracion} min` : ""}
                                </span>
                                {horasLibres.cargando ? (
                                  <p className="text-xs text-[#78729a]">Buscando horas libres...</p>
                                ) : horasLibres.horas.length === 0 ? (
                                  <p className="text-xs text-[#78729a]">
                                    No quedan horas libres ese día. Prueba con otro día o con otro barbero.
                                  </p>
                                ) : (
                                  <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Horas libres">
                                    {horasLibres.horas.map((h) => (
                                      <button
                                        key={h}
                                        type="button"
                                        role="radio"
                                        aria-checked={reservaHora === h}
                                        onClick={() => { setReservaHora(h); setError(""); }}
                                        className={`h-10 rounded-xl text-sm font-bold tabular-nums ${
                                          reservaHora === h
                                            ? "bg-[#6105dc] text-white"
                                            : "bg-[#f9f8fb] ring-1 ring-[#efe6fc] text-[#1c1830]"
                                        }`}
                                      >
                                        {h}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="grid grid-cols-2 gap-2">
                              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#78729a]">
                                Día
                                <input
                                  type="date"
                                  min={hoyISO()}
                                  value={reservaFecha}
                                  onChange={(e) => { setReservaFecha(e.target.value); setError(""); }}
                                  className="h-11 rounded-xl bg-[#f9f8fb] ring-1 ring-[#efe6fc] px-2.5 text-sm font-semibold text-[#1c1830]"
                                />
                              </label>
                              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#78729a]">
                                Hora
                                <input
                                  type="time"
                                  step="900"
                                  value={reservaHora}
                                  onChange={(e) => { setReservaHora(e.target.value); setError(""); }}
                                  className="h-11 rounded-xl bg-[#f9f8fb] ring-1 ring-[#efe6fc] px-2.5 text-sm font-semibold text-[#1c1830]"
                                />
                              </label>
                            </div>
                            <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#78729a]">
                              Barbero
                              <select
                                value={reservaBarbero}
                                onChange={(e) => setReservaBarbero(e.target.value)}
                                className="h-11 rounded-xl bg-[#f9f8fb] ring-1 ring-[#efe6fc] px-2.5 text-sm font-semibold text-[#1c1830]"
                              >
                                <option value="">Cualquiera</option>
                                {(barberia?.barberos || []).map((b) => (
                                  <option key={b.id} value={b.nombre}>{b.nombre}</option>
                                ))}
                              </select>
                            </label>
                          </>
                        )}
                      </div>
                    ) : (
                    <div className="flex items-center gap-3 px-3.5 py-3 border-t border-[#efe6fc]">
                      <span className="w-10 h-10 rounded-[14px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
                        <i className="fa-regular fa-clock text-sm"></i>
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-bold text-[#1c1830]">Lo antes posible</span>
                        <span className="block text-xs text-[#78729a]">
                          {esDomicilio ? "El local te confirma el tiempo por WhatsApp" : "Te avisamos cuando esté listo"}
                        </span>
                      </span>
                    </div>
                    )}

                    {esDomicilio ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setPagoAbierto((v) => !v)}
                          className="w-full text-left flex items-center gap-3 px-3.5 py-3 border-t border-[#efe6fc]"
                        >
                          <span className="w-10 h-10 rounded-[14px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
                            <i className={`fa-solid ${MEDIOS_PAGO_ENTREGA.find((m) => m.id === medioPagoEntrega)?.icono || "fa-money-bill-wave"} text-sm`}></i>
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm font-bold text-[#1c1830]">{TEXTO_MEDIO_PAGO[medioPagoEntrega]}</span>
                            <span className="block text-xs text-[#78729a]">
                              Pagas al recibir
                              {medioPagoEntrega === "efectivo" && pagaConEntrega ? ` · con ${formatoMoneda(pagaConEntrega)}` : ""}
                            </span>
                          </span>
                          <i className={`fa-solid fa-chevron-down text-xs text-[#a29cbd] transition-transform ${pagoAbierto ? "rotate-180" : ""}`}></i>
                        </button>
                        {pagoAbierto && (
                          <div className="px-3.5 pb-3.5 flex flex-col gap-2.5">
                            <div className="flex flex-wrap gap-2">
                              {MEDIOS_PAGO_ENTREGA.map((m) => (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => setMedioPagoEntrega(m.id)}
                                  className={`px-3.5 py-2 rounded-full text-xs font-semibold flex items-center gap-1.5 transition ${
                                    medioPagoEntrega === m.id ? "bg-[#6105dc] text-white" : "bg-white ring-1 ring-[#efe6fc] text-[#4d04b0]"
                                  }`}
                                >
                                  <i className={`fa-solid ${m.icono}`}></i> {m.texto}
                                </button>
                              ))}
                            </div>
                            {medioPagoEntrega === "efectivo" && (
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="0.1"
                                value={pagaConEntrega}
                                onChange={(e) => setPagaConEntrega(e.target.value)}
                                placeholder="¿Con cuánto pagas? (opcional)"
                                className="w-full bg-white border border-[#e6dcf7] rounded-full px-4 py-2.5 text-sm text-stone-800 placeholder:text-[#a29cbd] focus:outline-none focus:border-[#6105dc]/45 focus:ring-4 focus:ring-[#6105dc]/[0.07]"
                              />
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="flex items-center gap-3 px-3.5 py-3 border-t border-[#efe6fc]">
                        <span className="w-10 h-10 rounded-[14px] bg-[#f4eefe] text-[#4d04b0] shrink-0 flex items-center justify-center">
                          <i className="fa-solid fa-money-bill-wave text-sm"></i>
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-bold text-[#1c1830]">Pagas en caja</span>
                          <span className="block text-xs text-[#78729a]">Efectivo, Yape o tarjeta</span>
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] overflow-hidden">
                    <div className="flex items-center justify-between px-3.5 pt-3.5 pb-1">
                      <p className="text-[15px] font-bold text-[#1c1830]">Tu pedido</p>
                      <button onClick={() => setCarritoAbierto(false)} className="text-[12.5px] font-bold text-[#6105dc]">
                        Agregar más
                      </button>
                    </div>
                    {itemsCarritoCombos.map((it) => (
                      <div key={`combo-${it.id}`} className="flex items-center gap-3 px-3.5 py-2.5 border-t border-[#efe6fc] first:border-t-0">
                        <span className="w-[54px] h-[54px] rounded-2xl bg-[#f4eefe] text-[#6105dc] shrink-0 flex items-center justify-center">
                          <i className="fa-solid fa-gift text-lg"></i>
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-[#1c1830] leading-tight line-clamp-2">Combo: {it.nombre}</p>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <button onClick={() => quitarComboDelCarrito(it)} className="w-[26px] h-[26px] rounded-full bg-[#f4eefe] text-[#4d04b0] flex items-center justify-center">
                              <i className="fa-solid fa-minus text-[10px]"></i>
                            </button>
                            <span className="min-w-[16px] text-center text-[13px] font-bold">{it.cantidad}</span>
                            <button onClick={() => agregarComboAlCarrito(it)} className="w-[26px] h-[26px] rounded-full bg-[#6105dc] text-white flex items-center justify-center">
                              <i className="fa-solid fa-plus text-[10px]"></i>
                            </button>
                          </div>
                        </div>
                        <span className="text-sm font-bold tabular-nums shrink-0">{formatoMoneda(it.precio_venta * it.cantidad)}</span>
                      </div>
                    ))}
                    {itemsCarrito.map((it) => (
                      <div key={it.id} className="flex items-center gap-3 px-3.5 py-2.5 border-t border-[#efe6fc] first:border-t-0">
                        <span
                          className="w-[54px] h-[54px] rounded-2xl overflow-hidden shrink-0 flex items-center justify-center"
                          style={{ background: tonoCategoria(it.categoria).t }}
                        >
                          {it.foto_url ? (
                            <img src={it.foto_url} alt={tituloProducto(it.descripcion)} className="w-full h-full object-contain p-1 mix-blend-multiply" />
                          ) : (
                            <i className="fa-solid fa-image text-[#cfc4ea]"></i>
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-[#1c1830] leading-tight line-clamp-2">{tituloProducto(it.descripcion)}</p>
                          <p className="text-xs text-[#78729a]">{formatoMoneda(it.precio_venta)} c/u</p>
                          <div className="flex items-center gap-1.5 mt-1">
                            <button onClick={() => quitarDelCarrito(it)} className="w-[26px] h-[26px] rounded-full bg-[#f4eefe] text-[#4d04b0] flex items-center justify-center">
                              <i className="fa-solid fa-minus text-[10px]"></i>
                            </button>
                            <span className="min-w-[16px] text-center text-[13px] font-bold">{it.cantidad}</span>
                            <button onClick={() => agregarAlCarrito(it)} className="w-[26px] h-[26px] rounded-full bg-[#6105dc] text-white flex items-center justify-center">
                              <i className="fa-solid fa-plus text-[10px]"></i>
                            </button>
                          </div>
                        </div>
                        <span className="text-sm font-bold tabular-nums shrink-0">{formatoMoneda(it.precio_venta * it.cantidad)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="bg-white rounded-[22px] ring-1 ring-[#efe6fc] px-3.5 py-3 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-[13px] text-[#78729a]">
                      <span>Productos ({totalUnidades})</span>
                      <span className="font-semibold text-[#1c1830] tabular-nums">{formatoMoneda(totalCarrito)}</span>
                    </div>
                    {esDomicilio && (
                      <div className="flex items-center justify-between text-[13px] text-[#78729a]">
                        <span>Envío a domicilio</span>
                        <span className="font-semibold text-[#1c1830] tabular-nums">{formatoMoneda(costoEnvio)}</span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between border-t border-dashed border-[#e2d6f6] pt-2 mt-0.5">
                      <span className="font-bold text-[#1c1830]">{esDomicilio ? "Total a pagar" : "Total"}</span>
                      <span className="text-xl font-extrabold tracking-tight tabular-nums text-[#1c1830]">{formatoMoneda(totalConEnvio)}</span>
                    </div>
                  </div>

                  {(bodega.zona_reparto || pedidoMinimo > 0) && esDomicilio && (
                    <p className="text-[11px] text-[#78729a] leading-snug px-1">
                      {bodega.zona_reparto ? `Zona de reparto: ${bodega.zona_reparto}.` : ""}
                      {pedidoMinimo > 0 ? ` Pedido mínimo: ${formatoMoneda(pedidoMinimo)}.` : ""}
                    </p>
                  )}
                  {estadoHorario && !estadoHorario.abierto && (
                    <p className="text-xs text-[#78729a] bg-white ring-1 ring-[#efe6fc] rounded-2xl px-3 py-2.5 flex items-center gap-1.5">
                      <i className="fa-solid fa-clock text-[#a29cbd]"></i>
                      Este local está cerrado ahora: tu pedido va a esperar hasta que vuelvan a abrir.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="px-4 pt-3 pb-4 bg-white rounded-t-[26px] border-t border-[#efe6fc]">
              {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
              {problemaEntrega && (itemsCarrito.length > 0 || itemsCarritoCombos.length > 0) && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl px-3 py-2 mb-2.5">{problemaEntrega}</p>
              )}
              <div className="flex items-center gap-3.5">
                <div className="flex flex-col min-w-[78px]">
                  <span className="text-[11.5px] text-[#78729a]">Total</span>
                  <span className="text-[21px] font-extrabold tracking-tight tabular-nums text-[#1c1830] leading-tight">{formatoMoneda(totalConEnvio)}</span>
                </div>
                {clienteSesion ? (
                  <button
                    onClick={confirmarPedido}
                    disabled={(itemsCarrito.length === 0 && itemsCarritoCombos.length === 0) || enviando || !!problemaEntrega}
                    className="flex-1 h-[54px] rounded-full bg-gradient-to-r from-[#8a3df2] to-[#4d04b0] text-white font-bold text-[15px] disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {enviando ? (requiereCita ? "Enviando reserva..." : "Enviando pedido...") : requiereCita ? (
                      <>
                        <i className="fa-regular fa-calendar-check text-lg"></i> Reservar cita
                      </>
                    ) : (
                      <>
                        <i className="fa-solid fa-bag-shopping text-lg"></i> Realizar pedido
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={iniciarConGoogle}
                    disabled={itemsCarrito.length === 0 && itemsCarritoCombos.length === 0}
                    className="flex-1 h-[54px] rounded-full bg-gradient-to-r from-[#8a3df2] to-[#4d04b0] text-white font-bold text-sm disabled:opacity-50 flex items-center justify-center gap-2 px-3"
                  >
                    <span className="bg-white rounded-full w-6 h-6 flex items-center justify-center shrink-0"><IconGoogle /></span>
                    Continuar con Google
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {(carritoAbierto || perfilAbierto) && ubicacionAbierta && (
        <div className="fixed inset-0 z-40 flex flex-col bg-gradient-to-br from-[#f4effc] via-[#f9f8fb] to-[#f5f4f8]">
          <div className="max-w-md w-full mx-auto flex flex-col h-full min-h-0">
            <div className="relative">
              <MapaEntrega punto={ubicacionEntrega} onCambiar={setUbicacionEntrega} alto="h-[46vh]" redondeo="rounded-none" />
              <button
                onClick={() => setUbicacionAbierta(false)}
                aria-label="Volver"
                className="absolute left-3.5 top-4 z-[600] w-10 h-10 rounded-full bg-white text-[#4d04b0] flex items-center justify-center shadow-md"
              >
                <i className="fa-solid fa-arrow-left text-sm"></i>
              </button>
              <button
                type="button"
                onClick={usarMiUbicacion}
                disabled={obteniendoGps}
                className="absolute right-3.5 bottom-9 z-[600] h-11 px-4 rounded-full bg-white text-[#4d04b0] text-[13px] font-bold flex items-center gap-2 shadow-md disabled:opacity-60"
              >
                <i className="fa-solid fa-location-crosshairs"></i>
                {obteniendoGps ? "Buscando..." : "Usar mi ubicación"}
              </button>
            </div>

            <div className="-mt-6 relative z-[600] flex-1 min-h-0 overflow-y-auto rounded-t-[28px] bg-gradient-to-br from-[#f4effc] to-[#f9f8fb] px-4 pt-4 pb-4 flex flex-col gap-3">
              <div>
                <p className="text-[11px] font-bold tracking-[0.07em] uppercase text-[#78729a]">Entregar en</p>
                <p className="text-[17px] font-bold text-[#1c1830] leading-snug">
                  {ubicacionEntrega ? "Ubicación marcada en el mapa" : "Marca dónde te lo llevamos"}
                </p>
                <p className="text-xs text-[#78729a] mt-0.5">Toca el mapa o arrastra el pin para ajustar el punto exacto.</p>
              </div>
              {errorGps && <p className="text-xs text-rose-600">{errorGps}</p>}

              <div className="bg-white rounded-[18px] px-3.5 py-2.5 ring-1 ring-[#e6dcf7]">
                <label className="block text-[10.5px] font-semibold text-[#78729a]">Referencia</label>
                <input
                  type="text"
                  value={referenciaEntrega}
                  onChange={(e) => setReferenciaEntrega(e.target.value)}
                  maxLength={200}
                  placeholder="Ej. Portón verde, 2.º piso, tocar timbre"
                  className="w-full text-sm text-stone-800 placeholder:text-[#a29cbd] focus:outline-none bg-transparent"
                />
              </div>
              <div className="bg-white rounded-[18px] px-3.5 py-2.5 ring-1 ring-[#e6dcf7]">
                <label className="block text-[10.5px] font-semibold text-[#78729a]">Teléfono de contacto</label>
                <input
                  type="tel"
                  inputMode="tel"
                  value={telefonoEntrega}
                  onChange={(e) => setTelefonoEntrega(e.target.value)}
                  maxLength={20}
                  placeholder="Ej. 987654321"
                  className="w-full text-sm text-stone-800 placeholder:text-[#a29cbd] focus:outline-none bg-transparent"
                />
              </div>
              {(bodega.zona_reparto || pedidoMinimo > 0) && (
                <p className="text-[11px] text-[#78729a] leading-snug">
                  {bodega.zona_reparto ? `Zona de reparto: ${bodega.zona_reparto}.` : ""}
                  {pedidoMinimo > 0 ? ` Pedido mínimo: ${formatoMoneda(pedidoMinimo)}.` : ""}
                </p>
              )}
              <div className="flex-1"></div>
              <button
                type="button"
                onClick={() => setUbicacionAbierta(false)}
                disabled={!ubicacionEntrega || referenciaEntrega.trim().length < 3 || telefonoEntregaLimpio.length < 7 || telefonoEntregaLimpio.length > 15}
                className="h-[54px] rounded-full bg-gradient-to-r from-[#8a3df2] to-[#4d04b0] text-white font-bold text-[15px] disabled:opacity-50"
              >
                Confirmar dirección
              </button>
            </div>
          </div>
        </div>
      )}

      {productoDetalleId && productosPorId[productoDetalleId] && (
        <HojaProducto
          key={productoDetalleId}
          producto={productosPorId[productoDetalleId]}
          cantidadEnCarrito={carrito[productoDetalleId] || 0}
          onAgregar={agregarAlCarrito}
          onCerrar={() => setProductoDetalleId(null)}
          onVerFoto={setFotoAmpliada}
          esFavorito={favoritos.has(productoDetalleId)}
          onToggleFavorito={toggleFavorito}
        />
      )}

      {fotoAmpliada && (
        <VisorFoto producto={fotoAmpliada} onCerrar={() => setFotoAmpliada(null)} />
      )}

      {modalTodosCombos && (
        <HojaInferior titulo="Todos los combos" onCerrar={() => setModalTodosCombos(false)} ancho="sm:max-w-md" alto="max-h-[85vh]">
            <div className="overflow-y-auto flex-1 px-4 pb-6 pt-1 flex flex-col gap-3">
              {combos.map((combo) => (
                <TarjetaComboMemo
                  key={combo.id}
                  combo={combo}
                  cantidadCombo={carritoCombos[combo.id] || 0}
                  productosPorId={productosPorId}
                  onAgregar={agregarComboAlCarrito}
                  onQuitar={quitarComboDelCarrito}
                  ancho="w-full"
                />
              ))}
            </div>
        </HojaInferior>
      )}

      {modalTodosDestacados && (
        <HojaInferior titulo="Todos los destacados" onCerrar={() => setModalTodosDestacados(false)} ancho="sm:max-w-lg" alto="max-h-[85vh]">
            <div className="overflow-y-auto flex-1 px-4 pb-6 pt-1 grid grid-cols-2 gap-3">
              {productosDestacados.map((p) => (
                <TarjetaProductoMemo
                  key={p.id}
                  producto={p}
                  cantidadEnCarrito={carrito[p.id] || 0}
                  onAgregar={agregarAlCarrito}
                  onQuitar={quitarDelCarrito}
                  onVerFoto={setFotoAmpliada}
                  onAbrir={abrirDetalleDesdeDestacados}
                  esFavorito={favoritos.has(p.id)}
                  onToggleFavorito={toggleFavorito}
                />
              ))}
            </div>
        </HojaInferior>
      )}

      {modalCuentaAbierto && (
        <ModalCuenta
          onCerrar={() => setModalCuentaAbierto(false)}
          onGoogle={iniciarConGoogle}
        />
      )}

      {completarPerfilGoogle && (
        <ModalCompletarPerfil
          inicial={completarPerfilGoogle}
          onListo={(cliente) => { setClienteSesion(cliente); setCompletarPerfilGoogle(null); }}
          onCancelar={async () => {
            await sbClient.auth.signOut();
            // Recarga limpia (no solo limpiar el estado local) para no
            // arrastrar nada de la sesión cancelada al próximo intento.
            window.location.href = window.location.origin + window.location.pathname;
          }}
        />
      )}

      {confirmarVaciarAbierto && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-6 bg-[#1c1830]/45 backdrop-blur-[3px]"
          onClick={() => setConfirmarVaciarAbierto(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="vaciar-titulo"
            onClick={(e) => e.stopPropagation()}
            className="kd-pop w-full max-w-sm bg-white rounded-[28px] px-[18px] pt-[22px] pb-[18px] flex flex-col items-center text-center gap-2 shadow-[0_24px_50px_-18px_rgba(28,24,48,0.5)]"
          >
            <span className="w-[52px] h-[52px] rounded-full bg-[#fff1f3] text-[#e11d48] flex items-center justify-center">
              <i className="fa-solid fa-trash-can text-xl"></i>
            </span>
            <h3 id="vaciar-titulo" className="text-[18px] font-extrabold text-[#1c1830]">¿Vaciar tu pedido?</h3>
            <div className="w-full flex items-center gap-2.5 bg-[#f4eefe] rounded-[18px] px-3 py-2.5 mt-1.5 mb-1 text-left">
              <div className="flex shrink-0">
                {[
                  ...itemsCarrito.map((it) => ({ clave: `p-${it.id}`, foto: it.foto_url })),
                  ...itemsCarritoCombos.map((it) => ({ clave: `c-${it.id}`, combo: true })),
                ]
                  .slice(0, 4)
                  .map((it, i) => (
                    <span
                      key={it.clave}
                      className={`w-[30px] h-[30px] rounded-full border-2 border-white bg-[#ece0fd] overflow-hidden flex items-center justify-center text-[#6105dc] ${i > 0 ? "-ml-[9px]" : ""}`}
                    >
                      {it.foto ? (
                        <img src={it.foto} alt="" className="w-full h-full object-contain mix-blend-multiply" />
                      ) : (
                        <i className={`fa-solid ${it.combo ? "fa-gift" : "fa-image"} text-[11px]`}></i>
                      )}
                    </span>
                  ))}
              </div>
              <div className="min-w-0">
                <p className="text-[12.5px] font-bold text-[#1c1830] leading-tight">
                  {itemsCarrito.length + itemsCarritoCombos.length === 1
                    ? "1 producto"
                    : `${itemsCarrito.length + itemsCarritoCombos.length} productos`}
                </p>
                <p className="text-[11.5px] text-[#78729a]">{formatoMoneda(totalCarrito)} en total</p>
              </div>
            </div>
            <div className="w-full flex gap-2">
              <button
                onClick={() => setConfirmarVaciarAbierto(false)}
                className="flex-1 h-[46px] rounded-full bg-[#f4eefe] text-[#4d04b0] text-sm font-bold active:scale-[0.98] transition-transform"
              >
                Mejor no
              </button>
              <button
                onClick={vaciarPedidoConfirmado}
                className="flex-1 h-[46px] rounded-full bg-[#e11d48] text-white text-sm font-bold active:scale-[0.98] transition-transform"
              >
                Sí, vaciar
              </button>
            </div>
          </div>
        </div>
      )}

      {instruccionesIOSAbiertas && (
        <HojaInferior titulo={`Instalar ${bodega.nombre}`} onCerrar={() => setInstruccionesIOSAbiertas(false)}>
          <div className="px-[18px] pb-6 pt-1 flex flex-col gap-3">
            <p className="text-[13px] text-[#78729a]">En iPhone la instalación se hace desde Safari, así:</p>
            <ol className="flex flex-col gap-2">
              {[
                <>Toca el botón <i className="fa-solid fa-arrow-up-from-bracket"></i> <strong>Compartir</strong> (abajo o arriba de la pantalla).</>,
                <>Elige <strong>"Agregar a inicio"</strong>.</>,
                <>Toca <strong>"Agregar"</strong> arriba a la derecha.</>,
              ].map((paso, i) => (
                <li key={i} className="flex items-start gap-3 bg-[#f4eefe] rounded-2xl px-3.5 py-3 text-[13px] text-[#1c1830] leading-snug">
                  <span className="w-6 h-6 rounded-full bg-[#6105dc] text-white text-xs font-extrabold flex items-center justify-center shrink-0">{i + 1}</span>
                  <span>{paso}</span>
                </li>
              ))}
            </ol>
            <p className="text-[11.5px] text-[#a29cbd]">Solo funciona desde Safari, no desde Chrome ni otras apps del navegador.</p>
          </div>
        </HojaInferior>
      )}
    </div>
  );
}

// Si algo falla al dibujar la app, se muestra un aviso con el detalle y un botón
// para recargar, en vez de dejar la pantalla en blanco.
class ErrorDeArranque extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center bg-[#f9f8fb]">
        <p className="text-lg font-extrabold text-[#1c1830]">Algo salió mal al abrir Kaserita Delivery</p>
        <p className="text-sm text-[#78729a] max-w-xs">Vuelve a cargar la página. Si sigue igual, avísanos con este detalle.</p>
        <button onClick={() => window.location.reload()} className="bg-[#6105dc] text-white font-bold text-sm px-7 py-3 rounded-full">
          Recargar
        </button>
        <p className="text-[10.5px] text-[#a29cbd] max-w-xs break-words">{String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error).slice(0, 300)}</p>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(<ErrorDeArranque><App /></ErrorDeArranque>);
