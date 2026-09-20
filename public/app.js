'use strict';

const $ = (s) => document.querySelector(s);
const stream = $('#stream');
const input = $('#input');
const sendBtn = $('#sendBtn');
const planSelect = $('#planSelect');

// Estado conversacional en memoria
const historial = [];              // [{role:'user'|'assistant', content}]
let estado = { planId: '', especialidadId: '', urgencia: null };
let ubicacion = null;              // { lat, lng } si el usuario la comparte (opt-in)
let estadoUltimaEsp = '';          // nombre de la especialidad actual (para el mensaje de cita)
let vozActiva = false;             // si el bot lee sus respuestas en voz alta (TTS)
let reconociendo = false;          // si el dictado por voz esta activo (STT)

const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Estilos de urgencia (el texto viene de i18n segun idioma)
const URG_CLS = {
  alta: { key: 'urgHigh', cls: 'bg-rose-500/20 text-rose-300 border-rose-400/30', dot: 'bg-rose-400' },
  media: { key: 'urgMed', cls: 'bg-amber-500/20 text-amber-300 border-amber-400/30', dot: 'bg-amber-400' },
  baja: { key: 'urgLow', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/30', dot: 'bg-emerald-400' },
};
function urgencia(nivel) {
  const u = URG_CLS[nivel] || URG_CLS.media;
  return { txt: t(u.key), cls: u.cls, dot: u.dot };
}

// ── Init ────────────────────────────────────────────────────────────
async function init() {
  try {
    const meta = await fetch('/api/meta').then((r) => r.json());
    meta.planes.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.nombre} · ${p.coaseguroPct}%`;
      planSelect.appendChild(o);
    });
  } catch (_) { /* sin planes, el chat igual funciona */ }

  planSelect.addEventListener('change', () => {
    estado.planId = planSelect.value || '';
    if (estado.planId) {
      const nombre = planSelect.options[planSelect.selectedIndex].textContent.split(' · ')[0];
      addBot(t('planFixed', escapeHtml(nombre)));
    }
  });

  const geoBtn = document.querySelector('#geoBtn');
  if (geoBtn) geoBtn.addEventListener('click', pedirUbicacion);

  const voiceBtn = document.querySelector('#voiceBtn');
  if (voiceBtn) voiceBtn.addEventListener('click', toggleVoz);

  const micBtn = document.querySelector('#micBtn');
  if (micBtn) micBtn.addEventListener('click', dictar);

  const langBtn = document.querySelector('#langBtn');
  if (langBtn) {
    langBtn.addEventListener('click', cambiarIdioma);
    langBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cambiarIdioma(); } });
  }

  aplicarIdioma();      // traduce la UI estatica al idioma detectado
  addBot(t('greeting')); // saludo inicial
  addChips();
  initGiroscopio();     // parallax del ECG con el sensor del telefono
}

// ── Giroscopio: mueve el fondo ECG segun la inclinacion del telefono ──
function initGiroscopio() {
  const tilt = document.querySelector('#ecgTilt');
  if (!tilt || !window.DeviceOrientationEvent) return; // desktop: se queda la animacion normal

  const onTilt = (e) => {
    // gamma: izq/der (-90..90), beta: adelante/atras (-180..180)
    const gx = Math.max(-45, Math.min(45, e.gamma || 0));
    const gy = Math.max(-45, Math.min(45, (e.beta || 0) - 45));
    // Movimiento sutil: hasta ~30px en cada eje
    tilt.style.setProperty('--tx', (gx / 45 * 30).toFixed(1) + 'px');
    tilt.style.setProperty('--ty', (gy / 45 * 20).toFixed(1) + 'px');
  };

  // iOS 13+ exige permiso explicito tras un gesto del usuario.
  const necesitaPermiso = typeof DeviceOrientationEvent.requestPermission === 'function';
  if (necesitaPermiso) {
    const pedir = () => {
      DeviceOrientationEvent.requestPermission().then((estado) => {
        if (estado === 'granted') window.addEventListener('deviceorientation', onTilt);
      }).catch(() => {});
      document.body.removeEventListener('click', pedir);
    };
    // Se activa con el primer toque en la pantalla (requisito de iOS)
    document.body.addEventListener('click', pedir, { once: true });
  } else {
    window.addEventListener('deviceorientation', onTilt);
  }
}

// ── Idioma (ES/EN) ──────────────────────────────────────────────────
function aplicarIdioma() {
  document.documentElement.lang = getLang(); // sincroniza <html lang>
  const set = (id, val, attr) => {
    const el = document.querySelector(id);
    if (!el) return;
    if (attr) el.setAttribute(attr, val); else el.innerHTML = val;
  };
  set('#tagline', t('tagline'));
  set('#disclaimer', t('disclaimer'));
  set('#copyright', t('copyright'));
  set('#geoLabel', ubicacion ? t('locationActive') : t('useLocation'));
  set('#input', t('inputPlaceholder'), 'placeholder');
  const geoBtn = document.querySelector('#geoBtn'); if (geoBtn) geoBtn.title = t('useLocation');
  const voiceBtn = document.querySelector('#voiceBtn'); if (voiceBtn) voiceBtn.title = t('voiceTitle');
  const micBtn = document.querySelector('#micBtn'); if (micBtn) micBtn.title = t('micTitle');
  const planSel = document.querySelector('#planSelect option[value=""]'); if (planSel) planSel.textContent = t('planPlaceholder');
  // Interruptor tipo pastilla: ES / EN con el activo en fondo teal
  const langLabel = document.querySelector('#langLabel');
  if (langLabel) {
    const es = getLang() === 'es';
    const on = 'px-3 py-1 rounded-full bg-teal-400 text-slate-900';
    const off = 'px-3 py-1 rounded-full text-slate-400';
    langLabel.innerHTML =
      `<span class="${es ? on : off}">ES</span><span class="${!es ? on : off}">EN</span>`;
  }
}

function cambiarIdioma() {
  setLang(getLang() === 'es' ? 'en' : 'es');
  aplicarIdioma();
  // Reiniciar la conversacion en el nuevo idioma para que todo quede consistente
  historial.length = 0;
  estado = { planId: planSelect.value || '', especialidadId: '', urgencia: null };
  bannerEmergenciaMostrado = false;
  stream.innerHTML = '';
  addBot(t('greeting'));
  addChips();
}

// ── Geolocalizacion (opt-in) ────────────────────────────────────────
function pedirUbicacion() {
  const icon = document.querySelector('#geoIcon');
  const label = document.querySelector('#geoLabel');

  // Si ya la tenemos, permitir desactivarla
  if (ubicacion) {
    ubicacion = null;
    if (icon) icon.textContent = '📍';
    if (label) label.textContent = t('useLocation');
    addBot(t('geoOff'));
    return;
  }

  if (!('geolocation' in navigator)) {
    addBot(t('geoNoSupport'));
    return;
  }

  if (icon) icon.textContent = '⏳';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      ubicacion = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (icon) icon.textContent = '✅';
      if (label) label.textContent = t('locationActive');
      addBot(t('geoThanks'));
    },
    (err) => {
      if (icon) icon.textContent = '📍';
      addBot(err.code === 1 ? t('geoDenied') : t('geoError'));
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// ── Audio: leer en voz alta (TTS) ───────────────────────────────────
function toggleVoz() {
  const icon = document.querySelector('#voiceIcon');
  if (!('speechSynthesis' in window)) {
    addBot(t('voiceNoSupport'));
    return;
  }
  vozActiva = !vozActiva;
  if (icon) icon.textContent = vozActiva ? '🔊' : '🔈';
  if (!vozActiva) window.speechSynthesis.cancel();
  else addBot(t('voiceOn'));
}

function hablar(texto) {
  if (!vozActiva || !('speechSynthesis' in window) || !texto) return;
  const limpio = texto.replace(/<[^>]*>/g, '').slice(0, 400);
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(limpio);
  u.lang = getLang() === 'en' ? 'en-US' : 'es-ES';
  u.rate = 1.02;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

// ── Audio: dictar por voz (STT) ─────────────────────────────────────
function dictar() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.querySelector('#micBtn');
  if (!SR) {
    addBot(t('micNoSupport'));
    return;
  }
  if (reconociendo) return;

  const rec = new SR();
  rec.lang = getLang() === 'en' ? 'en-US' : 'es-ES';
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  reconociendo = true;
  if (micBtn) { micBtn.textContent = '🔴'; micBtn.classList.add('animate-pulse'); }

  rec.onresult = (e) => {
    const texto = e.results[0][0].transcript;
    input.value = input.value ? (input.value + ' ' + texto) : texto;
    autosize();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') addBot(t('micDenied'));
    else if (e.error === 'no-speech') addBot(t('micNoSpeech'));
  };
  rec.onend = () => {
    reconociendo = false;
    if (micBtn) { micBtn.textContent = '🎤'; micBtn.classList.remove('animate-pulse'); }
    input.focus();
  };
  try { rec.start(); } catch (_) { reconociendo = false; if (micBtn) { micBtn.textContent = '🎤'; micBtn.classList.remove('animate-pulse'); } }
}

// ── Render de burbujas ──────────────────────────────────────────────
function addUser(texto) {
  const div = document.createElement('div');
  div.className = 'flex gap-2.5 items-end justify-end fade-up';
  div.innerHTML = `
    <div class="bg-teal-400/15 border border-teal-400/20 rounded-2xl rounded-br-sm px-4 py-2.5 text-sm text-teal-50 max-w-[82%]">${escapeHtml(texto)}</div>`;
  stream.appendChild(div);
  scroll();
}

function addBot(html) {
  const div = document.createElement('div');
  div.className = 'fade-up';
  div.innerHTML = `
    <div class="flex items-center gap-2 mb-1">
      <img src="/vielsin-avatar.svg" alt="Vielsin" class="w-6 h-6 rounded-full shrink-0" />
      <span class="text-[11px] font-semibold text-teal-300/80">Vielsin</span>
    </div>
    <div class="glass rounded-2xl rounded-tl-sm px-3.5 py-3 text-sm text-slate-100 space-y-3">${html}</div>`;
  stream.appendChild(div);
  scrollAInicio(div);
  return div;
}

function addChips() {
  const wrap = document.createElement('div');
  wrap.id = 'chipsWrap';
  wrap.className = 'flex flex-wrap gap-2 fade-up';
  (t('examples') || []).forEach((ej, i) => {
    const b = document.createElement('button');
    // En movil mostramos solo los 2 primeros; los otros aparecen en pantallas grandes.
    const ocultoMovil = i >= 2 ? ' hidden sm:inline-block' : '';
    b.className = 'text-[11px] px-2.5 py-1 rounded-full bg-slate-900/70 border border-white/10 text-slate-400 hover:text-teal-300 hover:border-teal-400/40 transition' + ocultoMovil;
    b.textContent = ej;
    b.onclick = () => { input.value = ej; input.focus(); autosize(); };
    wrap.appendChild(b);
  });
  stream.appendChild(wrap);
  scroll();
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'fade-up';
  div.innerHTML = `
    <div class="flex items-center gap-2 mb-1">
      <img src="/vielsin-avatar.svg" alt="Vielsin" class="w-6 h-6 rounded-full shrink-0" />
      <span class="text-[11px] font-semibold text-teal-300/80">Vielsin</span>
    </div>
    <div class="glass rounded-2xl rounded-tl-sm px-4 py-3 text-slate-400 typing inline-block"><span>●</span><span>●</span><span>●</span></div>`;
  stream.appendChild(div);
  scroll();
  return div;
}

function scroll() { stream.scrollTop = stream.scrollHeight; }

// Lleva la vista para que el INICIO del elemento quede visible arriba del stream.
function scrollAInicio(el) {
  requestAnimationFrame(() => {
    // offsetTop del elemento relativo al contenedor scrollable
    const top = el.offsetTop - 8;
    stream.scrollTo({ top: top < 0 ? 0 : top, behavior: 'smooth' });
  });
}

// ── Envio ───────────────────────────────────────────────────────────
async function enviar() {
  const texto = input.value.trim();
  if (!texto) return;

  // Ocultar los chips de ejemplo al primer mensaje (libera espacio del chat)
  const chips = document.querySelector('#chipsWrap');
  if (chips) chips.remove();

  addUser(texto);
  historial.push({ role: 'user', content: texto });
  input.value = '';
  autosize();
  input.disabled = true; sendBtn.disabled = true;

  const typing = addTyping();

  try {
    const r = await fetch('/api/agente', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: historial, estado, ubicacion, lang: getLang() }),
    }).then((x) => x.json());

    typing.remove();

    if (r.error) { addBot(t('errGeneric')); return; }

    // Actualizar estado y sincronizar selector de plan
    estado = { planId: r.estado.planId || '', especialidadId: r.estado.especialidadId || '', urgencia: r.estado.urgencia || null };
    if (estado.planId && planSelect.value !== estado.planId) planSelect.value = estado.planId;

    // Banner de emergencia (prioridad maxima, antes de cualquier calculo)
    if (estado.urgencia === 'alta') mostrarBannerEmergencia();

    // Si la respuesta vino del fallback por reglas, intentamos darle calidez
    // usando la IA del propio dispositivo (on-device), si esta disponible.
    let responder = r.responder;
    if (r.fuente === 'reglas' && estado.especialidadId) {
      try {
        const espNombre = (r.estimacion && r.estimacion.especialidadNombre) || estado.especialidadId;
        const frase = await DeviceAI.fraseEmpatica(texto, espNombre, getLang());
        if (frase) responder = frase + (r.estimacion ? ' ' + (getLang() === 'en' ? "Here's your estimate:" : 'Aquí está tu estimado:') : '');
      } catch (_) { /* si falla, usamos el mensaje original */ }
    }

    // Mensaje del bot (+ badge de urgencia si aplica)
    let html = escapeHtml(responder);
    if (estado.urgencia) {
      const u = urgencia(estado.urgencia);
      html += `<div><span class="inline-flex items-center gap-1.5 mt-1 px-2.5 py-1 rounded-full border text-xs ${u.cls}"><span class="w-1.5 h-1.5 rounded-full ${u.dot}"></span>${u.txt}</span></div>`;
    }
    const bubble = addBot(html);
    historial.push({ role: 'assistant', content: responder });
    hablar(responder);

    // Si hubo estimacion, insertar las tarjetas dentro del chat
    if (r.estimacion) {
      estadoUltimaEsp = r.estimacion.especialidadNombre || '';
      renderEstimacion(bubble, r.estimacion);
    }
  } catch (e) {
    typing.remove();
    addBot(t('errConn'));
  } finally {
    input.disabled = false; sendBtn.disabled = false;
    input.focus();
  }
}

// ── Tarjetas de resultado (dentro de la burbuja del bot) ────────────
function renderEstimacion(bubble, est) {
  const cont = document.createElement('div');
  cont.className = 'pt-1 space-y-3';

  if (!est.cubierta) {
    cont.innerHTML = `
      <div class="rounded-2xl p-4 pop bg-rose-500/10 border border-rose-400/30">
        <p class="text-sm">${t('notCoveredMsg', escapeHtml(est.plan.nombre), est.excluida, escapeHtml(est.especialidadNombre))}</p>
      </div>
      ${tablaHospitales(est)}`;
    bubble.appendChild(cont);
    animarBarras();
    scrollAInicio(bubble);
    return;
  }

  const rec = est.recomendado;
  const pct = rec.tarifa > 0 ? Math.round((rec.cubreSeguro / rec.tarifa) * 100) : 0;
  const nota = rec.claro ? rec.claro.nota : null;

  // Desglose de como se forma el copago (transparencia)
  const desglose = [];
  if (rec.deducibleAplicado > 0) desglose.push(`${getLang() === 'en' ? 'deductible' : 'deducible'} ${money(rec.deducibleAplicado)}`);
  if (rec.coaseguro > 0) desglose.push(`${getLang() === 'en' ? 'coinsurance' : 'coaseguro'} ${est.plan.coaseguroPct}% = ${money(rec.coaseguro)}`);
  if (rec.topeAplicado) desglose.push(getLang() === 'en' ? 'copay cap applied' : 'tope de copago aplicado');
  const desgloseTxt = desglose.length ? `<p class="text-[11px] text-slate-500 mt-2">${t('howCalculated')}: ${desglose.join(' + ')}.</p>` : '';

  cont.innerHTML = `
    <div class="rounded-2xl p-3 pop bg-teal-400/10 border border-teal-400/25 flex items-center gap-3">
      <span class="text-xl">🩺</span>
      <div>
        <p class="text-[11px] text-slate-400 leading-tight">${t('specialty')}</p>
        <p class="text-base font-bold text-teal-200 leading-tight">${escapeHtml(est.especialidadNombre)}</p>
      </div>
    </div>
    <div class="rounded-2xl p-4 pop glow bg-slate-900/50 border border-white/10">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p class="text-[11px] uppercase tracking-wider text-slate-400">${t('copayBest')}</p>
          <div class="text-4xl font-extrabold grad-text">${money(rec.copago)}</div>
          <p class="text-xs text-slate-400 mt-0.5">${t('of')} ${money(rec.tarifa)} ${t('at')} <strong class="text-slate-200">${escapeHtml(rec.nombre)}</strong> · ★ ${rec.calidad.toFixed(1)}</p>
        </div>
        ${nota != null ? `<div class="text-center shrink-0">
          <div class="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">Índice CLARO</div>
          <div class="w-16 h-16 rounded-2xl bg-slate-800/80 border border-teal-400/30 flex flex-col items-center justify-center">
            <span class="text-2xl font-extrabold grad-text leading-none">${nota.toFixed(1)}</span>
            <span class="text-[9px] text-slate-500 leading-none mt-0.5">/10</span>
          </div>
        </div>` : ''}
      </div>
      <div class="mt-4">
        <div class="flex justify-between text-[11px] text-slate-400 mb-1">
          <span>${t('coversYourInsurance')} · ${money(rec.cubreSeguro)}</span>
          <span>${t('youPay')} · ${money(rec.copago)}</span>
        </div>
        <div class="h-2.5 rounded-full bg-slate-800 overflow-hidden flex">
          <div class="bar-fill h-full bg-gradient-to-r from-teal-400 to-sky-500" style="width:0%" data-w="${pct}%"></div>
          <div class="bar-fill h-full bg-slate-600" style="width:0%" data-w="${100 - pct}%"></div>
        </div>
        <p class="text-[11px] text-slate-500 mt-1">${t('planCovers', pct)}</p>
        ${desgloseTxt}
      </div>
      <div class="mt-3 pt-3 border-t border-white/10 flex flex-wrap gap-1.5">
        <button data-resumen class="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-slate-800/70 border border-white/10 text-slate-300 hover:text-teal-300 hover:border-teal-400/40 transition">${t('copySummary')}</button>
      </div>
    </div>
    ${resumenClaro(est)}
    ${comparadorPlanes(est)}
    ${tablaHospitales(est)}
    <p class="text-[10px] text-slate-600 px-1">${t('disclaimerFull')}</p>`;

  bubble.appendChild(cont);
  animarBarras();
  scrollAInicio(bubble);

  // Boton "copiar resumen para llevar"
  const btnResumen = cont.querySelector('[data-resumen]');
  if (btnResumen) {
    btnResumen.addEventListener('click', async () => {
      const texto = resumenTexto(est);
      try {
        await navigator.clipboard.writeText(texto);
        btnResumen.textContent = t('summaryCopied');
      } catch (_) {
        addBot('<pre class="whitespace-pre-wrap text-[11px] text-slate-300">' + escapeHtml(texto) + '</pre>');
      }
      setTimeout(() => { btnResumen.textContent = t('copySummary'); }, 2500);
    });
  }
}

// Texto plano del resumen que el paciente puede llevar a su consulta.
function resumenTexto(est) {
  const rec = est.recomendado;
  const en = getLang() === 'en';
  const lineas = en ? [
    'COBERTURA CLARA SUMMARY',
    '------------------------',
    `Suggested specialty: ${est.especialidadNombre}`,
    `Plan: ${est.plan.nombre}`,
    `Hospital (best balance): ${rec.nombre}`,
    `Estimated copay: ${money(rec.copago)} (from a rate of ${money(rec.tarifa)})`,
    `Insurance covers: ${money(rec.cubreSeguro)}`,
    est.masBarato ? `Cheapest option: ${est.masBarato.nombre} (${money(est.masBarato.copago)})` : '',
    '',
    'Informational guidance with sample data. Not a substitute for your',
    'policy or medical advice. The hospital confirms the appointment.',
  ] : [
    'RESUMEN COBERTURA CLARA',
    '------------------------',
    `Especialidad sugerida: ${est.especialidadNombre}`,
    `Plan: ${est.plan.nombre}`,
    `Hospital (mejor balance): ${rec.nombre}`,
    `Copago estimado: ${money(rec.copago)} (de una tarifa de ${money(rec.tarifa)})`,
    `Cubre tu seguro: ${money(rec.cubreSeguro)}`,
    est.masBarato ? `Opción más económica: ${est.masBarato.nombre} (${money(est.masBarato.copago)})` : '',
    '',
    'Orientación informativa con datos de ejemplo. No sustituye tu póliza',
    'ni el criterio médico. La cita la confirma el hospital.',
  ];
  return lineas.filter(Boolean).join('\n');
}

function notaColor(n) {
  if (n >= 8) return 'text-emerald-300';
  if (n >= 6) return 'text-amber-300';
  return 'text-slate-300';
}

// Banner de emergencia: aviso responsable, se muestra una sola vez por sesion.
let bannerEmergenciaMostrado = false;
function mostrarBannerEmergencia() {
  if (bannerEmergenciaMostrado) return;
  bannerEmergenciaMostrado = true;
  const div = document.createElement('div');
  div.className = 'fade-up rounded-2xl p-4 bg-rose-500/15 border border-rose-400/40 pop';
  div.innerHTML = `
    <div class="flex items-start gap-3">
      <span class="text-xl">🚨</span>
      <div>
        <p class="text-sm font-bold text-rose-200">${t('emergencyTitle')}</p>
        <p class="text-[12px] text-rose-100/90 mt-1">${t('emergencyBody')}</p>
      </div>
    </div>`;
  stream.appendChild(div);
  scroll();
}

// Comparador de planes: cuanto pagarias con cada plan en el hospital recomendado.
function comparadorPlanes(est) {
  const comp = est.comparadorPlanes;
  if (!comp || comp.length < 2) return '';
  const actual = est.plan.id;
  const rows = comp.map((c) => {
    const esActual = c.planId === actual;
    const valor = c.cubierta ? money(c.copago) : t('notCovered');
    return `
      <div class="flex items-center justify-between px-3 py-2 rounded-xl ${esActual ? 'bg-teal-400/10 border border-teal-400/30' : 'bg-slate-900/40 border border-white/5'}">
        <span class="text-sm ${esActual ? 'text-teal-200 font-semibold' : 'text-slate-300'}">${escapeHtml(c.planNombre)}${esActual ? ' · ' + t('yourPlan') : ''}</span>
        <span class="text-sm font-bold ${c.cubierta ? (esActual ? 'text-teal-300' : 'text-slate-200') : 'text-rose-300'}">${valor}</span>
      </div>`;
  }).join('');
  return `
    <div class="rounded-2xl p-4 bg-slate-900/50 border border-white/10">
      <p class="text-sm font-semibold text-slate-200 mb-1">${t('comparePlans')}</p>
      <p class="text-[11px] text-slate-500 mb-3">${t('comparePlansHint', escapeHtml(est.recomendado.nombre))}</p>
      <div class="space-y-1.5">${rows}</div>
    </div>`;
}

// Resumen CLARO: 3 rutas informativas segun prioridad. Lenguaje sugerente, no imperativo.
function resumenClaro(est) {
  const r = est.resumenClaro;
  if (!r) return '';
  const item = (etiqueta, nombre, detalle, icon) => `
    <div class="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-slate-900/40 border border-white/5">
      <span class="text-base leading-none mt-0.5">${icon}</span>
      <div class="min-w-0">
        <div class="text-[11px] text-slate-400">${etiqueta}</div>
        <div class="text-sm font-semibold text-slate-100 truncate">${escapeHtml(nombre)}</div>
        <div class="text-[11px] text-slate-500">${detalle}</div>
      </div>
    </div>`;
  const d = getLang() === 'en' ? 'd wait' : 'd';
  return `
    <div class="rounded-2xl p-4 bg-slate-900/50 border border-white/10">
      <p class="text-sm font-semibold text-slate-200 mb-1">${t('claroSummary')}</p>
      <p class="text-[11px] text-slate-500 mb-3">${t('claroSummaryHint')}</p>
      <div class="grid sm:grid-cols-3 gap-2">
        ${item(t('ifPrice'), r.precio.nombre, `${money(r.precio.copago)} · ~${r.precio.esperaDias}${d}`, '💰')}
        ${item(t('ifQuality'), r.calidad.nombre, `★ ${r.calidad.calidad.toFixed(1)} · ${money(r.calidad.copago)}`, '⭐')}
        ${item(t('bestBalance') + ' (CLARO ' + r.balance.nota.toFixed(1) + ')', r.balance.nombre, `${money(r.balance.copago)}`, '⚖️')}
      </div>
    </div>`;
}

// Botones de contacto por hospital (llamar / como llegar / web). Se abren en pestana nueva.
function accionesHospital(h) {
  const btns = [];
  const cls = 'inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-slate-800/70 border border-white/10 text-slate-300 hover:text-teal-300 hover:border-teal-400/40 transition';
  if (h.telefono) {
    btns.push(`<a href="tel:${escapeHtml(h.telefono.replace(/\s/g, ''))}" class="${cls}">${t('call')}</a>`);
  }
  if (h.lat != null && h.lng != null) {
    let maps;
    if (ubicacion) {
      maps = `https://www.google.com/maps/dir/?api=1&origin=${ubicacion.lat},${ubicacion.lng}&destination=${h.lat},${h.lng}&travelmode=driving`;
    } else {
      maps = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}&travelmode=driving`;
    }
    btns.push(`<a href="${maps}" target="_blank" rel="noopener" class="${cls}">${t('directions')}</a>`);
  }
  if (h.web) {
    btns.push(`<a href="${escapeHtml(h.web)}" target="_blank" rel="noopener" class="${cls}">${t('website')}</a>`);
  }
  // Solicitar cita: abre WhatsApp pre-armado. La confirmacion la hace el hospital.
  if (h.telefono) {
    const esp = estadoUltimaEsp || (getLang() === 'en' ? 'a consultation' : 'una consulta');
    const texto = t('apptMsg', esp, h.nombre);
    const tel = h.telefono.replace(/[^0-9]/g, '');
    const wa = `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
    btns.push(`<a href="${wa}" target="_blank" rel="noopener" class="${cls}">${t('requestAppt')}</a>`);
  }
  if (!btns.length) return '';
  return `<div class="flex flex-wrap gap-1.5 mt-2">${btns.join('')}</div>`;
}

