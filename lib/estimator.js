'use strict';

/**
 * Motor de estimacion (deterministico, sin IA).
 * Carga los datasets y calcula: triaje por reglas, copago segun plan,
 * y ranking de hospitales de la red por costo de bolsillo.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

const especialidadesDS = loadJSON('especialidades.json');
const planesDS = loadJSON('planes.json');
const hospitalesDS = loadJSON('hospitales.json');

// ── Normalizacion de texto (quita acentos, minusculas) ──────────────
function normalizar(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// ── Triaje por reglas (fallback si la IA no esta disponible) ────────
function triajePorReglas(sintomaTexto) {
  const t = normalizar(sintomaTexto);
  for (const regla of especialidadesDS.reglas) {
    for (const palabra of regla.palabras) {
      if (t.includes(normalizar(palabra))) {
        return { especialidad: regla.especialidad, urgencia: regla.urgencia, fuente: 'reglas' };
      }
    }
  }
  return {
    especialidad: especialidadesDS.porDefecto.especialidad,
    urgencia: especialidadesDS.porDefecto.urgencia,
    fuente: 'reglas',
  };
}

function nombreEspecialidad(id) {
  const e = especialidadesDS.especialidades.find((x) => x.id === id);
  return e ? e.nombre : id;
}

function getPlan(planId) {
  return planesDS.planes.find((p) => p.id === planId) || null;
}

function listarPlanes() {
  return planesDS.planes.map((p) => ({ id: p.id, nombre: p.nombre, coaseguroPct: p.coaseguroPct }));
}

function listarEspecialidades() {
  return especialidadesDS.especialidades;
}

/**
 * Calcula el copago del paciente para una especialidad en un hospital dado.
 * Modelo: primero se aplica el deducible anual restante, luego el coaseguro (%),
 * con un tope maximo de copago por consulta.
 */
function calcularCopago(tarifa, plan, deducibleRestante) {
  let restante = tarifa;
  let aplicadoDeducible = 0;

  if (deducibleRestante > 0) {
    aplicadoDeducible = Math.min(deducibleRestante, restante);
    restante -= aplicadoDeducible;
  }

  const coaseguro = restante * (plan.coaseguroPct / 100);
  let copagoBruto = aplicadoDeducible + coaseguro;

  // Aplicar tope de copago por consulta (proteccion al paciente)
  const topeAplicado = copagoBruto > plan.topeCopagoConsulta;
  const copago = topeAplicado ? plan.topeCopagoConsulta : copagoBruto;
  const cubreSeguro = tarifa - copago;

  return {
    copago: redondear(copago),
    cubreSeguro: redondear(cubreSeguro),
    deducibleAplicado: redondear(aplicadoDeducible),
    coaseguro: redondear(coaseguro),
    topeAplicado,
  };
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}

/** Distancia en km entre dos coordenadas (formula de Haversine). */
function distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // radio terrestre km
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
/**
 * Indice CLARO (nota de 0 a 10 por hospital). Enfoque propio que combina
 * cinco factores en una sola calificacion humana e intuitiva (ej. 8.4/10):
 *   C - Costo      (lo que pagas de tu bolsillo)      peso 40%
 *   L - Lejania    (cercania / distancia)             peso 10%
 *   A - Atencion   (calidad del hospital, estrellas)  peso 25%
 *   R - Rapidez    (dias de espera para la cita)      peso 10%
 *   O - Oportunidad(cuanto te cubre tu seguro)        peso 15%
 * Cada factor se normaliza a 0..1 respecto al rango del conjunto y se
 * pondera. El resultado se escala a 0..10.
 */
const CLARO_PESOS = { costo: 0.40, atencion: 0.25, oportunidad: 0.15, rapidez: 0.10, lejania: 0.10 };

function norm(valor, min, max, invertir) {
  const rango = max - min;
  if (rango <= 0) return 1; // todos iguales -> puntaje pleno
  const x = (valor - min) / rango;
  return invertir ? 1 - x : x; // invertir: menor es mejor (costo, distancia, espera)
}

