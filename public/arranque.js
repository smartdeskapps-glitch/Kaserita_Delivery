// Red de seguridad del arranque: si la app no llega a dibujarse (archivos viejos
// que ya no existen tras un despliegue, un error al arrancar, o una descarga que
// no termina), en vez de dejar la pantalla en blanco se recarga sola una vez y,
// si sigue igual, muestra un aviso con botón "Recargar" y el detalle del error.
(function () {
  var ultimoError = "";
  function guardar(msg) { if (msg && !ultimoError) ultimoError = String(msg).slice(0, 300); }

  window.addEventListener("error", function (e) { guardar(e && (e.message || (e.error && e.error.message))); });
  window.addEventListener("unhandledrejection", function (e) {
    guardar(e && e.reason && (e.reason.message || e.reason));
  });

  function recargarUnaVez() {
    try {
      if (sessionStorage.getItem("kd_recarga_arranque")) return false;
      sessionStorage.setItem("kd_recarga_arranque", "1");
    } catch (e) { return false; }
    location.reload();
    return true;
  }

  // Vite avisa cuando falla la carga de un módulo (archivo de una versión anterior).
  window.addEventListener("vite:preloadError", function (e) {
    if (e && e.preventDefault) e.preventDefault();
    guardar("No se pudo cargar un archivo de la app");
    recargarUnaVez();
  });

  function pintarAviso() {
    var raiz = document.getElementById("root");
    if (raiz && raiz.children.length > 0) {
      // Dibujó bien: se limpia la marca para que una futura falla pueda recargar de nuevo.
      try { sessionStorage.removeItem("kd_recarga_arranque"); } catch (e) {}
      return;
    }
    if (!raiz || recargarUnaVez()) return;
    var caja = document.createElement("div");
    caja.style.cssText = "min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;font-family:system-ui,sans-serif;color:#1c1830;background:#f9f8fb";
    caja.innerHTML =
      '<div style="font-size:18px;font-weight:800">No pudimos abrir Kaserita Delivery</div>' +
      '<div style="font-size:13.5px;color:#78729a;max-width:280px">Revisa tu conexión y vuelve a intentar.</div>' +
      '<button id="kd-recargar" style="background:#6105dc;color:#fff;border:0;border-radius:999px;padding:12px 26px;font-size:14px;font-weight:700">Recargar</button>' +
      '<div style="font-size:10.5px;color:#a29cbd;max-width:300px;word-break:break-word">' +
      (ultimoError ? ultimoError.replace(/</g, "&lt;") : "sin detalle") + "</div>";
    raiz.appendChild(caja);
    document.getElementById("kd-recargar").onclick = function () { location.reload(); };
  }

  // Si a los 8 segundos la app sigue sin dibujar nada, se avisa.
  setTimeout(pintarAviso, 8000);
})();