function tablaHospitales(est) {
  const rows = est.hospitales.map((h, i) => {
    const esRec = est.cubierta && est.recomendado && h.id === est.recomendado.id;
    const nota = h.claro ? h.claro.nota : null;
    const etiqueta = h.claro ? h.claro.etiqueta : '';
    return `
      <div class="px-3 py-2.5 rounded-xl ${esRec ? 'bg-teal-400/10 border border-teal-400/30' : 'bg-slate-900/40 border border-white/5'} fade-up" style="animation-delay:${i * 0.05}s">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0 flex items-center gap-3">
            ${nota != null ? `<div class="shrink-0 w-11 h-11 rounded-xl bg-slate-800/80 border border-white/10 flex flex-col items-center justify-center">
              <span class="text-sm font-extrabold ${notaColor(nota)} leading-none">${nota.toFixed(1)}</span>
              <span class="text-[8px] text-slate-500 leading-none">/10</span>
            </div>` : ''}
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold text-sm text-slate-100 truncate">${escapeHtml(h.nombre)}</span>
                ${esRec ? `<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-400 text-slate-900 font-bold">${t('bestBadge')}</span>` : (nota != null ? `<span class="text-[9px] text-slate-500">${etiquetaValor(nota)}</span>` : '')}
              </div>
              <div class="text-[11px] text-slate-500">${escapeHtml(h.zona)} · ★ ${h.calidad.toFixed(1)}${h.esperaDias != null ? ' · ~' + h.esperaDias + 'd' : ''}${h.distanciaKm != null ? ' · ' + h.distanciaKm + ' km' + (h.distanciaReal ? (getLang() === 'en' ? ' from you' : ' de ti') : '') : ''}</div>
              ${h.direccion ? `<div class="text-[10px] text-slate-600 truncate">${escapeHtml(h.direccion)}</div>` : ''}
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="font-bold text-sm ${esRec ? 'text-teal-300' : 'text-slate-200'}">${money(h.copago)}</div>
            <div class="text-[10px] text-slate-500">${getLang() === 'en' ? 'rate' : 'tarifa'} ${money(h.tarifa)}</div>
          </div>
        </div>
        ${accionesHospital(h)}
      </div>`;
  }).join('');
  return `<div class="rounded-2xl p-3 bg-slate-900/30 border border-white/5">
      <p class="text-xs font-semibold text-slate-400 mb-2">${t('hospitalsTitle')}</p>
      <div class="space-y-1.5">${rows}</div>
    </div>`;
}

// Etiqueta de valor traducida segun la nota CLARO
function etiquetaValor(nota) {
  if (nota >= 8) return t('valueExcellent');
  if (nota >= 6) return t('valueGood');
  return t('valueHigh');
}

function animarBarras() {
  requestAnimationFrame(() => {
    document.querySelectorAll('.bar-fill').forEach((el) => { if (el.dataset.w) el.style.width = el.dataset.w; });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Textarea autosize + envio con Enter ─────────────────────────────
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 128) + 'px';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
});
sendBtn.addEventListener('click', enviar);

init();