function claroScore(h, rangos) {
  const costo = norm(h.copago, rangos.copagoMin, rangos.copagoMax, true);
  const atencion = norm(h.calidad, rangos.calidadMin, rangos.calidadMax, false);
  const oportunidad = norm(h.pctCubierto, rangos.pctMin, rangos.pctMax, false);
  const rapidez = norm(h.esperaDias, rangos.esperaMin, rangos.esperaMax, true);
  const lejania = norm(h.distanciaKm, rangos.distMin, rangos.distMax, true);

  const s01 =
    costo * CLARO_PESOS.costo +
    atencion * CLARO_PESOS.atencion +
    oportunidad * CLARO_PESOS.oportunidad +
    rapidez * CLARO_PESOS.rapidez +
    lejania * CLARO_PESOS.lejania;

  const nota = redondear(s01 * 10); // 0..10

  let etiqueta = 'Valorala';
  if (nota >= 8) etiqueta = 'Recomendada por balance';
  else if (nota >= 6) etiqueta = 'Buena opcion';

  return {
    nota,
    etiqueta,
    factores: {
      costo: Math.round(costo * 10),
      atencion: Math.round(atencion * 10),
      oportunidad: Math.round(oportunidad * 10),
      rapidez: Math.round(rapidez * 10),
      lejania: Math.round(lejania * 10),
    },
  };
}

/**
 * Estimacion completa: dado un sintoma/especialidad + plan, devuelve
 * el veredicto de cobertura y el ranking de hospitales de la red,
 * con desglose transparente (deducible + coaseguro + tope) e indice de valor.
 */
function estimar({ especialidadId, planId, deducibleRestante, ubicacion }) {
  const plan = getPlan(planId);
  if (!plan) {
    return { error: 'Plan no encontrado', planesDisponibles: listarPlanes() };
  }

  const especialidad = especialidadId || especialidadesDS.porDefecto.especialidad;
  // Deducible pendiente del paciente en el ano. Por defecto asumimos 0 (ya cubierto).
  const dedRestante = typeof deducibleRestante === 'number' ? deducibleRestante : 0;

  // Ubicacion real del usuario (opt-in). Si viene, calculamos distancia real.
  const tieneUbicacion = ubicacion && typeof ubicacion.lat === 'number' && typeof ubicacion.lng === 'number';

  const cubierta = plan.cubreEspecialidades.includes(especialidad);
  const excluida = plan.excluye.includes(especialidad);

  const resultado = {
    especialidadId: especialidad,
    especialidadNombre: nombreEspecialidad(especialidad),
    plan: {
      id: plan.id, nombre: plan.nombre, coaseguroPct: plan.coaseguroPct,
      deducibleAnual: plan.deducibleAnual, topeGastoAnual: plan.topeGastoAnual,
      carenciaDias: plan.carenciaDias,
    },
    cubierta: cubierta && !excluida,
    excluida,
    deducibleRestante: redondear(dedRestante),
    ubicacionUsada: Boolean(tieneUbicacion),
    hospitales: [],
  };

  const candidatosBase = hospitalesDS.hospitales
    .filter((h) => h.enRed && typeof h.tarifas[especialidad] === 'number')
    .map((h) => {
      const tarifa = h.tarifas[especialidad];
      // Distancia: real si el usuario compartio ubicacion, si no la simulada del dataset.
      let dist = h.distanciaKm;
      let distReal = false;
      if (tieneUbicacion && typeof h.lat === 'number' && typeof h.lng === 'number') {
        dist = redondear(distanciaKm(ubicacion.lat, ubicacion.lng, h.lat, h.lng));
        distReal = true;
      }
      const base = {
        id: h.id, nombre: h.nombre, zona: h.zona, calidad: h.calidad,
        esperaDias: h.esperaDias, distanciaKm: dist, distanciaReal: distReal, tarifa: redondear(tarifa),
        direccion: h.direccion, telefono: h.telefono, web: h.web, lat: h.lat, lng: h.lng,
      };
      if (!resultado.cubierta) {
        return { ...base, copago: redondear(tarifa), cubreSeguro: 0, deducibleAplicado: 0, coaseguro: 0, topeAplicado: false, pctCubierto: 0 };
      }
      const c = calcularCopago(tarifa, plan, dedRestante);
      const pctCubierto = tarifa > 0 ? Math.round((c.cubreSeguro / tarifa) * 100) : 0;
      return { ...base, copago: c.copago, cubreSeguro: c.cubreSeguro, deducibleAplicado: c.deducibleAplicado, coaseguro: c.coaseguro, topeAplicado: c.topeAplicado, pctCubierto };
    });

  // Calcular el Indice CLARO (0..10) con los rangos del conjunto
  if (candidatosBase.length > 0) {
    const arr = (k) => candidatosBase.map((c) => c[k]);
    const rangos = {
      copagoMin: Math.min(...arr('copago')), copagoMax: Math.max(...arr('copago')),
      calidadMin: Math.min(...arr('calidad')), calidadMax: Math.max(...arr('calidad')),
      pctMin: Math.min(...arr('pctCubierto')), pctMax: Math.max(...arr('pctCubierto')),
      esperaMin: Math.min(...arr('esperaDias')), esperaMax: Math.max(...arr('esperaDias')),
      distMin: Math.min(...arr('distanciaKm')), distMax: Math.max(...arr('distanciaKm')),
    };
    candidatosBase.forEach((c) => { c.claro = claroScore(c, rangos); });
  }

  // Ordenar por Indice CLARO (mejor primero); desempate por copago
  candidatosBase.sort((a, b) => (b.claro?.nota || 0) - (a.claro?.nota || 0) || a.copago - b.copago);
  resultado.hospitales = candidatosBase;

  if (candidatosBase.length > 0) {
    const copagos = candidatosBase.map((c) => c.copago);
    resultado.recomendado = candidatosBase[0]; // mejor Indice CLARO (balance)
    resultado.masBarato = [...candidatosBase].sort((a, b) => a.copago - b.copago)[0];
    resultado.mejorCalidad = [...candidatosBase].sort((a, b) => b.calidad - a.calidad || a.copago - b.copago)[0];
    resultado.masRapido = [...candidatosBase].sort((a, b) => a.esperaDias - b.esperaDias || a.copago - b.copago)[0];
    resultado.ahorroMaximo = redondear(Math.max(...copagos) - Math.min(...copagos));

    // Resumen CLARO: rutas informativas (no imperativas). El paciente elige.
    resultado.resumenClaro = {
      balance: { id: resultado.recomendado.id, nombre: resultado.recomendado.nombre, nota: resultado.recomendado.claro.nota, copago: resultado.recomendado.copago },
      precio: { id: resultado.masBarato.id, nombre: resultado.masBarato.nombre, copago: resultado.masBarato.copago, esperaDias: resultado.masBarato.esperaDias },
      calidad: { id: resultado.mejorCalidad.id, nombre: resultado.mejorCalidad.nombre, calidad: resultado.mejorCalidad.calidad, copago: resultado.mejorCalidad.copago },
    };

    // Comparador de planes: cuanto pagaria en el hospital recomendado con CADA plan.
    resultado.comparadorPlanes = compararPlanes(especialidad, resultado.recomendado.id);
  }

  return resultado;
}

