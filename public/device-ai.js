'use strict';

/**
 * IA del dispositivo (on-device) via la Prompt API del navegador.
 * Usa el modelo que vive en el propio telefono/PC (ej. Gemini Nano en Chrome).
 * Es OPCIONAL: si el dispositivo no la soporta, todo sigue funcionando sin ella.
 *
 * Ventaja: privacidad total (los sintomas no salen del dispositivo) y funciona
 * sin internet. Se usa como capa de respaldo, nunca como pieza critica.
 */

const DeviceAI = (() => {
  let sesion = null;
  let disponible = null; // null = sin verificar, true/false = resultado

  // Detecta la Prompt API (varios nombres segun version de Chrome).
  function apiRef() {
    if (typeof window === 'undefined') return null;
    if (window.LanguageModel) return window.LanguageModel;         // Chrome reciente
    if (window.ai && window.ai.languageModel) return window.ai.languageModel; // variante
    return null;
  }

  async function comprobar() {
    if (disponible !== null) return disponible;
    const api = apiRef();
    if (!api) { disponible = false; return false; }
    try {
      const status = api.availability ? await api.availability() : (await api.capabilities?.())?.available;
      disponible = status === 'available' || status === 'readily' || status === 'downloadable' || status === 'after-download';
    } catch (_) {
      disponible = false;
    }
    return disponible;
  }

  async function sesionActiva(systemPrompt) {
    const api = apiRef();
    if (!api) return null;
    if (sesion) return sesion;
    try {
      sesion = await (api.create
        ? api.create({ initialPrompts: systemPrompt ? [{ role: 'system', content: systemPrompt }] : undefined })
        : null);
      return sesion;
    } catch (_) {
      return null;
    }
  }

  /**
   * Genera un breve mensaje empatico on-device para acompanar el resultado.
   * Devuelve string o null si no esta disponible / falla.
   */
  async function fraseEmpatica(sintoma, especialidad, lang) {
    if (!(await comprobar())) return null;
    const sys = lang === 'en'
      ? 'You are a warm health assistant. In ONE short empathetic sentence, acknowledge the patient feeling and mention they could see the given specialty. No diagnosis. English only.'
      : 'Eres un asistente de salud calido. En UNA frase corta y empatica, reconoce como se siente el paciente y menciona que podria ver la especialidad indicada. Sin diagnostico. Solo espanol.';
    const s = await sesionActiva(sys);
    if (!s) return null;
    try {
      const prompt = lang === 'en'
        ? `Symptom: "${sintoma}". Specialty: ${especialidad}.`
        : `Sintoma: "${sintoma}". Especialidad: ${especialidad}.`;
      const out = await s.prompt(prompt);
      return typeof out === 'string' ? out.trim().slice(0, 240) : null;
    } catch (_) {
      return null;
    }
  }

  return { comprobar, fraseEmpatica };
})();
