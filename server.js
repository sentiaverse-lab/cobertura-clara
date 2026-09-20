'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const estimator = require('./lib/estimator');
const ai = require('./lib/ai');

const app = express();
// Puerto propio del proyecto. En despliegue (Cloud Run/Render) se respeta process.env.PORT.
const PORT = process.env.PORT || 4700;

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
app.post('/api/agente', async (req, res) => {
  const { messages, estado, ubicacion } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Falta "messages" (array no vacio).' });
  }

  const ctx = { planId: estado?.planId || null, especialidadId: estado?.especialidadId || null };
  const ultimoUsuario = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  // 1) Intentar con el agente de IA
  let decision = await ai.agente(messages, ctx);

  // 2) Fallback conversacional por reglas
  if (!decision) {
    decision = agenteReglas(ultimoUsuario, ctx);
  }

  // Actualizar estado con lo que el agente dedujo
  const nuevoEstado = {
    planId: decision.planId || ctx.planId,
    especialidadId: decision.especialidadId || ctx.especialidadId,
    urgencia: decision.urgencia || null,
  };

  // 3) Si el agente pide estimar y tenemos plan + especialidad, calcular
  let estimacion = null;
  if (decision.estimar && nuevoEstado.planId && nuevoEstado.especialidadId) {
    estimacion = estimator.estimar({
      especialidadId: nuevoEstado.especialidadId,
      planId: nuevoEstado.planId,
      ubicacion,
    });
  }

  res.json({
    responder: decision.responder,
    estado: nuevoEstado,
    estimacion,
    fuente: decision.fuente,
  });
});

// ── Fallback conversacional determinístico (sin IA) ─────────────────
function agenteReglas(textoUsuario, ctx) {
  const planDetectado = estimator.detectarPlan(textoUsuario) || ctx.planId;
  const tieneSintomaTexto = estimator.contieneSintoma(textoUsuario);

  let especialidadId = ctx.especialidadId;
  let urgencia = null;
  if (tieneSintomaTexto) {
    const t = estimator.triajePorReglas(textoUsuario);
    especialidadId = t.especialidad;
    urgencia = t.urgencia;
  }

  // Decidir el mensaje segun lo que falte
  if (!especialidadId && !tieneSintomaTexto && !planDetectado) {
    return { responder: 'Hola 👋 Soy Vielsin. Cuentame que sientes y dime tu plan (Esencial, Plus o Premium) para calcular tu copago.', planId: planDetectado, especialidadId, urgencia, estimar: false, fuente: 'reglas' };
  }
  if (!especialidadId) {
    return { responder: 'Entiendo. ¿Que sintoma o molestia tienes? Asi te oriento a la especialidad correcta.', planId: planDetectado, especialidadId, urgencia, estimar: false, fuente: 'reglas' };
  }
  if (!planDetectado) {
    const nombreEsp = estimator.nombreEspecialidad(especialidadId);
    return { responder: `Por lo que cuentas, lo indicado seria ${nombreEsp}. ¿Cual es tu plan: Esencial, Plus o Premium?`, planId: null, especialidadId, urgencia, estimar: false, fuente: 'reglas' };
  }

  // Tenemos ambos: estimar
  const nombreEsp = estimator.nombreEspecialidad(especialidadId);
  const msgUrg = urgencia === 'alta' ? ' Si los sintomas son intensos o repentinos, acude a emergencias.' : '';
  return {
    responder: `Listo. Para ${nombreEsp}, esto es lo que pagarias con tu plan.${msgUrg}`,
    planId: planDetectado,
    especialidadId,
    urgencia,
    estimar: true,
    fuente: 'reglas',
  };
}

// ── Estimacion directa (usada por el frontend si cambia el plan) ────
app.post('/api/estimate', (req, res) => {
  const { especialidadId, planId, deducibleRestante, ubicacion } = req.body || {};
  if (!planId) return res.status(400).json({ error: 'Falta "planId".' });
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
