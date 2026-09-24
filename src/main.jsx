import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';


const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://hzmrsbeamtbloudmxjrp.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_RHAkd7pZIadDnSQClFdjMQ_lrG3p-gw";
const sbClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Aviso sonoro para el cliente cuando su pedido pasa a "listo" -- mismo
// archivo que usa el dueño en la POS del lado de la bodega. Se crea una
// sola vez (no un Audio nuevo por evento) para no repetir la descarga.
// Solo suena si el cliente tiene la pestaña abierta; para cuando la tiene
// cerrada ya existe el push (ver activarNotificaciones/enviar-notificacion-pedido-listo).
const audioAvisoPedidoListo = new Audio("https://cdn.pixabay.com/audio/2025/01/11/audio_5e34842448.mp3");
audioAvisoPedidoListo.preload = "auto";
function sonarAvisoPedidoListo() {
  try {
    audioAvisoPedidoListo.currentTime = 0;
    audioAvisoPedidoListo.play().catch((err) => console.warn("No se pudo reproducir el aviso sonoro:", err.message));
  } catch (err) {
    console.warn("No se pudo reproducir el aviso sonoro:", err.message);
  }
}

function formatoMoneda(n) {
  return `S/ ${Number(n || 0).toFixed(2)}`;
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

// Ícono + color aproximados por nombre de categoría (texto libre que carga
// cada bodega) -- no hay un catálogo fijo de categorías, así que se matchea
// por palabras clave comunes en bodegas/abarrotes y se cae a un estilo
// genérico. El color es solo para diferenciar de un vistazo (como en apps
// de delivery), no tiene relación con la marca.
function estiloCategoria(nombre) {
  const n = (nombre || "").toLowerCase();
  if (/agua|hidrata/.test(n)) return { icono: "fa-droplet", bg: "bg-sky-50", texto: "text-sky-600", borde: "border-sky-200", bordeActivo: "border-sky-500 ring-2 ring-sky-200" };
  if (/gaseosa|bebida|jugo|néctar|nectar/.test(n)) return { icono: "fa-bottle-water", bg: "bg-rose-50", texto: "text-rose-600", borde: "border-rose-200", bordeActivo: "border-rose-500 ring-2 ring-rose-200" };
  if (/cerveza|licor|vino/.test(n)) return { icono: "fa-beer-mug-empty", bg: "bg-amber-50", texto: "text-amber-600", borde: "border-amber-200", bordeActivo: "border-amber-500 ring-2 ring-amber-200" };
  if (/carne|embutido|pollo|res/.test(n)) return { icono: "fa-drumstick-bite", bg: "bg-red-50", texto: "text-red-600", borde: "border-red-200", bordeActivo: "border-red-500 ring-2 ring-red-200" };
  if (/lácte|lacte|leche|queso|yogur/.test(n)) return { icono: "fa-cheese", bg: "bg-yellow-50", texto: "text-yellow-600", borde: "border-yellow-200", bordeActivo: "border-yellow-500 ring-2 ring-yellow-200" };
  if (/pan|panader/.test(n)) return { icono: "fa-bread-slice", bg: "bg-orange-50", texto: "text-orange-600", borde: "border-orange-200", bordeActivo: "border-orange-500 ring-2 ring-orange-200" };
  if (/limpieza|hogar/.test(n)) return { icono: "fa-spray-can-sparkles", bg: "bg-emerald-50", texto: "text-emerald-600", borde: "border-emerald-200", bordeActivo: "border-emerald-500 ring-2 ring-emerald-200" };
  if (/golosina|snack|dulce|chocolate/.test(n)) return { icono: "fa-cookie-bite", bg: "bg-fuchsia-50", texto: "text-fuchsia-600", borde: "border-fuchsia-200", bordeActivo: "border-fuchsia-500 ring-2 ring-fuchsia-200" };
  if (/fruta|verdura|abarrote/.test(n)) return { icono: "fa-basket-shopping", bg: "bg-lime-50", texto: "text-lime-700", borde: "border-lime-200", bordeActivo: "border-lime-500 ring-2 ring-lime-200" };
  if (/cigarr|tabaco/.test(n)) return { icono: "fa-smoking", bg: "bg-stone-100", texto: "text-stone-600", borde: "border-stone-200", bordeActivo: "border-stone-400 ring-2 ring-stone-200" };
  if (/mascota/.test(n)) return { icono: "fa-paw", bg: "bg-indigo-50", texto: "text-indigo-600", borde: "border-indigo-200", bordeActivo: "border-indigo-500 ring-2 ring-indigo-200" };
  if (/higiene|cuidado|personal|farmac/.test(n)) return { icono: "fa-pump-soap", bg: "bg-teal-50", texto: "text-teal-600", borde: "border-teal-200", bordeActivo: "border-teal-500 ring-2 ring-teal-200" };
  return { icono: "fa-tag", bg: "bg-stone-100", texto: "text-stone-600", borde: "border-stone-200", bordeActivo: "border-stone-400 ring-2 ring-stone-200" };
}

// Gradiente de la tarjeta hero de "Destacados" -- mismo criterio que
// estiloCategoria (por palabras clave), para que un destacado tenga el
// color de su categoría real en vez de un violeta genérico siempre. Sin
// categoría o sin match, cae al violeta/azul de siempre.
function gradienteDestacado(nombre) {
  const n = (nombre || "").toLowerCase();
  if (/agua|hidrata/.test(n)) return "from-sky-500 to-cyan-600";
  if (/gaseosa|bebida|jugo|néctar|nectar/.test(n)) return "from-rose-500 to-pink-600";
  if (/cerveza|licor|vino/.test(n)) return "from-amber-500 to-orange-600";
  if (/carne|embutido|pollo|res/.test(n)) return "from-red-500 to-rose-700";
  if (/lácte|lacte|leche|queso|yogur/.test(n)) return "from-yellow-500 to-amber-600";
  if (/pan|panader/.test(n)) return "from-orange-400 to-red-500";
  if (/limpieza|hogar/.test(n)) return "from-emerald-500 to-teal-600";
  if (/golosina|snack|dulce|chocolate/.test(n)) return "from-fuchsia-500 to-purple-600";
  if (/fruta|verdura|abarrote/.test(n)) return "from-lime-500 to-green-600";
  if (/cigarr|tabaco/.test(n)) return "from-stone-500 to-stone-700";
  if (/mascota/.test(n)) return "from-indigo-500 to-violet-600";
  if (/higiene|cuidado|personal|farmac/.test(n)) return "from-teal-500 to-cyan-600";
  return "from-blue-600 to-violet-700";
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
const VAPID_PUBLIC_KEY = "BFgQP6eqYcP1d8NhXTmDwqebPRpSZD3Be-RSqwIelHbCEEcSMR5WuVgvMStvSCySWhKvR7-a_f4OOcB3VQfhKsU";

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
async function activarNotificaciones(clienteId) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Este navegador no soporta notificaciones push.");
  }
  const registro = await navigator.serviceWorker.register("/sw.js");
  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") throw new Error("No diste permiso para las notificaciones.");
  let suscripcion = await registro.pushManager.getSubscription();
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

function generarCodigoCorto() {
  // Sin caracteres ambiguos (0/O, 1/I) para que sea fácil de leer y transcribir.
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let codigo = "";
  for (let i = 0; i < 6; i++) {
    codigo += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  }
  return codigo;
}

function armarMensajeWhatsapp({ bodegaNombre, items, total, codigo }) {
  const lineas = items.map(
    (it) => `• ${it.cantidad} x ${it.descripcion} — ${formatoMoneda(it.precio_venta * it.cantidad)}`
  );
  return [
    `Hola ${bodegaNombre}! Quiero hacer este pedido:`,
    "",
    ...lineas,
    "",
    `Total: ${formatoMoneda(total)}`,
    `Código de referencia: ${codigo}`,
    "",
    "(mostrá este código en caja para cargar el pedido)",
  ].join("\n");
}

function TarjetaProducto({ producto, cantidadEnCarrito, onAgregar, onQuitar, onVerFoto, esFavorito, onToggleFavorito }) {
  const stockPoco = producto.stock_disponible != null && producto.stock_disponible <= 3;
  return (
    <div className="bg-white rounded-[26px] border border-stone-100 shadow-sm p-2 flex flex-col">
      <div
        onClick={producto.foto_url ? () => onVerFoto(producto) : undefined}
        className={`relative aspect-[4/5] rounded-[18px] bg-stone-100 flex items-center justify-center overflow-hidden ${producto.foto_url ? "cursor-zoom-in" : ""}`}
      >
        {stockPoco && (
          <span className="absolute top-1.5 left-1.5 z-10 bg-amber-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide">
            Pocas unidades
          </span>
        )}
        {onToggleFavorito && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorito(producto.id); }}
            aria-label={esFavorito ? "Quitar de favoritos" : "Agregar a favoritos"}
            className="absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-full bg-white/90 backdrop-blur flex items-center justify-center shadow-sm active:scale-90 transition"
          >
            <i className={`${esFavorito ? "fa-solid text-rose-500" : "fa-regular text-stone-400"} fa-heart text-sm`}></i>
          </button>
        )}
        {producto.foto_url ? (
          <img src={producto.foto_url} alt={tituloProducto(producto.descripcion)} className="w-full h-full object-cover" />
        ) : (
          <i className="fa-solid fa-image text-stone-300 text-3xl"></i>
        )}
      </div>
      <div className="px-1.5 pt-3 pb-1 flex flex-col gap-1 flex-1">
        <p className="text-[15px] font-bold text-stone-800 leading-tight line-clamp-2">{tituloProducto(producto.descripcion)}</p>
        {producto.categoria && <p className="text-xs text-stone-400 line-clamp-1">{producto.categoria}</p>}

        <div className="mt-auto pt-2.5 border-t border-stone-100 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-1.5">
            <span className="text-sm font-bold text-violet-700">{formatoMoneda(producto.precio_venta)}</span>
            {producto.stock_disponible != null && !stockPoco && (
              <span className="flex items-center gap-1 text-[11px] font-semibold shrink-0 text-stone-400">
                <i className="fa-solid fa-box text-[10px]"></i>
                {producto.stock_disponible}
              </span>
            )}
          </div>

          {cantidadEnCarrito > 0 ? (
            <div className="flex items-center justify-between gap-1.5 bg-stone-50 rounded-full p-1">
              <button
                onClick={() => onQuitar(producto)}
                className="w-7 h-7 rounded-full bg-white shadow-sm text-stone-600 flex items-center justify-center active:scale-95"
              >
                <i className="fa-solid fa-minus text-[10px]"></i>
              </button>
              <span className="text-sm font-semibold">{cantidadEnCarrito}</span>
              <button
                onClick={() => onAgregar(producto)}
                className="w-7 h-7 rounded-full bg-violet-600 text-white flex items-center justify-center active:scale-95"
              >
                <i className="fa-solid fa-plus text-[10px]"></i>
              </button>
            </div>
          ) : (
            <button
              onClick={() => onAgregar(producto)}
              className="w-full py-1.5 rounded-full bg-violet-600 text-white text-xs font-semibold flex items-center justify-center gap-1 active:scale-95"
            >
              Agregar <i className="fa-solid fa-plus text-[10px]"></i>
            </button>
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

  return (
    <div className={`${ancho || "w-60"} shrink-0 bg-amber-50/50 rounded-2xl border border-amber-200 shadow-sm p-3.5 flex flex-col gap-2`}>
      <div className="flex items-center justify-between gap-2 min-h-[18px]">
        {porcentajeOff > 0 ? (
          <span className="bg-rose-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">-{porcentajeOff}% OFF</span>
        ) : <span></span>}
        {stockLimitado && <span className="text-[10px] font-semibold text-stone-500">Stock limitado</span>}
      </div>
      <p className="text-sm font-bold text-stone-900 leading-snug line-clamp-1">{combo.nombre}</p>
      <p className="text-[11px] text-stone-500 line-clamp-2 flex-1">
        {(combo.items || []).map((it) => `${tituloProducto(it.descripcion)} (x${it.cantidad})`).join(", ")}
      </p>
      <div className="flex items-end justify-between gap-2 pt-2 border-t border-amber-200/70">
        <div className="flex flex-col leading-tight gap-0.5">
          {porcentajeOff > 0 && <span className="text-[11px] text-stone-400 line-through">{formatoMoneda(precioOriginal)}</span>}
          <span className="text-base font-black text-stone-900">{formatoMoneda(combo.precio_venta)}</span>
          {ahorro > 0 && (
            <span className="w-fit text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-full">
              Ahorras {formatoMoneda(ahorro)}
            </span>
          )}
        </div>
        {cantidadCombo === 0 ? (
          <button
            onClick={() => onAgregar(combo)}
            className="shrink-0 bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold px-3 py-1.5 rounded-full active:scale-95"
          >
            Agregar +
          </button>
        ) : (
          <div className="shrink-0 flex items-center gap-2 bg-stone-900 rounded-full px-1 py-1">
            <button onClick={() => onQuitar(combo)} className="w-6 h-6 flex items-center justify-center text-white active:scale-90">
              <i className="fa-solid fa-minus text-[10px]"></i>
            </button>
            <span className="text-xs font-bold text-white w-4 text-center">{cantidadCombo}</span>
            <button onClick={() => onAgregar(combo)} className="w-6 h-6 flex items-center justify-center text-white active:scale-90">
              <i className="fa-solid fa-plus text-[10px]"></i>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

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
            className="max-w-full max-h-[65vh] rounded-xl object-contain shadow-2xl"
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
        <p className="text-white text-sm font-semibold text-center">{tituloProducto(producto.descripcion)}</p>
        {producto.descripcion_larga && (
          <p className="text-white/70 text-xs text-center max-w-sm whitespace-pre-line">{producto.descripcion_larga}</p>
        )}
      </div>
    </div>
  );
}

function PantallaConfirmacion({ bodega, codigo, whatsappUrl, onVolver }) {
  const [copiado, setCopiado] = useState(false);
  const copiarCodigo = async () => {
    try {
      await navigator.clipboard.writeText(codigo);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch (e) {}
  };
  return (
    <div className="max-w-md mx-auto px-4 py-10 flex flex-col items-center text-center gap-4">
      <div className="w-16 h-16 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center text-2xl">
        <i className="fa-solid fa-check"></i>
      </div>
      <h1 className="text-lg font-bold text-stone-800">¡Tu pedido está listo!</h1>
      <p className="text-sm text-stone-500">
        Mandá el mensaje por WhatsApp a <strong>{bodega.nombre}</strong>. Mostrá este código
        en caja para que carguen tu pedido al instante.
      </p>
      <button
        onClick={copiarCodigo}
        className="text-3xl font-mono font-bold tracking-widest bg-stone-100 rounded-xl px-6 py-3 text-stone-800"
      >
        {codigo}
      </button>
      <p className="text-xs text-stone-400 -mt-2">{copiado ? "¡Copiado!" : "Tocá el código para copiarlo"}</p>
      <a
        href={whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="w-full py-3 rounded-xl bg-violet-600 text-white font-semibold flex items-center justify-center gap-2"
      >
        <i className="fa-brands fa-whatsapp text-lg"></i> Enviar por WhatsApp
      </a>
      <button onClick={onVolver} className="text-sm text-stone-500 underline mt-2">
        Volver al catálogo
      </button>
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center sm:justify-center z-30" onClick={onCerrar}>
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-stone-800">Ingresar</h2>
          <button onClick={onCerrar} className="text-stone-400">
            <i className="fa-solid fa-xmark text-lg"></i>
          </button>
        </div>
        <p className="text-xs text-stone-500">
          Con tu cuenta podés ver el estado de tus pedidos, guardar tus favoritos y recibir un aviso cuando tu pedido
          esté listo.
        </p>
        <button
          type="button"
          onClick={onGoogle}
          className="w-full py-2.5 rounded-xl border border-stone-200 text-stone-700 font-semibold text-sm flex items-center justify-center gap-2"
        >
          <IconGoogle /> Continuar con Google
        </button>
        <p className="text-[11px] text-stone-400 text-center">
          Entrás con tu cuenta de Google: no hace falta crear ni recordar ningún PIN.
        </p>
      </div>
    </div>
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
    if (tel.length < 6) return setError("Ingresá un celular válido.");
    if (!nombre.trim()) return setError("Ingresá tu nombre.");
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
      setError(err.message || "Algo salió mal, intentá de nuevo.");
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center sm:justify-center z-30">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-3">
        <h2 className="font-bold text-stone-800">Ya casi -- un dato más</h2>
        <p className="text-xs text-stone-500">Necesitamos tu WhatsApp para poder avisarte de tus pedidos.</p>
        <form onSubmit={guardar} className="space-y-2.5">
          <input
            type="text"
            placeholder="Tu nombre"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-sm text-stone-900"
          />
          <input
            type="tel"
            placeholder="Tu celular (WhatsApp)"
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-sm text-stone-900"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={cargando}
            className="w-full py-2.5 rounded-xl bg-violet-600 text-white font-semibold disabled:opacity-50"
          >
            {cargando ? "Un momento..." : "Continuar"}
          </button>
        </form>
        <button onClick={onCancelar} className="w-full text-center text-xs text-stone-400 underline">
          Cancelar y salir
        </button>
      </div>
    </div>
  );
}

const ETIQUETAS_ESTADO_PEDIDO = {
  pendiente: { texto: "En preparación", color: "bg-amber-100 text-amber-700" },
  listo: { texto: "¡Listo para retirar!", color: "bg-violet-100 text-violet-700" },
  retirado: { texto: "Retirado", color: "bg-stone-100 text-stone-500" },
  cancelado: { texto: "Cancelado", color: "bg-rose-100 text-rose-600" },
};

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

function StepperPedido({ estado }) {
  if (estado === "cancelado") {
    return (
      <div className="flex items-center gap-2 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
        <i className="fa-solid fa-circle-xmark text-rose-500 text-xs"></i>
        <span className="text-xs font-semibold text-rose-600">Este pedido fue cancelado</span>
      </div>
    );
  }
  const actual = PASO_ACTUAL_POR_ESTADO[estado] ?? 0;
  return (
    <div className="flex items-start">
      {PASOS_PEDIDO.map((paso, i) => {
        const completado = i <= actual;
        const esActual = i === actual && estado !== "retirado";
        return (
          <React.Fragment key={paso.texto}>
            <div className="flex flex-col items-center gap-1 w-14 shrink-0">
              <div
                className={`relative w-7 h-7 rounded-full flex items-center justify-center text-[11px] ${
                  completado ? "bg-violet-600 text-white" : "bg-stone-100 text-stone-300"
                }`}
              >
                <i className={`fa-solid ${paso.icono}`}></i>
                {esActual && <span className="absolute inset-0 rounded-full bg-violet-600 animate-ping opacity-40"></span>}
              </div>
              <span className={`text-[9px] font-semibold text-center leading-tight ${completado ? "text-violet-700" : "text-stone-400"}`}>
                {paso.texto}
              </span>
            </div>
            {i < PASOS_PEDIDO.length - 1 && (
              <div className={`flex-1 h-0.5 mt-3.5 ${i < actual ? "bg-violet-600" : "bg-stone-200"}`}></div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function PantallaMisPedidos({ cliente, onVolver, bodegaActualId, onRepetirPedido }) {
  const [pedidos, setPedidos] = useState([]);
  const [nombresBodegas, setNombresBodegas] = useState({});
  const [cargando, setCargando] = useState(true);
  const [activandoPush, setActivandoPush] = useState(false);
  const [avisoPush, setAvisoPush] = useState("");

  const cargar = useCallback(() => {
    setCargando(true);
    sbClient
      .from("pedidos_seguimiento")
      .select("*")
      .order("creado_en", { ascending: false })
      .then(async ({ data }) => {
        const filas = data || [];
        setPedidos(filas);
        setCargando(false);
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
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const activarPush = async () => {
    setAvisoPush("");
    setActivandoPush(true);
    try {
      await activarNotificaciones(cliente.id);
      setAvisoPush("¡Listo! Te vamos a avisar acá cuando tu pedido esté listo.");
    } catch (err) {
      setAvisoPush(err.message || "No se pudo activar.");
    } finally {
      setActivandoPush(false);
    }
  };

  const cancelar = async (id) => {
    const { error } = await sbClient.rpc("cancelar_seguimiento_pedido", { p_id: id });
    if (!error) cargar();
  };

  return (
    <div className="max-w-md mx-auto px-4 py-6 space-y-4 pb-16">
      <div className="flex items-center gap-3">
        <button onClick={onVolver} className="text-stone-500">
          <i className="fa-solid fa-arrow-left"></i>
        </button>
        <h1 className="text-lg font-bold text-stone-800">Mis pedidos</h1>
      </div>

      <div className="bg-stone-50 border border-stone-200 rounded-xl p-3 flex items-center justify-between gap-3">
        <p className="text-xs text-stone-500">Activá las notificaciones para enterarte apenas tu pedido esté listo.</p>
        <button
          onClick={activarPush}
          disabled={activandoPush}
          className="shrink-0 px-3 py-1.5 rounded-lg bg-stone-900 text-white text-xs font-semibold disabled:opacity-50"
        >
          {activandoPush ? "..." : "Activar"}
        </button>
      </div>
      {avisoPush && <p className="text-xs text-stone-500">{avisoPush}</p>}

      {cargando ? (
        <p className="text-center text-stone-400 py-10">Cargando...</p>
      ) : pedidos.length === 0 ? (
        <p className="text-center text-stone-400 py-10">Todavía no hiciste ningún pedido con tu cuenta.</p>
      ) : (
        <div className="space-y-3">
          {pedidos.map((p) => (
            <div key={p.id} className="bg-white border border-stone-200 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-sm text-stone-800">{p.codigo_corto}</span>
                  {nombresBodegas[p.bodega_id] && (
                    <span className="text-[11px] text-stone-400">{nombresBodegas[p.bodega_id]}</span>
                  )}
                </div>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${ETIQUETAS_ESTADO_PEDIDO[p.estado].color}`}>
                  {ETIQUETAS_ESTADO_PEDIDO[p.estado].texto}
                </span>
              </div>
              <div className="py-1">
                <StepperPedido estado={p.estado} />
              </div>
              <div className="text-xs text-stone-500 space-y-0.5">
                {(p.items || []).map((it, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span>{it.cantidad} x {it.combo_id ? it.descripcion : tituloProducto(it.descripcion)}</span>
                    <span className="shrink-0">{formatoMoneda(it.precio_venta * it.cantidad)}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-stone-100">
                <span className="text-xs font-semibold text-stone-500">Total</span>
                <span className="text-sm font-bold text-stone-800">
                  {formatoMoneda((p.items || []).reduce((acc, it) => acc + it.precio_venta * it.cantidad, 0))}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 pt-0.5">
                {(p.estado === "pendiente" || p.estado === "listo") ? (
                  <button onClick={() => cancelar(p.id)} className="text-xs text-rose-600 underline">
                    Cancelar pedido
                  </button>
                ) : <span></span>}
                {p.bodega_id === bodegaActualId && (
                  <button
                    onClick={() => onRepetirPedido(p)}
                    className="text-xs font-semibold text-violet-700 bg-violet-50 hover:bg-violet-100 rounded-full px-3 py-1.5 flex items-center gap-1.5"
                  >
                    <i className="fa-solid fa-rotate-right text-[10px]"></i> Pedir de nuevo
                  </button>
                )}
              </div>
            </div>
          ))}
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

function PantallaMisTiendas({ onVolver, esInicio = false }) {
  const [tiendas, setTiendas] = useState([]);
  const [ultimoPedidoPorBodega, setUltimoPedidoPorBodega] = useState({});
  const [ultimaVisitaPorBodega, setUltimaVisitaPorBodega] = useState({});
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
      setErrorCamara("No se pudo acceder a la cámara. Revisá los permisos, o pegá el link directamente.");
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
      .select("bodega_id, visto_en")
      .order("visto_en", { ascending: false })
      .then(async ({ data: visitas }) => {
        const filas = visitas || [];
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
          sbClient.from("pedidos_seguimiento").select("bodega_id, creado_en").order("creado_en", { ascending: false }),
        ]);
        const ultimos = {};
        (pedidos || []).forEach((p) => { if (!ultimos[p.bodega_id]) ultimos[p.bodega_id] = p.creado_en; });
        setUltimoPedidoPorBodega(ultimos);
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

  return (
    <div className="max-w-md mx-auto px-4 py-6 space-y-4 pb-16">
      <div className="flex items-center gap-3">
        {!esInicio && (
          <button onClick={onVolver} className="text-stone-500">
            <i className="fa-solid fa-arrow-left"></i>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-stone-800">{esInicio ? "Tus bodegas" : "Mis tiendas"}</h1>
            {tiendas.length > 0 && (
              <span className="bg-violet-100 text-violet-700 text-[11px] font-bold px-2 py-0.5 rounded-full">
                {tiendas.length} guardada{tiendas.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-xs text-stone-400">Las bodegas donde ya compraste, para volver sin buscar el link</p>
        </div>
      </div>

      {tiendas.length > 1 && (
        <div className="relative">
          <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm"></i>
          <input
            type="text"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar entre mis bodegas..."
            className="w-full bg-stone-100 border border-stone-200 rounded-xl pl-9 pr-3 py-2.5 text-sm text-stone-800 placeholder-stone-400 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
          />
        </div>
      )}

      {cargando ? (
        <p className="text-center text-stone-400 py-10">Cargando...</p>
      ) : tiendas.length === 0 ? (
        <div className="text-center text-stone-400 py-10 space-y-2">
          <i className="fa-solid fa-store text-2xl block"></i>
          <p>Todavía no compraste en ninguna bodega.</p>
          <p className="text-xs">En cuanto hagas tu primer pedido, va a aparecer acá.</p>
        </div>
      ) : tiendasFiltradas.length === 0 ? (
        <p className="text-center text-stone-400 py-10">No encontramos ninguna bodega con ese nombre.</p>
      ) : (
        <div className="space-y-3">
          {tiendasFiltradas.map((t, i) => {
            const habitual = i === 0 && !busqueda;
            const estado = estadoAtencionBodega(t.horario_atencion);
            return (
              <div
                key={t.bodega_id}
                className={`bg-white rounded-3xl overflow-hidden shadow-sm ${habitual ? "border-2 border-violet-300" : "border border-stone-200"}`}
              >
                <div className="h-16 bg-gradient-to-r from-violet-500 to-blue-600 relative px-3 pt-3 flex items-start justify-between">
                  {habitual ? (
                    <span className="bg-white/20 backdrop-blur text-white text-[10px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1">
                      <i className="fa-solid fa-star text-amber-300 text-[9px]"></i> Habitual
                    </span>
                  ) : <span></span>}
                  <button
                    type="button"
                    onClick={async () => {
                      const url = `${window.location.origin}/${t.slug}`;
                      if (navigator.share) {
                        try { await navigator.share({ title: t.nombre, url }); } catch {}
                      } else {
                        try { await navigator.clipboard.writeText(url); } catch {}
                      }
                    }}
                    title="Compartir"
                    className="w-8 h-8 rounded-full bg-white/20 backdrop-blur flex items-center justify-center text-white active:scale-90 transition"
                  >
                    <i className="fa-solid fa-share-nodes text-xs"></i>
                  </button>
                </div>
                <div className="px-4 pb-4 -mt-8 flex flex-col items-center text-center">
                  <div className="w-16 h-16 rounded-full bg-white p-1 shadow-md shrink-0">
                    <div className="w-full h-full rounded-full bg-stone-100 overflow-hidden">
                      {t.logo_url ? (
                        <img src={t.logo_url} alt={t.nombre} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-violet-600 text-white font-black text-lg">
                          {t.nombre?.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="mt-2 font-bold text-stone-900 leading-tight">{t.nombre}</p>
                  {t.direccion && (
                    <p className="text-xs text-stone-400 flex items-center justify-center gap-1 mt-1">
                      <i className="fa-solid fa-location-dot text-[10px] shrink-0"></i>
                      <span className="line-clamp-1">{t.direccion}</span>
                    </p>
                  )}
                  <div className="mt-2.5 inline-flex items-center gap-1.5 bg-stone-50 border border-stone-100 rounded-full px-3 py-1 text-[11px] max-w-full">
                    {estado && (
                      <>
                        <span className="relative flex h-2 w-2 shrink-0">
                          {estado.abierto && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>}
                          <span className={`relative inline-flex rounded-full h-2 w-2 ${estado.abierto ? "bg-emerald-500" : "bg-stone-300"}`}></span>
                        </span>
                        <span className={`font-semibold shrink-0 ${estado.abierto ? "text-emerald-700" : "text-stone-500"}`}>
                          {estado.abierto ? "Abierto" : "Cerrado"}
                        </span>
                        <span className="text-stone-300 shrink-0">•</span>
                      </>
                    )}
                    <span className="text-stone-500 truncate">
                      {ultimoPedidoPorBodega[t.bodega_id] ? (
                        <>Último pedido: <strong className="text-stone-700 font-semibold">{fechaRelativa(ultimoPedidoPorBodega[t.bodega_id])}</strong></>
                      ) : ultimaVisitaPorBodega[t.bodega_id] ? (
                        <>Visto: <strong className="text-stone-700 font-semibold">{fechaRelativa(ultimaVisitaPorBodega[t.bodega_id])}</strong></>
                      ) : (
                        "Sin pedidos todavía"
                      )}
                    </span>
                  </div>
                  <a
                    href={`/${t.slug}`}
                    className="mt-3 w-full h-10 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition"
                  >
                    Ver catálogo <i className="fa-solid fa-arrow-right text-[10px]"></i>
                  </a>
                </div>
              </div>
            );
          })}

          <div className="p-4 rounded-2xl border-2 border-dashed border-stone-200 bg-white text-center">
            <div className="w-10 h-10 rounded-full bg-violet-50 text-violet-600 mx-auto flex items-center justify-center mb-2">
              <i className="fa-solid fa-plus"></i>
            </div>
            <p className="text-sm font-semibold text-stone-800">¿Compraste en otra bodega?</p>
            <p className="text-xs text-stone-500 mt-0.5 mb-3">Escaneá su QR o pegá el link para tenerla a mano.</p>
            <div className="flex items-center justify-center gap-2 flex-wrap">
              {soportaEscaneo && (
                <button
                  type="button"
                  onClick={iniciarEscaneo}
                  className="text-xs font-semibold text-violet-600 bg-violet-50 hover:bg-violet-100 px-3.5 py-1.5 rounded-lg flex items-center gap-1.5"
                >
                  <i className="fa-solid fa-qrcode text-[11px]"></i> Escanear QR
                </button>
              )}
              <button
                type="button"
                onClick={() => { setLinkPegado(""); setModalPegarLink(true); }}
                className="text-xs font-semibold text-stone-600 bg-stone-100 hover:bg-stone-200 px-3.5 py-1.5 rounded-lg flex items-center gap-1.5"
              >
                <i className="fa-solid fa-link text-[11px]"></i> Pegar link
              </button>
            </div>
            {errorCamara && <p className="text-[11px] text-rose-600 mt-2">{errorCamara}</p>}
          </div>
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
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center sm:justify-center z-50" onClick={() => setModalPegarLink(false)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-stone-800">Pegar link de la bodega</h2>
              <button onClick={() => setModalPegarLink(false)} className="text-stone-400">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>
            <input
              type="text"
              value={linkPegado}
              onChange={(e) => setLinkPegado(e.target.value)}
              placeholder="https://kaserita-delivery.vercel.app/bodega-demo"
              className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-sm text-stone-900"
              autoFocus
            />
            <button
              onClick={() => irAlSlugDesdeTexto(linkPegado)}
              disabled={!linkPegado.trim()}
              className="w-full py-2.5 rounded-xl bg-violet-600 text-white font-semibold disabled:opacity-50"
            >
              Ir a la tienda
            </button>
          </div>
        </div>
      )}
    </div>
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
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [pedidoConfirmado, setPedidoConfirmado] = useState(null); // { codigo, whatsappUrl }
  const [busqueda, setBusqueda] = useState("");
  const [categoriaActiva, setCategoriaActiva] = useState("");
  const [fotoAmpliada, setFotoAmpliada] = useState(null); // producto
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
    if (!el || el.clientWidth === 0) return;
    setComboActivo(Math.round(el.scrollLeft / el.clientWidth));
  };
  const manejarScrollDestacados = () => {
    const el = destacadoScrollRef.current;
    if (!el || el.clientWidth === 0) return;
    setDestacadoActivo(Math.round(el.scrollLeft / el.clientWidth));
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
          if (payload.new.estado === "listo" && payload.old?.estado !== "listo") {
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
      setEstadoBodega("ok");
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
      .then(() => {});
  }, [estadoBodega, bodega, clienteSesion]);

  useEffect(() => {
    if (estadoBodega !== "ok" || !bodega) return;
    setCargandoProductos(true);
    sbClient
      .rpc("obtener_productos_delivery", { p_slug: slug })
      .then(({ data, error: err }) => {
        if (!err) {
          const ordenados = (data || []).slice().sort((a, b) =>
            a.descripcion.localeCompare(b.descripcion)
          );
          setProductos(ordenados);
        }
        setCargandoProductos(false);
      });
    sbClient
      .rpc("obtener_combos_delivery", { p_slug: slug })
      .then(({ data, error: err }) => {
        if (!err) setCombos(data || []);
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
    () =>
      itemsCarrito.reduce((acc, it) => acc + it.precio_venta * it.cantidad, 0) +
      itemsCarritoCombos.reduce((acc, it) => acc + it.precio_venta * it.cantidad, 0),
    [itemsCarrito, itemsCarritoCombos]
  );
  const totalUnidades = useMemo(
    () =>
      itemsCarrito.reduce((acc, it) => acc + it.cantidad, 0) +
      itemsCarritoCombos.reduce((acc, it) => acc + it.cantidad, 0),
    [itemsCarrito, itemsCarritoCombos]
  );

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

  const confirmarPedido = async () => {
    if (itemsCarrito.length === 0 && itemsCarritoCombos.length === 0) return;
    setEnviando(true);
    setError("");
    const codigo = generarCodigoCorto();
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
      })),
    ];
    const { error: err } = await sbClient.from("pedidos_delivery").insert({
      codigo_corto: codigo,
      bodega_id: bodega.bodega_id,
      items,
      cliente_id: clienteSesion?.id || null,
    });
    setEnviando(false);
    if (err) {
      const msg = err.message || "";
      setError(
        msg.includes("Demasiados pedidos")
          ? "Hiciste varios pedidos seguidos. Esperá unos minutos e intentá de nuevo."
          : msg.includes("suficiente stock")
          ? `${msg} Bajá la cantidad e intentá de nuevo.`
          : "No se pudo generar el pedido. Intentá de nuevo en un momento."
      );
      return;
    }
    const mensaje = armarMensajeWhatsapp({
      bodegaNombre: bodega.nombre,
      items,
      total: totalCarrito,
      codigo,
    });
    const telefono = (bodega.telefono || "").replace(/\D/g, "");
    const whatsappUrl = `https://wa.me/${telefono}?text=${encodeURIComponent(mensaje)}`;
    setPedidoConfirmado({ codigo, whatsappUrl });
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
              <span className="font-bold text-violet-700">Kaserita</span>
              <button onClick={salir} className="text-xs text-stone-400 underline">
                Cerrar sesión
              </button>
            </div>
          </div>
        ) : null}
        {clienteSesion ? (
          <PantallaMisTiendas esInicio />
        ) : (
          <div className="max-w-md mx-auto px-4 py-16 text-center text-stone-500 space-y-5">
            <div>
              <i className="fa-solid fa-store text-3xl text-stone-300 mb-3"></i>
              <p>Este es el catálogo de pedidos de Kaserita.</p>
              <p className="text-sm mt-1">Pedile a tu bodega el link de su catálogo para empezar a pedir.</p>
            </div>
            {ultimaBodega && (
              <a
                href={`/${ultimaBodega.slug}`}
                className="flex items-center gap-3 bg-white border border-stone-200 rounded-2xl p-3 text-left"
              >
                <div className="w-11 h-11 rounded-full bg-stone-100 overflow-hidden shrink-0">
                  {ultimaBodega.logo_url ? (
                    <img src={ultimaBodega.logo_url} alt={ultimaBodega.nombre} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-violet-600 text-white font-bold text-sm">
                      {ultimaBodega.nombre?.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-stone-400">Seguir viendo</p>
                  <p className="font-semibold text-sm text-stone-800 truncate">{ultimaBodega.nombre}</p>
                </div>
                <i className="fa-solid fa-chevron-right text-stone-300"></i>
              </a>
            )}
            <button
              onClick={() => setModalCuentaAbierto(true)}
              className="text-sm text-violet-600 font-semibold underline"
            >
              Ingresá para ver tus bodegas guardadas
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
    return <div className="max-w-md mx-auto px-4 py-16 text-center text-stone-400">Cargando...</div>;
  }

  if (estadoBodega === "no-encontrada") {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center text-stone-500">
        <i className="fa-solid fa-circle-exclamation text-3xl text-stone-300 mb-3"></i>
        <p>No encontramos este catálogo.</p>
        <p className="text-sm mt-1">Puede que el link esté mal escrito o que la bodega no tenga delivery habilitado.</p>
      </div>
    );
  }

  if (pedidoConfirmado) {
    return (
      <PantallaConfirmacion
        bodega={bodega}
        codigo={pedidoConfirmado.codigo}
        whatsappUrl={pedidoConfirmado.whatsappUrl}
        onVolver={() => setPedidoConfirmado(null)}
      />
    );
  }

  if (vistaMisPedidos && clienteSesion) {
    return (
      <PantallaMisPedidos
        cliente={clienteSesion}
        onVolver={() => setVistaMisPedidos(false)}
        bodegaActualId={bodega?.bodega_id}
        onRepetirPedido={repetirPedido}
      />
    );
  }

  if (vistaMisTiendas && clienteSesion) {
    return <PantallaMisTiendas onVolver={() => setVistaMisTiendas(false)} />;
  }

  return (
    <div className="max-w-3xl mx-auto pb-28">
      <header className="bg-white border-b border-stone-200 px-4 pt-3 pb-3 flex items-center gap-3">
        <div className="w-11 h-11 rounded-full border border-stone-100 bg-stone-100 overflow-hidden shrink-0">
          {bodega.logo_url ? (
            <img src={bodega.logo_url} alt={bodega.nombre} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-violet-600 text-white font-bold">
              {bodega.nombre?.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h1 className="text-[15px] font-bold text-stone-800 truncate">{bodega.nombre}</h1>
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
          {(eventoInstalacion || (esIOS && !yaInstalada)) && (
            <button
              onClick={eventoInstalacion ? instalarApp : () => setInstruccionesIOSAbiertas(true)}
              title="Instalar"
              className="w-9 h-9 rounded-full bg-violet-50 text-violet-600 flex items-center justify-center"
            >
              <i className="fa-solid fa-download text-xs"></i>
            </button>
          )}
          {clienteSesion ? (
            <>
              <button
                onClick={() => setVistaMisTiendas(true)}
                title="Tiendas"
                className="w-9 h-9 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center"
              >
                <i className="fa-solid fa-store text-xs"></i>
              </button>
              <button
                onClick={() => setVistaMisPedidos(true)}
                title="Mis pedidos"
                className="w-9 h-9 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center"
              >
                <i className="fa-solid fa-receipt text-xs"></i>
              </button>
              <button
                onClick={salir}
                title="Salir"
                className="w-9 h-9 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center"
              >
                <i className="fa-solid fa-right-from-bracket text-xs"></i>
              </button>
            </>
          ) : (
            <button
              onClick={() => setModalCuentaAbierto(true)}
              title="Ingresar"
              className="w-9 h-9 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center"
            >
              <i className="fa-solid fa-user text-xs"></i>
            </button>
          )}
        </div>
      </header>

      {productos.length > 0 && (
        <div className="px-4 pt-3 pb-2 bg-white border-b border-stone-200 sticky top-0 z-20 space-y-2.5">
          <div className="relative">
            <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm"></i>
            <input
              type="text"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar producto..."
              className="w-full bg-stone-100 border border-stone-200 rounded-xl pl-9 pr-3 py-2.5 text-sm text-stone-800 placeholder-stone-400 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
          </div>
          {categorias.length > 0 && (
            <div className="relative -mx-4">
              <div className="flex gap-3 overflow-x-auto hide-scrollbar px-4 py-1">
                <button
                  onClick={() => { setCategoriaActiva(""); setSoloFavoritos(false); }}
                  className="shrink-0 w-16 flex flex-col items-center gap-1 active:scale-95 transition"
                >
                  <span
                    className={`w-[52px] h-[52px] rounded-2xl flex items-center justify-center shadow-sm ${
                      categoriaActiva === "" && !soloFavoritos
                        ? "bg-gradient-to-br from-violet-500 to-blue-600 text-white"
                        : "bg-white border border-stone-200 text-stone-500"
                    }`}
                  >
                    <i className="fa-solid fa-border-all text-lg"></i>
                  </span>
                  <span className={`text-[11px] font-bold truncate w-full text-center ${categoriaActiva === "" && !soloFavoritos ? "text-violet-700" : "text-stone-600"}`}>
                    Todos
                  </span>
                </button>
                {favoritos.size > 0 && (
                  <button
                    onClick={() => { setSoloFavoritos((v) => !v); setCategoriaActiva(""); }}
                    className="shrink-0 w-16 flex flex-col items-center gap-1 active:scale-95 transition"
                  >
                    <span
                      className={`w-[52px] h-[52px] rounded-2xl flex items-center justify-center shadow-sm border ${
                        soloFavoritos ? "bg-rose-500 border-rose-500 text-white" : "bg-rose-50 border-rose-200 text-rose-500"
                      }`}
                    >
                      <i className="fa-solid fa-heart text-lg"></i>
                    </span>
                    <span className={`text-[11px] font-bold truncate w-full text-center ${soloFavoritos ? "text-rose-600" : "text-stone-600"}`}>
                      Favoritos
                    </span>
                  </button>
                )}
                {categorias.map((c) => {
                  const est = estiloCategoria(c);
                  const activa = categoriaActiva === c;
                  return (
                    <button key={c} onClick={() => { setCategoriaActiva(c); setSoloFavoritos(false); }} className="shrink-0 w-16 flex flex-col items-center gap-1 active:scale-95 transition">
                      <span
                        className={`w-[52px] h-[52px] rounded-2xl flex items-center justify-center shadow-sm border ${est.bg} ${est.texto} ${
                          activa ? est.bordeActivo : est.borde
                        }`}
                      >
                        <i className={`fa-solid ${est.icono} text-lg`}></i>
                      </span>
                      <span className={`text-[11px] font-bold truncate w-full text-center ${activa ? "text-violet-700" : "text-stone-600"}`}>{c}</span>
                    </button>
                  );
                })}
              </div>
              <div className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-white to-transparent"></div>
            </div>
          )}
        </div>
      )}

      {combos.length > 0 && !busqueda.trim() && !categoriaActiva && !soloFavoritos && (
        <div className="pt-4">
          <div className="px-4 flex items-center justify-between mb-2">
            <p className="text-sm font-bold text-stone-800 flex items-center gap-1.5">
              <i className="fa-solid fa-gift text-amber-500"></i> Combos con descuento
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
            className="flex overflow-x-auto hide-scrollbar px-4 pb-1 snap-x snap-mandatory"
          >
            {combos.map((combo) => (
              <div key={combo.id} className="w-full shrink-0 snap-center pr-3 last:pr-0">
                <TarjetaCombo
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
                  className={`h-1.5 rounded-full transition-all ${i === comboActivo ? "w-4 bg-violet-600" : "w-1.5 bg-stone-300"}`}
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
              <i className="fa-solid fa-star text-amber-500"></i> Destacados
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
            className="flex overflow-x-auto hide-scrollbar px-4 pb-1 snap-x snap-mandatory"
          >
            {productosDestacados.map((p) => (
              <div key={p.id} className="w-full shrink-0 snap-center pr-3 last:pr-0">
                <div className={`relative bg-gradient-to-br ${gradienteDestacado(p.categoria)} rounded-[22px] p-4 pr-28 min-h-[168px] flex flex-col justify-between`}>
                  <div className="flex items-center gap-2">
                    <span className="bg-white/90 backdrop-blur text-stone-800 text-[11px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1">
                      <i className="fa-solid fa-star text-amber-500"></i> Destacado
                    </span>
                    {p.categoria && (
                      <span className="bg-white/15 backdrop-blur text-white text-[11px] font-semibold px-2.5 py-1 rounded-full">
                        {p.categoria}
                      </span>
                    )}
                  </div>
                  <div>
                    <p className="text-white text-lg font-bold leading-tight line-clamp-2">{tituloProducto(p.descripcion)}</p>
                    <p className="text-white/85 text-sm font-semibold mt-1">{formatoMoneda(p.precio_venta)}</p>
                  </div>
                  <button
                    onClick={() => agregarAlCarrito(p)}
                    className="self-start bg-white text-stone-800 text-xs font-bold px-4 py-2 rounded-full flex items-center gap-1.5 active:scale-95"
                  >
                    Pedir ahora <i className="fa-solid fa-arrow-right text-[10px]"></i>
                  </button>
                  <div className="absolute right-3 bottom-3 w-24 h-24 rounded-full overflow-hidden border-4 border-white/20 bg-white/10">
                    <img src={p.foto_url} alt={tituloProducto(p.descripcion)} className="w-full h-full object-cover" />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {productosDestacados.length > 1 && (
            <div className="flex items-center justify-center gap-1.5 pt-2">
              {productosDestacados.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${i === destacadoActivo ? "w-4 bg-violet-600" : "w-1.5 bg-stone-300"}`}
                ></span>
              ))}
            </div>
          )}
        </div>
      )}

      <main className="px-4 py-4">
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
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {productosFiltrados.map((p) => (
              <TarjetaProducto
                key={p.id}
                producto={p}
                cantidadEnCarrito={carrito[p.id] || 0}
                onAgregar={agregarAlCarrito}
                onQuitar={quitarDelCarrito}
                onVerFoto={setFotoAmpliada}
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
          <div className="bg-white border border-stone-200 rounded-2xl divide-y divide-stone-100">
            {productosAgotados.map((p) => {
              return (
                <div key={p.id} className="flex items-center gap-3 p-3">
                  <div className="w-11 h-11 rounded-xl bg-stone-100 flex items-center justify-center overflow-hidden shrink-0 grayscale opacity-70">
                    {p.foto_url ? (
                      <img src={p.foto_url} alt={tituloProducto(p.descripcion)} className="w-full h-full object-cover" />
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

      {totalUnidades > 0 && !carritoAbierto && (
        <button
          onClick={() => setCarritoAbierto(true)}
          className="fixed bottom-4 left-4 right-4 max-w-3xl mx-auto bg-gradient-to-r from-violet-600 to-blue-600 text-white rounded-full pl-2.5 pr-2 py-2 flex items-center justify-between gap-2 shadow-lg shadow-violet-600/30 active:scale-[0.98] transition-transform"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative w-9 h-9 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <i className="fa-solid fa-bag-shopping text-sm"></i>
              <span className="absolute -top-1 -right-1 bg-white text-violet-700 font-black text-[10px] w-4 h-4 rounded-full flex items-center justify-center">
                {totalUnidades}
              </span>
            </div>
            <div className="flex flex-col items-start min-w-0">
              <span className="text-[10px] font-bold uppercase tracking-wide text-white/80 leading-none">Mi pedido</span>
              <span className="text-sm font-extrabold leading-tight">{formatoMoneda(totalCarrito)}</span>
            </div>
          </div>
          <span className="flex items-center gap-1 bg-white text-violet-700 font-bold text-xs px-3.5 py-2 rounded-full shrink-0">
            Ver pedido <i className="fa-solid fa-arrow-right text-[10px]"></i>
          </span>
        </button>
      )}

      {carritoAbierto && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center sm:justify-center z-20">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] flex flex-col">
            <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
              <h2 className="font-bold text-stone-800">Tu pedido</h2>
              <button onClick={() => setCarritoAbierto(false)} className="text-stone-400">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-3">
              {itemsCarritoCombos.map((it) => (
                <div key={`combo-${it.id}`} className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-stone-800 truncate">
                      <i className="fa-solid fa-gift text-amber-500 text-xs mr-1"></i>Combo: {it.nombre}
                    </p>
                    <p className="text-xs text-stone-400">{formatoMoneda(it.precio_venta)} c/u</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => quitarComboDelCarrito(it)}
                      className="w-7 h-7 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center"
                    >
                      <i className="fa-solid fa-minus text-xs"></i>
                    </button>
                    <span className="text-sm font-semibold w-4 text-center">{it.cantidad}</span>
                    <button
                      onClick={() => agregarComboAlCarrito(it)}
                      className="w-7 h-7 rounded-full bg-amber-500 text-white flex items-center justify-center"
                    >
                      <i className="fa-solid fa-plus text-xs"></i>
                    </button>
                  </div>
                </div>
              ))}
              {itemsCarrito.map((it) => (
                <div key={it.id} className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-stone-800 truncate">{tituloProducto(it.descripcion)}</p>
                    <p className="text-xs text-stone-400">{formatoMoneda(it.precio_venta)} c/u</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => quitarDelCarrito(it)}
                      className="w-7 h-7 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center"
                    >
                      <i className="fa-solid fa-minus text-xs"></i>
                    </button>
                    <span className="text-sm font-semibold w-4 text-center">{it.cantidad}</span>
                    <button
                      onClick={() => agregarAlCarrito(it)}
                      className="w-7 h-7 rounded-full bg-violet-600 text-white flex items-center justify-center"
                    >
                      <i className="fa-solid fa-plus text-xs"></i>
                    </button>
                  </div>
                </div>
              ))}
              {itemsCarrito.length === 0 && itemsCarritoCombos.length === 0 && <p className="text-center text-stone-400 py-6">Tu carrito está vacío.</p>}
            </div>
            <div className="px-4 py-4 border-t border-stone-200">
              {estadoHorario && !estadoHorario.abierto && (
                <p className="text-xs text-stone-500 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 mb-3 flex items-center gap-1.5">
                  <i className="fa-solid fa-clock text-stone-400"></i>
                  Este local está cerrado ahora -- tu pedido va a esperar hasta que vuelvan a abrir.
                </p>
              )}
              {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-stone-500">Total</span>
                <span className="font-bold text-stone-800">{formatoMoneda(totalCarrito)}</span>
              </div>
              {clienteSesion ? (
                <button
                  onClick={confirmarPedido}
                  disabled={(itemsCarrito.length === 0 && itemsCarritoCombos.length === 0) || enviando}
                  className="w-full py-3 rounded-xl bg-violet-600 text-white font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {enviando ? "Generando..." : (
                    <>
                      <i className="fa-brands fa-whatsapp text-lg"></i> Confirmar y enviar por WhatsApp
                    </>
                  )}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={iniciarConGoogle}
                    disabled={itemsCarrito.length === 0 && itemsCarritoCombos.length === 0}
                    className="w-full py-3 rounded-xl bg-violet-600 text-white font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    <IconGoogle /> Continuar con Google para enviar el pedido
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {fotoAmpliada && (
        <VisorFoto producto={fotoAmpliada} onCerrar={() => setFotoAmpliada(null)} />
      )}

      {modalTodosCombos && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center sm:justify-center z-30" onClick={() => setModalTodosCombos(false)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
              <h2 className="font-bold text-stone-800">Todos los combos</h2>
              <button onClick={() => setModalTodosCombos(false)} className="text-stone-400">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-3">
              {combos.map((combo) => (
                <TarjetaCombo
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
          </div>
        </div>
      )}

      {modalTodosDestacados && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center sm:justify-center z-30" onClick={() => setModalTodosDestacados(false)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
              <h2 className="font-bold text-stone-800">Todos los destacados</h2>
              <button onClick={() => setModalTodosDestacados(false)} className="text-stone-400">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 grid grid-cols-2 gap-3">
              {productosDestacados.map((p) => (
                <TarjetaProducto
                  key={p.id}
                  producto={p}
                  cantidadEnCarrito={carrito[p.id] || 0}
                  onAgregar={agregarAlCarrito}
                  onQuitar={quitarDelCarrito}
                  onVerFoto={setFotoAmpliada}
                  esFavorito={favoritos.has(p.id)}
                  onToggleFavorito={toggleFavorito}
                />
              ))}
            </div>
          </div>
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
            // Recarga limpia (no solo limpiar el estado local) para no
            // arrastrar nada de la sesión cancelada al próximo intento.
            window.location.href = window.location.origin + window.location.pathname;
          }}
        />
      )}

      {instruccionesIOSAbiertas && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-5 max-w-sm w-full space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-stone-800">Instalar {bodega.nombre}</h2>
              <button onClick={() => setInstruccionesIOSAbiertas(false)} className="text-stone-400">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <p className="text-sm text-stone-600">
              En iPhone la instalación se hace desde Safari, así:
            </p>
            <ol className="text-sm text-stone-600 space-y-2 list-decimal list-inside">
              <li>Tocá el botón <i className="fa-solid fa-arrow-up-from-bracket"></i> Compartir (abajo o arriba de la pantalla).</li>
              <li>Elegí <strong>"Agregar a inicio"</strong>.</li>
              <li>Tocá <strong>"Agregar"</strong> arriba a la derecha.</li>
            </ol>
            <p className="text-xs text-stone-400">
              Solo funciona desde Safari, no desde Chrome ni otras apps del navegador.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