/**
 * Para una especialidad y un hospital dados, calcula el copago con cada plan.
 * Sirve para mostrar el valor de mejorar de plan (upsell responsable).
 */
function compararPlanes(especialidad, hospitalId) {
  const hosp = hospitalesDS.hospitales.find((h) => h.id === hospitalId);
  if (!hosp) return [];
  const tarifa = hosp.tarifas[especialidad];
  if (typeof tarifa !== 'number') return [];

  return planesDS.planes.map((p) => {
    const cubre = p.cubreEspecialidades.includes(especialidad) && !p.excluye.includes(especialidad);
    if (!cubre) {
      return { planId: p.id, planNombre: p.nombre, cubierta: false, copago: null };
    }
    const c = calcularCopago(tarifa, p, 0);
    return { planId: p.id, planNombre: p.nombre, cubierta: true, copago: c.copago };
  });
}

/**
 * Intenta detectar un plan mencionado en texto libre.
 * Reconoce por nombre ("premium", "plus", "esencial") o por ID.
 */
function detectarPlan(texto) {
  const t = normalizar(texto);
  for (const p of planesDS.planes) {
    const nombreCorto = normalizar(p.nombre.replace(/plan/i, '').trim()); // "premium", "plus", "esencial"
    if (t.includes(normalizar(p.id)) || (nombreCorto && t.includes(nombreCorto))) {
      return p.id;
    }
  }
  return null;
}

/** ¿El texto contiene algun sintoma reconocible por reglas? */
function contieneSintoma(texto) {
  const t = normalizar(texto);
  for (const regla of especialidadesDS.reglas) {
    for (const palabra of regla.palabras) {
      if (t.includes(normalizar(palabra))) return true;
    }
  }
  return false;
}

module.exports = {
  triajePorReglas,
  nombreEspecialidad,
  listarPlanes,
  listarEspecialidades,
  estimar,
  normalizar,
  detectarPlan,
  contieneSintoma,
  _datasets: { especialidadesDS, planesDS, hospitalesDS },
};
