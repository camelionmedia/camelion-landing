/* ══════════════════════════════════════════════════════════════════════
   BookingFunnel — funnel conversacional de agendamiento embebido nativo
   en /v1 y /v2. Reemplaza el iframe de GHL: la experiencia entera pasa
   por acá, sin salir de la página.

   Por qué vanilla JS (no React + Framer Motion, como pedía el spec
   original): camelion-landing es HTML estático puro, sin build step,
   deployado directo a Vercel — a propósito, porque son landings de
   tráfico pago con el pixel de Meta y el player VTurb preload-eados al
   milímetro para Core Web Vitals. Sumar React+ReactDOM+Framer Motion acá
   son ~130KB y un paso de build nuevo en el lugar del stack que menos
   margen tiene para pesar. Esta versión reproduce el mismo look & feel
   (slide & fade tipo Typeform, misma paleta) con CSS transitions puras.

   Orden de pasos — captura temprana de contacto primero:
   1 WhatsApp · 2 Nombre · 3 Email  →  (guarda el lead como
   "Formulario iniciado" apenas termina el paso 3, sin bloquear la UI) →
   4 Punto de dolor · 5 Capacidad de inversión (hard gate) ·
   6 Decisor + invitados · 7 Calendario · 8 Confirmación.

   Habla con el mismo backend que el CRM del portal (camelion-portal /
   worker.js): book-create confirma la reserva de verdad (Meet + Resend +
   Meta CAPI); lead-partial-save solo persiste el contacto temprano, sin
   generar ninguno de esos efectos — evita ensuciar la señal de Meta con
   un "Lead" duplicado por la misma persona. Ver CRM-SETUP.md.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CFG = Object.assign({
    workerUrl: 'https://camelion-upload.adrianyvanoff14.workers.dev',
    slug: 'camelion',
    mountId: 'agendar-funnel',
  }, window.CAMELION_FUNNEL_CONFIG || {});

  var MESES_CORTO = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  var DIAS_CORTO3 = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  var PHASES = [
    { key: 'datos', label: 'Tus datos', steps: [1, 2, 3] },
    { key: 'negocio', label: 'Tu negocio', steps: [4, 5, 6] },
    { key: 'dia', label: 'Día y hora', steps: [7] },
  ];
  var TOTAL_STEPS = 7;

  var DECISION_OPTIONS = [
    { value: 'solo_yo', label: 'Solo yo' },
    { value: 'socio_pareja', label: 'Yo junto a un socio/a o mi pareja' },
    { value: 'tercero', label: 'Tengo que consultarlo con un tercero' },
  ];

  var PAIN_OPTIONS = [
    'Sí, estoy perdiendo oportunidades concretas por esto',
    'Sí, me frena aunque todavía no pierdo clientes',
    'No, solo quiero mejorar la calidad de mis videos',
    'No, estoy explorando opciones',
  ];

  // Códigos de país más usados por la audiencia de Camelion. "Otro" cae al
  // input libre con "+" — no hace falta la lista completa de ~200 países
  // para una validación de FORMATO (ver nota de whatsapp_verified abajo).
  var COUNTRY_CODES = [
    { code: '+54', flag: '🇦🇷' }, { code: '+34', flag: '🇪🇸' },
    { code: '+52', flag: '🇲🇽' }, { code: '+57', flag: '🇨🇴' },
    { code: '+56', flag: '🇨🇱' }, { code: '+51', flag: '🇵🇪' },
    { code: '+593', flag: '🇪🇨' }, { code: '+598', flag: '🇺🇾' },
    { code: '+1', flag: '🇺🇸' }, { code: '+506', flag: '🇨🇷' },
    { code: '+other', flag: '🌎' },
  ];

  function readCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Misma regla que looksLikeValidPhone() del lado del servidor — el server
  // vuelve a calcularla igual y es la que en definitiva se guarda, esto es
  // solo para el feedback instantáneo en pantalla.
  function looksLikeValidPhone(raw) {
    var limpio = String(raw || '').replace(/[\s().-]/g, '');
    return /^\+?[1-9]\d{7,14}$/.test(limpio);
  }

  function fmtSlotHora(iso, tz) {
    return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  }
  function fmtFechaLarga(iso, tz) {
    var s = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function icsDate(iso) {
    return new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  function buildGoogleCalUrl(booking, tz) {
    var params = new URLSearchParams({
      action: 'TEMPLATE',
      text: 'Reunión con Camelion Media',
      dates: icsDate(booking.start_time) + '/' + icsDate(booking.end_time),
      details: 'Videollamada: ' + booking.meeting_link,
      location: booking.meeting_link,
      ctz: tz,
    });
    return 'https://calendar.google.com/calendar/render?' + params.toString();
  }

  function buildIcsDataUrl(booking) {
    var ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Camelion Media//Booking//ES', 'BEGIN:VEVENT',
      'UID:' + booking.id + '@camelionmedia.com',
      'DTSTAMP:' + icsDate(new Date().toISOString()),
      'DTSTART:' + icsDate(booking.start_time),
      'DTEND:' + icsDate(booking.end_time),
      'SUMMARY:Reunión con Camelion Media',
      'DESCRIPTION:Videollamada\\: ' + booking.meeting_link,
      'LOCATION:' + booking.meeting_link,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
  }

  // ── Datos comunes que viajan en cada llamada al backend ────────────────
  function attributionPayload() {
    var utm = (window.CamelionUTM && window.CamelionUTM.get()) || {};
    var variant = /\/v2\b/.test(window.location.pathname) ? 'v2' : 'v1';
    var fbp = readCookie('_fbp');
    var fbc = readCookie('_fbc');
    var fbclidParam = new URLSearchParams(window.location.search).get('fbclid');
    if (!fbc && fbclidParam) fbc = 'fb.1.' + Date.now() + '.' + fbclidParam;
    return {
      source: 'Funnel landing ' + variant,
      page_url: window.location.href,
      utm_source: utm.utm_source, utm_medium: utm.utm_medium, utm_campaign: utm.utm_campaign,
      utm_content: utm.utm_content, utm_term: utm.utm_term, page_referrer: utm.page_referrer,
      fbp: fbp, fbc: fbc,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  function BookingFunnel(root) {
    this.root = root;
    this.state = {
      step: 1,
      leadId: null,
      partialSaved: false,
      pain_point: null,
      investment_capacity: null,
      decision_maker: null,
      guest_emails: [],
      guestDraft: '',
      name: '', email: '', phone: '', countryCode: '+54', countryOther: '',
      phoneStatus: 'idle', // idle | checking | ok | bad
      calendar: null, days: [], selectedDate: null, selectedSlot: null,
      calLoading: false, calError: null,
      submitting: false, submitError: null, booking: null,
    };
    this.phoneTimer = null;
    this.render();
  }

  BookingFunnel.prototype.setState = function (patch) {
    Object.assign(this.state, patch);
    this.render();
    // Efectos secundarios DESPUÉS de que el render termine, nunca durante
    // — dispararlos desde adentro de un renderX() (que corre en medio de
    // construir el HTML) hace que el efecto llame a setState(), que vuelve
    // a llamar a render(), que vuelve a entrar al mismo renderX()...
    // recursión infinita y stack overflow.
    var st = this.state;
    if (st.step === 7 && !st.calendar && !st.calLoading && !st.calError) this.loadCalendar();
  };

  BookingFunnel.prototype.goTo = function (step, extra) {
    this.setState(Object.assign({ step: step }, extra || {}));
  };

  // ── Selección de opción de single-choice con avance automático ──────────
  BookingFunnel.prototype.selectAndAdvance = function (patch, nextStep) {
    var self = this;
    this.setState(patch);
    setTimeout(function () { self.goTo(nextStep); }, 300);
  };

  BookingFunnel.prototype.phoneFull = function () {
    var st = this.state;
    var cc = st.countryCode === '+other' ? (st.countryOther || '+') : st.countryCode;
    return (cc + st.phone).replace(/\s+/g, '');
  };

  // Igual que nombre/email: toca el estado en silencio y pinta el
  // indicador a mano en el DOM, sin re-renderizar todo el paso — si no, el
  // input perdería el foco en cada tecla que el usuario escribe.
  BookingFunnel.prototype.onPhoneInput = function (val) {
    var self = this;
    clearTimeout(this.phoneTimer);
    this.state.phone = val;
    this.state.phoneStatus = val.trim() ? 'checking' : 'idle';
    this.patchPhoneStatus();
    this.syncNextButton();
    if (!val.trim()) return;
    this.phoneTimer = setTimeout(function () {
      var ok = looksLikeValidPhone(self.phoneFull());
      self.state.phoneStatus = ok ? 'ok' : 'bad';
      self.patchPhoneStatus();
      self.syncNextButton();
    }, 450);
  };

  BookingFunnel.prototype.patchPhoneStatus = function () {
    var el = this.root.querySelector('.bf-phone-status');
    if (!el) return;
    var st = this.state.phoneStatus;
    el.className = 'bf-phone-status' + (st === 'ok' ? ' bf-ok' : st === 'bad' ? ' bf-bad' : st === 'checking' ? ' bf-checking' : '');
    el.innerHTML = st === 'checking' ? '<span class="bf-spin"></span> Verificando formato...'
      : st === 'ok' ? '✅ Formato válido'
      : st === 'bad' ? '⚠️ Revisá el código de país y el número'
      : '';
  };

  // Botón "Continuar" de los pasos 1/2/3 (campo único) — se habilita a mano
  // sin re-renderizar, mismo motivo que arriba.
  BookingFunnel.prototype.syncNextButton = function () {
    var st = this.state;
    var btn = this.root.querySelector('[data-solo-next]');
    if (!btn) return;
    var ok = st.step === 1 ? st.phoneStatus === 'ok'
      : st.step === 2 ? st.name.trim().length > 1
      : st.step === 3 ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(st.email.trim())
      : true;
    btn.disabled = !ok;
  };

  // ── Guardado temprano del lead (fire-and-forget) ────────────────────────
  // Se dispara apenas termina el paso 3 (email). No bloquea el avance de
  // pantalla ni muestra error si falla — el objetivo es best-effort: si
  // funciona, el contacto ya quedó en el CRM aunque abandone después; si
  // falla, la reserva final (book-create) igual va a guardar todo.
  BookingFunnel.prototype.savePartialLead = function () {
    var self = this;
    if (this.state.partialSaved) return;
    this.state.partialSaved = true;
    var body = Object.assign({
      name: this.state.name.trim(), email: this.state.email.trim(), phone: this.phoneFull(),
    }, attributionPayload());
    fetch(CFG.workerUrl + '?action=lead-partial-save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (data.success && data.lead) self.state.leadId = data.lead.id; })
      .catch(function () { /* best-effort: la reserva final igual guarda todo */ });
  };

  // ── Calendario ───────────────────────────────────────────────────────
  BookingFunnel.prototype.loadCalendar = function () {
    var self = this;
    if (this.state.calendar) return;
    this.setState({ calLoading: true, calError: null });
    fetch(CFG.workerUrl + '?action=book-calendar&slug=' + encodeURIComponent(CFG.slug))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error || 'No pudimos abrir la agenda');
        self.setState({ calendar: data.calendar, calLoading: false });
        return self.loadSlots();
      })
      .catch(function (e) { self.setState({ calLoading: false, calError: e.message }); });
  };

  BookingFunnel.prototype.loadSlots = function () {
    var self = this;
    return fetch(CFG.workerUrl + '?action=book-slots&slug=' + encodeURIComponent(CFG.slug))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var days = data.days || [];
        self.setState({ days: days, selectedDate: self.state.selectedDate || (days[0] && days[0].date) || null });
      })
      .catch(function () { self.setState({ calError: 'No pudimos cargar los horarios disponibles.' }); });
  };

  // ── Envío final ──────────────────────────────────────────────────────
  BookingFunnel.prototype.submit = function () {
    var self = this;
    var st = this.state;
    this.setState({ submitting: true, submitError: null });

    var body = Object.assign({
      slug: CFG.slug, start: st.selectedSlot, lead_id: st.leadId,
      name: st.name.trim(), email: st.email.trim(), phone: this.phoneFull(),
      investment_capacity: true,
      pain_point: st.pain_point, decision_maker: st.decision_maker, guest_emails: st.guest_emails,
    }, attributionPayload());

    fetch(CFG.workerUrl + '?action=book-create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.success) throw new Error(res.data.error || 'No pudimos confirmar la reserva');
        self.setState({ submitting: false, booking: res.data.booking, step: 8 });
      })
      .catch(function (e) {
        self.setState({ submitting: false, submitError: e.message });
        // Un horario que se ocupó justo antes: refrescamos la agenda y
        // mandamos de nuevo al paso 7 para que elija otro.
        if (/horario/i.test(e.message)) {
          self.setState({ step: 7, selectedSlot: null, calendar: null, days: [] });
          self.loadCalendar();
        }
      });
  };

  // ── Render ───────────────────────────────────────────────────────────
  BookingFunnel.prototype.render = function () {
    var st = this.state;
    var html = this.renderPhases() + '<div class="bf-step" data-step="' + st.step + '">' + this.renderStep() + '</div>';
    this.root.innerHTML = '<div class="bf-card">' + html + '</div>';
    this.bindEvents();
  };

  BookingFunnel.prototype.renderPhases = function () {
    var st = this.state;
    if (st.step === 'blocked' || st.step === 8) return '';
    var activePhaseIdx = PHASES.findIndex(function (p) { return p.steps.indexOf(st.step) !== -1; });
    var pills = PHASES.map(function (p, i) {
      var cls = i === activePhaseIdx ? ' bf-phase-active' : i < activePhaseIdx ? ' bf-phase-done' : '';
      return '<span class="bf-phase' + cls + '"><span class="bf-phase-dot"></span>' + esc(p.label) + '</span>';
    }).join('<span class="bf-phase-sep"></span>');
    return '<div class="bf-phases">' + pills + '</div>' +
      '<div class="bf-step-counter">Paso ' + st.step + ' de ' + TOTAL_STEPS + '</div>';
  };

  BookingFunnel.prototype.renderStep = function () {
    var st = this.state;
    switch (st.step) {
      case 1: return this.renderPhoneStep();
      case 2: return this.renderNameStep();
      case 3: return this.renderEmailStep();
      case 4: return this.renderPain();
      case 5: return this.renderInvestment();
      case 'blocked': return this.renderBlocked();
      case 6: return this.renderDecision();
      case 7: return this.renderCalendar();
      case 8: return this.renderSuccess();
      default: return '';
    }
  };

  // ── Paso 1: WhatsApp ─────────────────────────────────────────────────
  BookingFunnel.prototype.renderPhoneStep = function () {
    var st = this.state;
    var ccOptions = COUNTRY_CODES.map(function (c) {
      return '<option value="' + c.code + '"' + (st.countryCode === c.code ? ' selected' : '') + '>' + c.flag + ' ' + (c.code === '+other' ? 'Otro' : c.code) + '</option>';
    }).join('');
    var phoneStatusHtml = '<div class="bf-phone-status' +
      (st.phoneStatus === 'ok' ? ' bf-ok' : st.phoneStatus === 'bad' ? ' bf-bad' : st.phoneStatus === 'checking' ? ' bf-checking' : '') + '">' +
      (st.phoneStatus === 'checking' ? '<span class="bf-spin"></span> Verificando formato...'
        : st.phoneStatus === 'ok' ? '✅ Formato válido'
        : st.phoneStatus === 'bad' ? '⚠️ Revisá el código de país y el número' : '') +
      '</div>';

    return '<div class="bf-question">¿Cuál es tu WhatsApp?</div>' +
      '<div class="bf-question-sub">Ahí te confirmamos la reunión y mandamos el link. No lo compartimos con nadie.</div>' +
      '<div class="bf-solo-field"><div class="bf-phone-row">' +
      '<select id="bf-cc">' + ccOptions + '</select>' +
      '<input type="tel" id="bf-phone" inputmode="tel" autofocus value="' + esc(st.phone) + '" placeholder="11 2345 6789" /></div>' +
      (st.countryCode === '+other' ? '<input type="text" id="bf-cc-other" style="margin-top:10px;" value="' + esc(st.countryOther) + '" placeholder="Código, ej: +49" />' : '') +
      phoneStatusHtml + '</div>' +
      '<div class="bf-nav"><span></span><button type="button" class="bf-next" data-solo-next="1"' + (st.phoneStatus === 'ok' ? '' : ' disabled') + '>Continuar →</button></div>';
  };

  // ── Paso 2: nombre ───────────────────────────────────────────────────
  BookingFunnel.prototype.renderNameStep = function () {
    var st = this.state;
    return '<div class="bf-question">¿Cómo te llamás?</div>' +
      '<div class="bf-question-sub">Nombre y apellido, como te gusta que te digan.</div>' +
      '<div class="bf-solo-field"><input type="text" id="bf-name" autofocus value="' + esc(st.name) + '" placeholder="Tu nombre y apellido" /></div>' +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="1">← Atrás</button>' +
      '<button type="button" class="bf-next" data-solo-next="1"' + (st.name.trim().length > 1 ? '' : ' disabled') + '>Continuar →</button></div>';
  };

  // ── Paso 3: email ────────────────────────────────────────────────────
  BookingFunnel.prototype.renderEmailStep = function () {
    var st = this.state;
    var emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(st.email.trim());
    return '<div class="bf-question">¿Cuál es tu email?</div>' +
      '<div class="bf-question-sub">Te mandamos la confirmación y el link de la videollamada acá también.</div>' +
      '<div class="bf-solo-field"><input type="email" id="bf-email" inputmode="email" autofocus value="' + esc(st.email) + '" placeholder="tu@email.com" /></div>' +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="2">← Atrás</button>' +
      '<button type="button" class="bf-next" data-solo-next="1"' + (emailOk ? '' : ' disabled') + '>Continuar →</button></div>';
  };

  BookingFunnel.prototype.renderPain = function () {
    var st = this.state;
    var opts = PAIN_OPTIONS.map(function (o, i) {
      var sel = st.pain_point === o;
      return '<button type="button" class="bf-option' + (sel ? ' bf-selected' : '') + '" data-pain="' + i + '">' +
        '<span class="bf-option-dot"></span><span>' + esc(o) + '</span></button>';
    }).join('');
    return '<div class="bf-question">¿Estás rechazando trabajo o frenando tu crecimiento por no dar abasto con la edición?</div>' +
      '<div class="bf-options">' + opts + '</div>' +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="3">← Atrás</button></div>';
  };

  BookingFunnel.prototype.renderInvestment = function () {
    var st = this.state;
    var mk = function (val, label) {
      var sel = st.investment_capacity === val;
      return '<button type="button" class="bf-option' + (sel ? ' bf-selected' : '') + '" data-invest="' + val + '">' +
        '<span class="bf-option-dot"></span><span>' + esc(label) + '</span></button>';
    };
    return '<div class="bf-question">Si hacemos match en la reunión, nuestros planes empiezan en $600 USD. ¿Contás con esta capacidad de inversión?</div>' +
      '<div class="bf-options">' +
      mk('yes', 'Sí, tengo la capacidad de inversión') +
      mk('no', 'No cuento con la inversión mínima') +
      '</div>' +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="4">← Atrás</button></div>';
  };

  BookingFunnel.prototype.renderBlocked = function () {
    return '<div class="bf-blocked">' +
      '<div class="bf-blocked-icon">🙏</div>' +
      '<h3>Gracias por tu interés</h3>' +
      '<p>Por el momento nuestros planes requieren una inversión mínima de $600 USD por mes. ' +
      'Te invitamos a seguir a Camelion Media para ver recursos gratuitos y crecer mientras tanto.</p>' +
      '<a href="https://www.instagram.com/camelionmedia" target="_blank" rel="noreferrer">Ver recursos gratuitos →</a>' +
      '</div>';
  };

  BookingFunnel.prototype.renderDecision = function () {
    var st = this.state;
    var opts = DECISION_OPTIONS.map(function (o) {
      var sel = st.decision_maker === o.value;
      return '<button type="button" class="bf-option' + (sel ? ' bf-selected' : '') + '" data-decision="' + o.value + '">' +
        '<span class="bf-option-dot"></span><span>' + esc(o.label) + '</span></button>';
    }).join('');

    var needsGuest = st.decision_maker === 'socio_pareja' || st.decision_maker === 'tercero';
    var guestBlock = '';
    if (needsGuest) {
      var chips = st.guest_emails.map(function (em, i) {
        return '<div class="bf-guest-chip"><span>' + esc(em) + '</span><button type="button" data-remove-guest="' + i + '">✕</button></div>';
      }).join('');
      guestBlock = '<div class="bf-banner">⚠️ En caso de que no estén presentes todos los tomadores de decisión, Camelion se reserva el derecho de cancelar la reunión.</div>' +
        (st.guest_emails.length < 3
          ? '<div class="bf-guest-row"><input type="email" id="bf-guest-input" placeholder="Email del invitado" value="' + esc(st.guestDraft) + '" />' +
            '<button type="button" class="bf-add-cal" data-add-guest="1" style="flex:0 0 auto;">+ Añadir</button></div>'
          : '') +
        chips;
    }

    return '<div class="bf-question">¿Quién toma la decisión de contratar?</div>' +
      '<div class="bf-options">' + opts + '</div>' + guestBlock +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="5">← Atrás</button>' +
      '<button type="button" class="bf-next" data-next-decision="1"' + (st.decision_maker ? '' : ' disabled') + '>Continuar →</button></div>';
  };

  // ── Paso 7: calendario — tira de días + pills de horario ────────────
  BookingFunnel.prototype.renderCalendar = function () {
    var st = this.state;
    if (!st.calendar && !st.calError) return '<div class="bf-loading">Cargando horarios...</div>';
    if (st.calError) return '<div class="bf-question">No pudimos abrir la agenda</div><p class="bf-empty-note">' + esc(st.calError) + '</p>' +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="6">← Atrás</button></div>';

    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    var byDate = {};
    st.days.forEach(function (d) { byDate[d.date] = d.slots; });

    var mesPrevio = null;
    var dayPills = st.days.map(function (d) {
      var date = new Date(d.date + 'T12:00:00');
      var mes = MESES_CORTO[date.getMonth()];
      var mostrarMes = mes !== mesPrevio;
      mesPrevio = mes;
      var sel = d.date === st.selectedDate;
      return '<button type="button" class="bf-day-pill' + (sel ? ' bf-day-selected' : '') + '" data-day="' + d.date + '">' +
        '<span class="bf-day-pill-dow">' + DIAS_CORTO3[date.getDay()] + '</span>' +
        '<span class="bf-day-pill-num">' + date.getDate() + '</span>' +
        (mostrarMes ? '<span class="bf-day-pill-mon">' + mes + '</span>' : '<span class="bf-day-pill-mon">&nbsp;</span>') +
        '</button>';
    }).join('');

    var slots = (byDate[st.selectedDate] || []);
    var slotsHtml = slots.length
      ? '<div class="bf-slots-grid">' + slots.map(function (s) {
          var sel = s === st.selectedSlot;
          return '<button type="button" class="bf-slot' + (sel ? ' bf-slot-selected' : '') + '" data-slot="' + s + '">' + fmtSlotHora(s, tz) + '</button>';
        }).join('') + '</div>'
      : '<p class="bf-empty-note">' + (st.days.length ? 'Elegí un día para ver los horarios.' : 'No hay horarios libres por ahora. Escribinos y lo coordinamos a mano.') + '</p>';

    return '<div class="bf-question">Elegí el día y la hora</div>' +
      '<div class="bf-question-sub">Duración: ' + (st.calendar.duration_min || 30) + ' min · Horarios en tu zona (' + tz.replace(/_/g, ' ') + ')</div>' +
      '<div class="bf-days-label">Día</div>' +
      '<div class="bf-days-strip">' + dayPills + '</div>' +
      '<div class="bf-slots-label">Horario</div>' + slotsHtml +
      (st.submitError ? '<div class="bf-error">⚠️ ' + esc(st.submitError) + '</div>' : '') +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="6">← Atrás</button>' +
      '<button type="button" class="bf-next" data-confirm="1"' + (st.selectedSlot && !st.submitting ? '' : ' disabled') + '>' +
      (st.submitting ? 'Confirmando...' : 'Confirmar reunión') + '</button></div>';
  };

  BookingFunnel.prototype.renderSuccess = function () {
    var st = this.state;
    var b = st.booking;
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return '<div class="bf-success">' +
      '<div class="bf-check">✓</div>' +
      '<h3>Listo, ' + esc(st.name.split(' ')[0]) + '</h3>' +
      '<p>Tu reunión quedó confirmada. Te mandamos el link también por mail a ' + esc(st.email) + '.</p>' +
      '<div class="bf-summary"><div class="bf-summary-row"><span>Cuándo</span><span>' + esc(fmtFechaLarga(b.start_time, tz)) + '</span></div>' +
      '<div class="bf-summary-row"><span>Zona horaria</span><span>' + esc(tz.replace(/_/g, ' ')) + '</span></div></div>' +
      '<a class="bf-join-btn" href="' + esc(b.meeting_link) + '" target="_blank" rel="noreferrer">🎥 Entrar a la videollamada</a>' +
      '<div class="bf-add-row">' +
      '<a class="bf-add-cal" href="' + esc(buildGoogleCalUrl(b, tz)) + '" target="_blank" rel="noreferrer">+ Google Calendar</a>' +
      '<a class="bf-add-cal" href="' + buildIcsDataUrl(b) + '" download="reunion-camelion.ics">+ iCal</a>' +
      '</div></div>';
  };

  // ── Eventos (delegación simple, se re-bindea en cada render) ───────────
  BookingFunnel.prototype.bindEvents = function () {
    var self = this;
    var root = this.root;

    // `autofocus` como atributo HTML no hace nada cuando el marcado se
    // inyecta vía innerHTML (solo funciona en el parseo inicial de la
    // página) — el foco automático de cada paso de un solo campo hay que
    // pedirlo a mano. El pequeño setTimeout evita pelear con la animación
    // de entrada del paso, que si no a veces se comía el foco.
    var autoFocusEl = root.querySelector('[autofocus]');
    if (autoFocusEl) setTimeout(function () { autoFocusEl.focus(); }, 60);

    // Paso 1 — WhatsApp
    var ccSelect = root.querySelector('#bf-cc');
    if (ccSelect) ccSelect.addEventListener('change', function (e) { self.setState({ countryCode: e.target.value }); self.onPhoneInput(self.state.phone); });
    var ccOther = root.querySelector('#bf-cc-other');
    if (ccOther) ccOther.addEventListener('input', function (e) { self.state.countryOther = e.target.value; self.onPhoneInput(self.state.phone); });
    var phoneInput = root.querySelector('#bf-phone');
    if (phoneInput) {
      phoneInput.addEventListener('input', function (e) { self.onPhoneInput(e.target.value); });
      phoneInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && self.state.phoneStatus === 'ok') self.goTo(2); });
    }

    // Paso 2 — nombre
    var nameInput = root.querySelector('#bf-name');
    if (nameInput) {
      nameInput.addEventListener('input', function (e) { self.state.name = e.target.value; self.syncNextButton(); });
      nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && self.state.name.trim().length > 1) self.goTo(3); });
    }

    // Paso 3 — email
    var emailInput = root.querySelector('#bf-email');
    if (emailInput) {
      emailInput.addEventListener('input', function (e) { self.state.email = e.target.value; self.syncNextButton(); });
      emailInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(self.state.email.trim())) { self.savePartialLead(); self.goTo(4); }
      });
    }

    var soloNext = root.querySelector('[data-solo-next]');
    if (soloNext) soloNext.addEventListener('click', function () {
      if (soloNext.disabled) return;
      if (self.state.step === 3) self.savePartialLead();
      self.goTo(self.state.step + 1);
    });

    // Pasos 4/5 — opción única con avance automático
    root.querySelectorAll('[data-pain]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        self.selectAndAdvance({ pain_point: PAIN_OPTIONS[+btn.dataset.pain] }, 5);
      });
    });
    root.querySelectorAll('[data-invest]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = btn.dataset.invest;
        if (val === 'no') { self.selectAndAdvance({ investment_capacity: false }, 'blocked'); return; }
        self.selectAndAdvance({ investment_capacity: true }, 6);
      });
    });

    // Paso 6 — decisor + invitados
    root.querySelectorAll('[data-decision]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.setState({ decision_maker: btn.dataset.decision }); });
    });
    var addGuestBtn = root.querySelector('[data-add-guest]');
    if (addGuestBtn) addGuestBtn.addEventListener('click', function () {
      var input = root.querySelector('#bf-guest-input');
      var val = (input.value || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) return;
      if (self.state.guest_emails.indexOf(val) !== -1) { self.setState({ guestDraft: '' }); return; }
      self.setState({ guest_emails: self.state.guest_emails.concat(val), guestDraft: '' });
    });
    root.querySelectorAll('[data-remove-guest]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = +btn.dataset.removeGuest;
        self.setState({ guest_emails: self.state.guest_emails.filter(function (_, idx) { return idx !== i; }) });
      });
    });
    var nextDecision = root.querySelector('[data-next-decision]');
    if (nextDecision) nextDecision.addEventListener('click', function () { if (!nextDecision.disabled) self.goTo(7); });

    // Navegación atrás genérica
    root.querySelectorAll('[data-back]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.goTo(+btn.dataset.back); });
    });

    // Paso 7 — calendario
    root.querySelectorAll('[data-day]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.setState({ selectedDate: btn.dataset.day, selectedSlot: null }); });
    });
    root.querySelectorAll('[data-slot]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.setState({ selectedSlot: btn.dataset.slot }); });
    });
    var confirmBtn = root.querySelector('[data-confirm]');
    if (confirmBtn) confirmBtn.addEventListener('click', function () { if (!confirmBtn.disabled) self.submit(); });
  };

  function init() {
    var mount = document.getElementById(CFG.mountId);
    if (!mount) return;
    mount.classList.add('bf-root');
    new BookingFunnel(mount);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
