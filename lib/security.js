'use strict';

/**
 * Capa de seguridad para la ventana del chat publico.
 * Sin dependencias externas: rate limiting en memoria + validacion de entrada.
 * Objetivo: evitar abuso de las keys de IA, prompt injection basico,
 * payloads gigantes y contenido malicioso.
 */

// ── Rate limiting por IP (ventana deslizante en memoria) ────────────
const HITS = new Map(); // ip -> [timestamps]
const VENTANA_MS = 60 * 1000;          // 1 minuto
const MAX_POR_VENTANA = Number(process.env.RATE_LIMIT_PER_MIN) || 20; // 20 req/min por IP
const MAX_MENSAJE_CHARS = 800;          // longitud maxima de un mensaje del usuario
const MAX_MENSAJES = 40;                // maximo de mensajes en el historial

// Limpieza periodica para no crecer en memoria
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, ts] of HITS.entries()) {
    const vivos = ts.filter((t) => ahora - t < VENTANA_MS);
    if (vivos.length === 0) HITS.delete(ip);
    else HITS.set(ip, vivos);
  }
}, VENTANA_MS).unref?.();

function ipDe(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconocida';
}

/** Middleware Express: limita peticiones por IP. */
function rateLimit(req, res, next) {
  const ip = ipDe(req);
  const ahora = Date.now();
  const ts = (HITS.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  if (ts.length >= MAX_POR_VENTANA) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.' });
  }
  ts.push(ahora);
  HITS.set(ip, ts);
  next();
}

/** Headers de seguridad basicos. */
function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-XSS-Protection', '0');
  // CSP: permite Tailwind CDN y fuentes de Google; nada de scripts inline externos raros.
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdn.tailwindcss.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self'"
  );
  next();
}

/**
 * Valida y sanitiza el cuerpo del endpoint /api/agente.
 * Devuelve { ok, error?, messages?, estado?, ubicacion? }.
 */
function validarEntradaAgente(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Cuerpo invalido.' };

  const { messages, estado, ubicacion } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'Falta "messages".' };
  }
  if (messages.length > MAX_MENSAJES) {
    return { ok: false, error: 'Conversacion demasiado larga.' };
  }

  // Sanitizar cada mensaje: rol permitido, contenido string, longitud acotada.
  const limpios = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content = typeof m.content === 'string' ? m.content : '';
    content = sanitizarTexto(content).slice(0, MAX_MENSAJE_CHARS);
    if (content) limpios.push({ role, content });
  }
  if (limpios.length === 0) return { ok: false, error: 'Mensaje vacio.' };

  // Estado: solo strings cortos y seguros
  const estadoLimpio = {
    planId: typeof estado?.planId === 'string' ? estado.planId.slice(0, 40).replace(/[^A-Z0-9\-_]/gi, '') : '',
    especialidadId: typeof estado?.especialidadId === 'string' ? estado.especialidadId.slice(0, 40).replace(/[^a-z0-9_]/gi, '') : '',
  };

  // Ubicacion: solo numeros en rango valido
  let ubicLimpia = null;
  if (ubicacion && typeof ubicacion.lat === 'number' && typeof ubicacion.lng === 'number' &&
      Math.abs(ubicacion.lat) <= 90 && Math.abs(ubicacion.lng) <= 180) {
    ubicLimpia = { lat: ubicacion.lat, lng: ubicacion.lng };
  }

  return { ok: true, messages: limpios, estado: estadoLimpio, ubicacion: ubicLimpia };
}

/** Quita caracteres de control y neutraliza HTML. */
function sanitizarTexto(s) {
  return String(s)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')   // caracteres de control
    .replace(/[<>]/g, ' ')                       // evita etiquetas HTML en el prompt/salida
    .trim();
}

module.exports = { rateLimit, securityHeaders, validarEntradaAgente, sanitizarTexto };
