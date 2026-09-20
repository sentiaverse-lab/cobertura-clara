'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const estimator = require('./lib/estimator');
const ai = require('./lib/ai');
const security = require('./lib/security');

const app = express();
// Puerto propio del proyecto. En despliegue (Cloud Run/Render) se respeta process.env.PORT.
const PORT = process.env.PORT || 4700;

app.disable('x-powered-by');            // no revelar Express
app.use(security.securityHeaders);      // headers de seguridad + CSP
// CORS acotable por env (por defecto abierto para la demo publica).
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '32kb' })); // payloads pequenos: el chat no necesita mas
app.use(express.static(path.join(__dirname, 'public')));

// Manejar JSON malformado sin tumbar el server
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalido.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Solicitud demasiado grande.' });
  }
  next(err);
});

// ── Salud ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, iaHabilitada: ai.IA_HABILITADA, ts: Date.now() });
});

// ── Metadatos ───────────────────────────────────────────────────────
app.get('/api/meta', (_req, res) => {
  res.json({
    planes: estimator.listarPlanes(),
    especialidades: estimator.listarEspecialidades(),
  });
});

// ── Agente conversacional ───────────────────────────────────────────
// Body: { messages: [{role,content}...], estado: { planId, especialidadId } }
// Devuelve: { responder, estado:{planId,especialidadId,urgencia}, estimacion|null, fuente }
app.post('/api/agente', security.rateLimit, async (req, res) => {
  // Validar y sanitizar toda la entrada (anti prompt-injection, XSS, payloads)
  const v = security.validarEntradaAgente(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { messages, estado, ubicacion } = v;
  const lang = req.body.lang === 'en' ? 'en' : 'es';

  const ctx = { planId: estado?.planId || null, especialidadId: estado?.especialidadId || null, lang };
  const ultimoUsuario = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  // 1) Intentar con el agente de IA
  let decision = await ai.agente(messages, ctx);

  // 2) Fallback conversacional por reglas
  if (!decision) {
    decision = agenteReglas(ultimoUsuario, ctx);
  }

  // 2b) Salvaguarda de idioma: si la IA respondio en el idioma equivocado,
  // reemplazamos por el mensaje del fallback (que respeta el idioma).
  if (decision.fuente === 'ia' && idiomaEquivocado(decision.responder, lang)) {
    const fb = agenteReglas(ultimoUsuario, ctx);
    decision.responder = fb.responder;
  }

  // Actualizar estado con lo que el agente dedujo
  const nuevoEstado = {
    planId: decision.planId || ctx.planId,
    especialidadId: decision.especialidadId || ctx.especialidadId,
    urgencia: decision.urgencia || null,
  };

  // 3) Estimar si tenemos plan + especialidad Y corresponde estimar.
  // Salvaguarda para la IA: si trae plan+especialidad pero olvido poner "estimar",
  // pero SOLO cuando el usuario aporto info nueva en este turno (evita repetir la
  // estimacion ante "gracias", "ok", etc.).
  const infoNuevaEsteTurno = Boolean(
    estimator.detectarPlan(ultimoUsuario) || estimator.contieneSintoma(ultimoUsuario)
  );
  const debeEstimar =
    (decision.estimar || infoNuevaEsteTurno) &&
    nuevoEstado.planId && nuevoEstado.especialidadId;

  let estimacion = null;
  if (debeEstimar) {
    estimacion = estimator.estimar({
      especialidadId: nuevoEstado.especialidadId,
      planId: nuevoEstado.planId,
      ubicacion,
    });
    // Mensaje que deja clara la especialidad (solo si la IA no habia decidido estimar).
    if (estimacion && !estimacion.error && !decision.estimar) {
      const espNombre = estimator.nombreEspecialidad(nuevoEstado.especialidadId);
      if (lang === 'en') {
        const urg = nuevoEstado.urgencia === 'alta' ? ' If symptoms are intense or sudden, go to the ER.' : '';
        decision.responder = `Based on what you tell me, you could consider seeing a ${espNombre} specialist. With your ${estimacion.plan.nombre}, this is what you\'d pay:${urg}`;
      } else {
        const urg = nuevoEstado.urgencia === 'alta' ? ' Si los síntomas son intensos o repentinos, acude a urgencias.' : '';
        decision.responder = `Por lo que me cuentas, podrías considerar una consulta con un especialista en ${espNombre}. Con tu ${estimacion.plan.nombre}, esto es lo que pagarías:${urg}`;
      }
    }
  }

  res.json({
    responder: decision.responder,
    estado: nuevoEstado,
    estimacion,
    fuente: decision.fuente,
  });
});

// Detecta si el texto NO esta en el idioma esperado (heuristica simple por palabras comunes).
function idiomaEquivocado(texto, lang) {
  if (!texto) return false;
  const t = ' ' + texto.toLowerCase() + ' ';
  const marcadoresEs = [' que ', ' con ', ' tu ', ' el ', ' la ', ' de ', ' para ', ' es ', ' y ', ' lamento ', ' podrias ', ' seguro '];
  const marcadoresEn = [' the ', ' your ', ' with ', ' for ', ' you ', ' and ', ' to ', ' is ', ' sorry ', ' could ', ' insurance '];
  const hitsEs = marcadoresEs.filter((m) => t.includes(m)).length;
  const hitsEn = marcadoresEn.filter((m) => t.includes(m)).length;
  if (lang === 'en') return hitsEs > hitsEn; // esperabamos ingles pero parece espanol
  return hitsEn > hitsEs;                     // esperabamos espanol pero parece ingles
}

// ── Fallback conversacional determinístico (sin IA) ─────────────────
function agenteReglas(textoUsuario, ctx) {
  // ¿Que informacion NUEVA trae este mensaje?
  const planNuevo = estimator.detectarPlan(textoUsuario);            // plan mencionado ahora
  const tieneSintomaTexto = estimator.contieneSintoma(textoUsuario); // sintoma mencionado ahora

  const planDetectado = planNuevo || ctx.planId;

  // Especialidad: si hay sintoma nuevo, re-triaje; si no, mantener la del contexto.
  let especialidadId = ctx.especialidadId;
  let urgencia = null;
  let orientacion = '';
  if (tieneSintomaTexto) {
    const t = estimator.triajePorReglas(textoUsuario);
    especialidadId = t.especialidad;
    urgencia = t.urgencia;
    orientacion = t.orientacion || '';
  }

  const yaTeniamosTodo = Boolean(ctx.planId && ctx.especialidadId);
  const hayInfoNueva = Boolean(planNuevo || tieneSintomaTexto);

  const en = ctx.lang === 'en';

  // CASO A: falta todo -> saludo/guia
  if (!especialidadId && !planDetectado) {
    return { responder: en
      ? 'Hi 👋 I\'m Vielsin. Tell me what you feel and your plan (Esencial, Plus or Premium) to estimate your copay.'
      : 'Hola 👋 Soy Vielsin. Cuéntame qué sientes y dime tu plan (Esencial, Plus o Premium) para calcular tu copago.',
      planId: planDetectado, especialidadId, urgencia, estimar: false, fuente: 'reglas' };
  }

  // CASO B: hay plan pero no sabemos el sintoma -> preguntar sintoma
  if (!especialidadId) {
    return { responder: en
      ? 'Tell me, what symptom or discomfort do you have? That way I can guide you to the right specialty.'
      : 'Cuéntame, ¿qué síntoma o molestia tienes? Así te oriento a la especialidad correcta.',
      planId: planDetectado, especialidadId, urgencia, estimar: false, fuente: 'reglas' };
  }

  // CASO C: hay sintoma pero falta plan -> preguntar plan (una sola vez)
  if (!planDetectado) {
    const nombreEsp = estimator.nombreEspecialidad(especialidadId);
    const orient = orientacion ? ` ${orientacion}` : '';
    return { responder: en
      ? `Based on what you say, you could consider seeing ${nombreEsp}.${orient} What\'s your plan: Esencial, Plus or Premium?`
      : `Por lo que cuentas, podrías considerar una consulta con ${nombreEsp}.${orient} ¿Cuál es tu plan: Esencial, Plus o Premium?`,
      planId: null, especialidadId, urgencia, estimar: false, fuente: 'reglas' };
  }

  // CASO D: ya teniamos plan + especialidad y el usuario NO aporto info nueva
  if (yaTeniamosTodo && !hayInfoNueva) {
    return {
      responder: en
        ? 'I\'m here 🙂 You can ask me about another plan (e.g. "what about Premium?"), tell me another symptom, or check the hospital options above.'
        : 'Sigo aquí 🙂 Puedes preguntarme por otro plan (ej. "¿y en Premium?"), contarme otro síntoma, o revisar las opciones de hospital de arriba.',
      planId: planDetectado, especialidadId, urgencia, estimar: false, fuente: 'reglas',
    };
  }

  // CASO E: tenemos plan + especialidad y hay info nueva -> estimar
  const nombreEsp = estimator.nombreEspecialidad(especialidadId);
  const responder = en
    ? `Based on what you tell me, you could consider seeing ${nombreEsp}. With your plan, this is what you\'d pay:${urgencia === 'alta' ? ' If symptoms are intense or sudden, go to the ER.' : ''}`
    : `Por lo que me cuentas, podrías considerar una consulta con ${nombreEsp}. Con tu plan, esto es lo que pagarías:${urgencia === 'alta' ? ' Si los síntomas son intensos o repentinos, acude a urgencias.' : ''}`;
  return {
    responder,
    planId: planDetectado,
    especialidadId,
    urgencia,
    estimar: true,
    fuente: 'reglas',
  };
}

// ── Estimacion directa (usada por el frontend si cambia el plan) ────
app.post('/api/estimate', security.rateLimit, (req, res) => {
  const { especialidadId, planId, deducibleRestante, ubicacion } = req.body || {};
  if (!planId || typeof planId !== 'string') return res.status(400).json({ error: 'Falta "planId".' });
  const resultado = estimator.estimar({ especialidadId, planId, deducibleRestante, ubicacion });
  if (resultado.error) return res.status(400).json(resultado);
  res.json(resultado);
});

// ── Fallback SPA ────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Cobertura Clara escuchando en http://localhost:${PORT}`);
  console.log(`IA ${ai.IA_HABILITADA ? 'HABILITADA' : 'en modo reglas (sin IA configurada)'}`);
});
