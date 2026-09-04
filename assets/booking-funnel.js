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

   Habla con el mismo backend que el CRM del portal (camelion-portal /
   worker.js), acciones públicas book-calendar / book-slots / book-create
   — es el mismo motor que ya genera el Google Meet, manda los mails por
   Resend y dispara Meta CAPI. Ver CRM-SETUP.md en ese repo.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CFG = Object.assign({
    workerUrl: 'https://camelion-upload.adrianyvanoff14.workers.dev',
    slug: 'camelion',
    mountId: 'agendar-funnel',
  }, window.CAMELION_FUNNEL_CONFIG || {});

  var MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  var DIAS_CORTO = ['D','L','M','M','J','V','S'];

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
    { code: '+54', label: '🇦🇷 +54' }, { code: '+34', label: '🇪🇸 +34' },
    { code: '+52', label: '🇲🇽 +52' }, { code: '+57', label: '🇨🇴 +57' },
    { code: '+56', label: '🇨🇱 +56' }, { code: '+51', label: '🇵🇪 +51' },
    { code: '+593', label: '🇪🇨 +593' }, { code: '+598', label: '🇺🇾 +598' },
    { code: '+1', label: '🇺🇸/🇵🇷 +1' }, { code: '+506', label: '🇨🇷 +506' },
    { code: '+other', label: 'Otro' },
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

  function BookingFunnel(root) {
    this.root = root;
    this.state = {
      step: 1,
      pain_point: null,
      investment_capacity: null,
      decision_maker: null,
      guest_emails: [],
      guestDraft: '',
      name: '', email: '', phone: '', countryCode: '+54', countryOther: '',
      phoneStatus: 'idle', // idle | checking | ok | bad
      calendar: null, days: [], monthOffset: 0, selectedDate: null, selectedSlot: null,
      calLoading: false, calError: null,
      submitting: false, submitError: null, booking: null,
    };
    this.phoneTimer = null;
    this.render();
  }

  BookingFunnel.prototype.setState = function (patch) {
    Object.assign(this.state, patch);
    this.render();
    // Efecto secundario DESPUÉS de que el render termine, nunca durante —
    // dispararlo desde adentro de renderCalendar() (que corre en medio de
    // construir el HTML) hacía que loadCalendar() llamara a setState(), que
    // volvía a llamar a render(), que volvía a entrar a renderCalendar()...
    // recursión infinita y stack overflow apenas se llegaba al paso 5.
    if (this.state.step === 5 && !this.state.calendar && !this.state.calLoading && !this.state.calError) {
      this.loadCalendar();
    }
  };

  BookingFunnel.prototype.totalSteps = function () { return 6; };

  BookingFunnel.prototype.goTo = function (step, extra) {
    this.setState(Object.assign({ step: step }, extra || {}));
  };

  // ── Selección de opción de single-choice con avance automático ──────────
  BookingFunnel.prototype.selectAndAdvance = function (patch, nextStep) {
    var self = this;
    this.setState(patch);
    setTimeout(function () { self.goTo(nextStep); }, 320);
  };

  BookingFunnel.prototype.phoneFull = function () {
    var st = this.state;
    var cc = st.countryCode === '+other' ? (st.countryOther || '+') : st.countryCode;
    return (cc + st.phone).replace(/\s+/g, '');
  };

  // Igual que el nombre/email: toca el estado en silencio y pinta el
  // indicador a mano en el DOM, sin re-renderizar todo el paso — si no, el
  // input perdería el foco en cada tecla que el usuario escribe.
  BookingFunnel.prototype.onPhoneInput = function (val) {
    var self = this;
    clearTimeout(this.phoneTimer);
    this.state.phone = val;
    this.state.phoneStatus = val.trim() ? 'checking' : 'idle';
    this.patchPhoneStatus();
    this.syncContactButton();
    if (!val.trim()) return;
    this.phoneTimer = setTimeout(function () {
      var ok = looksLikeValidPhone(self.phoneFull());
      self.state.phoneStatus = ok ? 'ok' : 'bad';
      self.patchPhoneStatus();
      self.syncContactButton();
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
    var utm = (window.CamelionUTM && window.CamelionUTM.get()) || {};
    var variant = /\/v2\b/.test(window.location.pathname) ? 'v2' : 'v1';
    var fbp = readCookie('_fbp');
    var fbc = readCookie('_fbc');
    var fbclidParam = new URLSearchParams(window.location.search).get('fbclid');
    if (!fbc && fbclidParam) fbc = 'fb.1.' + Date.now() + '.' + fbclidParam;

    var body = {
      slug: CFG.slug, start: st.selectedSlot,
      name: st.name.trim(), email: st.email.trim(), phone: this.phoneFull(),
      investment_capacity: true,
      pain_point: st.pain_point, decision_maker: st.decision_maker, guest_emails: st.guest_emails,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      source: 'Funnel landing ' + variant,
      page_url: window.location.href,
      utm_source: utm.utm_source, utm_medium: utm.utm_medium, utm_campaign: utm.utm_campaign,
      utm_content: utm.utm_content, utm_term: utm.utm_term, page_referrer: utm.page_referrer,
      fbp: fbp, fbc: fbc,
    };

    fetch(CFG.workerUrl + '?action=book-create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.success) throw new Error(res.data.error || 'No pudimos confirmar la reserva');
        self.setState({ submitting: false, booking: res.data.booking, step: 6 });
      })
      .catch(function (e) {
        self.setState({ submitting: false, submitError: e.message });
        // Un horario que se ocupó justo antes: refrescamos la agenda y
        // mandamos de nuevo al paso 5 para que elija otro.
        if (/horario/i.test(e.message)) {
          self.setState({ step: 5, selectedSlot: null, calendar: null, days: [] });
          self.loadCalendar();
        }
      });
  };

  // ── Render ───────────────────────────────────────────────────────────
  BookingFunnel.prototype.render = function () {
    var st = this.state;
    var progress = st.step === 'blocked' ? 100 : Math.round((st.step / this.totalSteps()) * 100);
    var label = st.step === 'blocked' ? '' : 'Paso ' + st.step + ' de ' + this.totalSteps();

    var html = '<div class="bf-progress-track"><div class="bf-progress-fill" style="width:' + progress + '%"></div></div>';
    if (label) html += '<div class="bf-step-label">' + label + '</div>';
    html += '<div class="bf-step" data-step="' + st.step + '">' + this.renderStep() + '</div>';

    this.root.innerHTML = '<div class="bf-card">' + html + '</div>';
    this.bindEvents();
  };

  BookingFunnel.prototype.renderStep = function () {
    var st = this.state;
    switch (st.step) {
      case 1: return this.renderPain();
      case 2: return this.renderInvestment();
      case 'blocked': return this.renderBlocked();
      case 3: return this.renderDecision();
      case 4: return this.renderContact();
      case 5: return this.renderCalendar();
      case 6: return this.renderSuccess();
      default: return '';
    }
  };

  BookingFunnel.prototype.renderPain = function () {
    var st = this.state;
    var opts = PAIN_OPTIONS.map(function (o, i) {
      var sel = st.pain_point === o;
      return '<button type="button" class="bf-option' + (sel ? ' bf-selected' : '') + '" data-pain="' + i + '">' +
        '<span class="bf-option-dot"></span><span>' + esc(o) + '</span></button>';
    }).join('');
    return '<div class="bf-question">¿Estás rechazando trabajo o frenando tu crecimiento por no dar abasto con la edición?</div>' +
      '<div class="bf-options">' + opts + '</div>';
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
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="1">← Atrás</button></div>';
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
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="2">← Atrás</button>' +
      '<button type="button" class="bf-next" data-next-decision="1"' + (st.decision_maker ? '' : ' disabled') + '>Continuar →</button></div>';
  };

  BookingFunnel.prototype.renderContact = function () {
    var st = this.state;
    var ccOptions = COUNTRY_CODES.map(function (c) {
      return '<option value="' + c.code + '"' + (st.countryCode === c.code ? ' selected' : '') + '>' + c.label + '</option>';
    }).join('');
    // El div existe siempre, aunque esté vacío — patchPhoneStatus() lo pinta
    // a mano en cada tecla sin volver a dibujar el paso entero, y necesita
    // encontrarlo ya presente en el DOM desde este primer render.
    var phoneStatusHtml = '<div class="bf-phone-status' +
      (st.phoneStatus === 'ok' ? ' bf-ok' : st.phoneStatus === 'bad' ? ' bf-bad' : st.phoneStatus === 'checking' ? ' bf-checking' : '') + '">' +
      (st.phoneStatus === 'checking' ? '<span class="bf-spin"></span> Verificando formato...'
        : st.phoneStatus === 'ok' ? '✅ Formato válido'
        : st.phoneStatus === 'bad' ? '⚠️ Revisá el código de país y el número' : '') +
      '</div>';

    var emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(st.email.trim());
    var canContinue = st.name.trim() && emailOk && st.phoneStatus === 'ok';

    return '<div class="bf-question">Contanos cómo contactarte</div>' +
      '<div class="bf-field"><label>Nombre completo</label><input type="text" id="bf-name" value="' + esc(st.name) + '" placeholder="Tu nombre y apellido" /></div>' +
      '<div class="bf-field"><label>Email</label><input type="email" id="bf-email" value="' + esc(st.email) + '" placeholder="tu@email.com" /></div>' +
      '<div class="bf-field"><label>WhatsApp</label>' +
      '<div class="bf-phone-row"><select id="bf-cc">' + ccOptions + '</select>' +
      '<input type="tel" id="bf-phone" value="' + esc(st.phone) + '" placeholder="11 2345 6789" /></div>' +
      (st.countryCode === '+other' ? '<input type="text" id="bf-cc-other" style="margin-top:8px;" value="' + esc(st.countryOther) + '" placeholder="Código, ej: +49" />' : '') +
      phoneStatusHtml + '</div>' +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="3">← Atrás</button>' +
      '<button type="button" class="bf-next" data-next-contact="1"' + (canContinue ? '' : ' disabled') + '>Continuar →</button></div>';
  };

  BookingFunnel.prototype.renderCalendar = function () {
    var st = this.state;
    if (!st.calendar && !st.calError) return '<div class="bf-loading">Cargando horarios...</div>';
    if (st.calError) return '<div class="bf-question">No pudimos abrir la agenda</div><p class="bf-empty-note">' + esc(st.calError) + '</p>' +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="4">← Atrás</button></div>';

    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    var byDate = {};
    st.days.forEach(function (d) { byDate[d.date] = d.slots; });
    var hasSlots = {};
    Object.keys(byDate).forEach(function (k) { hasSlots[k] = true; });

    var base = st.days[0] ? new Date(st.days[0].date + 'T12:00:00') : new Date();
    var ancla = new Date(base.getFullYear(), base.getMonth() + st.monthOffset, 1);
    var arranque = new Date(ancla); arranque.setDate(1 - ancla.getDay());
    var celdas = [];
    for (var i = 0; i < 42; i++) { var d = new Date(arranque); d.setDate(arranque.getDate() + i); celdas.push(d); }

    var dow = DIAS_CORTO.map(function (d) { return '<div class="bf-cal-dow">' + d + '</div>'; }).join('');
    var grid = celdas.map(function (d) {
      var key = d.toLocaleDateString('en-CA');
      var otroMes = d.getMonth() !== ancla.getMonth();
      var hay = hasSlots[key];
      var sel = key === st.selectedDate;
      var cls = 'bf-cal-day' + (hay ? ' bf-has-slots' : '') + (sel ? ' bf-day-selected' : '');
      return '<button type="button" class="' + cls + '" data-day="' + key + '"' + (hay ? '' : ' disabled') +
        ' style="' + (otroMes && !hay ? 'visibility:hidden' : '') + '">' + d.getDate() + '</button>';
    }).join('');

    var slots = (byDate[st.selectedDate] || []);
    var slotsHtml = slots.length
      ? '<div class="bf-slots-grid">' + slots.map(function (s) {
          var sel = s === st.selectedSlot;
          return '<button type="button" class="bf-slot' + (sel ? ' bf-slot-selected' : '') + '" data-slot="' + s + '">' + fmtSlotHora(s, tz) + '</button>';
        }).join('') + '</div>'
      : '<p class="bf-empty-note">' + (st.selectedDate ? 'Ese día no tiene horarios libres.' : (st.days.length ? 'Elegí un día con horarios disponibles.' : 'No hay horarios libres por ahora. Escribinos y lo coordinamos a mano.')) + '</p>';

    return '<div class="bf-question">Elegí el día y la hora</div>' +
      '<div class="bf-cal-header"><div class="bf-cal-title">' + MESES[ancla.getMonth()] + ' ' + ancla.getFullYear() + '</div>' +
      '<div class="bf-cal-nav"><button type="button" data-month="-1"' + (st.monthOffset <= 0 ? ' disabled' : '') + '>←</button>' +
      '<button type="button" data-month="1">→</button></div></div>' +
      '<div class="bf-cal-grid">' + dow + grid + '</div>' +
      '<div class="bf-slots-label">Horarios (' + tz.replace(/_/g, ' ') + ')</div>' + slotsHtml +
      (st.submitError ? '<div class="bf-error">⚠️ ' + esc(st.submitError) + '</div>' : '') +
      '<div class="bf-nav"><button type="button" class="bf-back" data-back="4">← Atrás</button>' +
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

    root.querySelectorAll('[data-pain]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        self.selectAndAdvance({ pain_point: PAIN_OPTIONS[+btn.dataset.pain] }, 2);
      });
    });

    root.querySelectorAll('[data-invest]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = btn.dataset.invest;
        if (val === 'no') { self.selectAndAdvance({ investment_capacity: false }, 'blocked'); return; }
        self.selectAndAdvance({ investment_capacity: true }, 3);
      });
    });

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
    if (nextDecision) nextDecision.addEventListener('click', function () { if (!nextDecision.disabled) self.goTo(4); });

    var nameInput = root.querySelector('#bf-name');
    if (nameInput) nameInput.addEventListener('input', function (e) { self.state.name = e.target.value; self.syncContactButton(); });
    var emailInput = root.querySelector('#bf-email');
    if (emailInput) emailInput.addEventListener('input', function (e) { self.state.email = e.target.value; self.syncContactButton(); });
    var ccSelect = root.querySelector('#bf-cc');
    if (ccSelect) ccSelect.addEventListener('change', function (e) { self.setState({ countryCode: e.target.value }); self.onPhoneInput(self.state.phone); });
    var ccOther = root.querySelector('#bf-cc-other');
    if (ccOther) ccOther.addEventListener('input', function (e) { self.state.countryOther = e.target.value; self.onPhoneInput(self.state.phone); });
    var phoneInput = root.querySelector('#bf-phone');
    if (phoneInput) phoneInput.addEventListener('input', function (e) { self.onPhoneInput(e.target.value); });

    var nextContact = root.querySelector('[data-next-contact]');
    if (nextContact) nextContact.addEventListener('click', function () { if (!nextContact.disabled) self.goTo(5); });

    root.querySelectorAll('[data-back]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.goTo(+btn.dataset.back); });
    });

    root.querySelectorAll('[data-month]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.setState({ monthOffset: self.state.monthOffset + (+btn.dataset.month) }); });
    });
    root.querySelectorAll('[data-day]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.setState({ selectedDate: btn.dataset.day, selectedSlot: null }); });
    });
    root.querySelectorAll('[data-slot]').forEach(function (btn) {
      btn.addEventListener('click', function () { self.setState({ selectedSlot: btn.dataset.slot }); });
    });
    var confirmBtn = root.querySelector('[data-confirm]');
    if (confirmBtn) confirmBtn.addEventListener('click', function () { if (!confirmBtn.disabled) self.submit(); });
  };

  // Los inputs de texto libre (nombre/email) re-renderizarían el DOM y le
  // harían perder el foco al usuario en cada tecla si pasaran por setState
  // — por eso solo tocan el estado en silencio y habilitan/deshabilitan el
  // botón a mano, sin volver a dibujar todo el paso.
  BookingFunnel.prototype.syncContactButton = function () {
    var st = this.state;
    var emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(st.email.trim());
    var canContinue = st.name.trim() && emailOk && st.phoneStatus === 'ok';
    var btn = this.root.querySelector('[data-next-contact]');
    if (btn) btn.disabled = !canContinue;
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
