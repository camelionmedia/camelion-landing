/* ══════════════════════════════════════════════════════════════════════
   Captura de atribución (UTMs + referrer) — equivalente vanilla del hook
   `useUtmTracking` pedido. No hay React en este repo (ver booking-funnel.js
   para el porqué), así que esto es un módulo IIFE que expone
   `window.CamelionUTM.get()`.

   Primer toque: si ya hay UTMs guardadas para este visitante, una nueva
   visita SIN parámetros nuevos en la URL no las pisa — así el crédito de
   la campaña que originó el contacto no se pierde si la persona vuelve
   directo escribiendo la URL. Si la URL SÍ trae utm_source nuevo, ese
   nuevo toque gana (alguien que vino de un anuncio distinto).
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  var STORAGE_KEY = 'camelion_utm_attribution';
  var FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  function readStored() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function capture() {
    var params = new URLSearchParams(window.location.search);
    var fromUrl = {};
    var hasAny = false;
    FIELDS.forEach(function (f) {
      var v = params.get(f);
      if (v) { fromUrl[f] = v.slice(0, 150); hasAny = true; }
    });

    var stored = readStored();
    var data;
    if (hasAny) {
      // Nuevo toque con UTMs propias: gana sobre lo guardado.
      data = {
        utm_source: fromUrl.utm_source || null,
        utm_medium: fromUrl.utm_medium || null,
        utm_campaign: fromUrl.utm_campaign || null,
        utm_content: fromUrl.utm_content || null,
        utm_term: fromUrl.utm_term || null,
        page_referrer: (document.referrer || '').slice(0, 500) || null,
        captured_at: new Date().toISOString(),
      };
    } else if (stored) {
      data = stored;
    } else {
      // Ni URL ni storage: igual guardamos el referrer, sirve para saber
      // "vino de Instagram" aunque el link no llevara UTMs.
      data = {
        utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null,
        page_referrer: (document.referrer || '').slice(0, 500) || null,
        captured_at: new Date().toISOString(),
      };
    }

    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* Safari privado, etc. */ }
    return data;
  }

  var current = capture();

  window.CamelionUTM = {
    get: function () { return current; },
  };
})();
