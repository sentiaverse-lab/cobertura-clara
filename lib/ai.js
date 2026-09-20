'use strict';

/**
 * Agente conversacional de IA (compatible con la API de OpenAI).
 * Mantiene una conversacion real: entiende el sintoma y el plan del contexto,
 * y cuando tiene lo necesario decide ejecutar la herramienta de estimacion.
 *
 * El modelo responde SIEMPRE con un JSON de accion:
 *   { "responder": "<texto para el usuario>",
 *     "especialidadId": "<id|null>",
 *     "planId": "<id|null>",
 *     "urgencia": "baja|media|alta|null",
 *     "estimar": true|false }
 *
 * Si no hay IA disponible o falla, el llamador usa el motor de reglas.
 */

const estimator = require('./estimator');

const AI_BASE_URL = (process.env.AI_BASE_URL || '').replace(/\/$/, '');
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

const IA_HABILITADA = Boolean(AI_BASE_URL && AI_API_KEY);

function listaEspecialidades() {
  return estimator.listarEspecialidades().map((e) => `${e.id}=${e.nombre}`).join(', ');
}
function listaPlanes() {
  return estimator.listarPlanes().map((p) => `${p.id}=${p.nombre}`).join(', ');
}

function systemPrompt() {
  return [
    'Eres "Vielsin", el asistente conversacional de salud de la plataforma Cobertura Clara.',
    'Ayudas al paciente a saber, ANTES de atenderse, cuanto pagaria de su bolsillo (copago) y que hospital de su red le conviene mas.',
    'Conversas de forma calida, breve y natural. NO das diagnosticos ni tratamientos: solo orientas la especialidad y el costo.',
    '',
    'Necesitas dos datos para estimar: (1) el sintoma del paciente y (2) su plan de seguro.',
    `Planes validos (usa el ID exacto): ${listaPlanes()}.`,
    `Especialidades validas (usa el ID exacto): ${listaEspecialidades()}.`,
    '',
    'REGLAS DE CONVERSACION:',
    '- Si falta el plan, preguntalo de forma amable (puedes mencionar los planes disponibles por su nombre).',
    '- Si falta el sintoma, preguntale que siente.',
    '- Cuando ya tengas sintoma Y plan, deduce la especialidad y pon "estimar": true para calcular el copago.',
    '- Si el usuario hace una pregunta de seguimiento (ej. "y en otro plan?", "por que tan caro?", "hay uno mas cerca?"), responde usando el contexto y vuelve a estimar si cambia el plan o la especialidad.',
    '- Si detectas una posible emergencia grave (dolor de pecho intenso, dificultad severa para respirar, perdida de conciencia), pon urgencia "alta" y en "responder" recomienda acudir a emergencias de inmediato.',
    '',
    'FORMATO DE RESPUESTA: responde EXCLUSIVAMENTE con un objeto JSON valido, sin texto extra, con esta forma exacta:',
    '{"responder": string, "especialidadId": string|null, "planId": string|null, "urgencia": "baja"|"media"|"alta"|null, "estimar": boolean}',
    'El campo "responder" es lo que le dices al paciente en lenguaje natural. Nunca incluyas cifras de copago inventadas en "responder": esas las calcula el sistema.',
  ].join('\n');
}

/**
 * Turno del agente conversacional.
 * @param {Array<{role,content}>} historial - mensajes previos (user/assistant)
 * @param {{planId?:string, especialidadId?:string}} estado - contexto conocido
 * @returns {Promise<null | {responder, especialidadId, planId, urgencia, estimar}>}
 */
async function agente(historial, estado = {}) {
  if (!IA_HABILITADA) return null;

  const contexto = `Contexto conocido: planId=${estado.planId || 'null'}, especialidadId=${estado.especialidadId || 'null'}.`;

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'system', content: contexto },
    ...historial.slice(-10),
  ];

  try {
    const resp = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.4, max_tokens: 400 }),
      signal: AbortSignal.timeout(28000),
    });
    if (!resp.ok) {
      console.warn('[ai] respuesta no OK:', resp.status);
      return null;
    }
    const data = await resp.json();
    const texto = data?.choices?.[0]?.message?.content || '';
    const parsed = extraerJSON(texto);
    if (!parsed || typeof parsed.responder !== 'string') return null;

    // Normalizar y validar
    const espValida = parsed.especialidadId && estimator.listarEspecialidades().some((e) => e.id === parsed.especialidadId);
    const planValido = parsed.planId && estimator.listarPlanes().some((p) => p.id === parsed.planId);

    return {
      responder: parsed.responder,
      especialidadId: espValida ? parsed.especialidadId : null,
      planId: planValido ? parsed.planId : null,
      urgencia: ['baja', 'media', 'alta'].includes(parsed.urgencia) ? parsed.urgencia : null,
      estimar: Boolean(parsed.estimar),
      fuente: 'ia',
    };
  } catch (err) {
    console.warn('[ai] error al llamar al modelo:', err.message);
    return null;
  }
}

/** Extrae el primer objeto JSON de un texto (tolera code fences). */
function extraerJSON(texto) {
  if (!texto) return null;
  const limpio = texto.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(limpio);
  } catch (_) {
    const m = limpio.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }
    return null;
  }
}

module.exports = { agente, IA_HABILITADA };
