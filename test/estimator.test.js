'use strict';

/**
 * Suite de tests de la logica de Cobertura Clara (asistente Vielsin).
 * Usa el runner nativo de Node (node:test), sin dependencias externas.
 * Ejecutar: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert');
const est = require('../lib/estimator');

// ── Triaje: base de conocimiento ────────────────────────────────────
test('triaje: dolor de pecho -> cardiologia, urgencia alta', () => {
  const t = est.triajePorReglas('me duele el pecho al respirar');
  assert.strictEqual(t.especialidad, 'cardiologia');
  assert.strictEqual(t.urgencia, 'alta');
});

test('triaje: ansiedad -> psiquiatria', () => {
  const t = est.triajePorReglas('tengo ansiedad e insomnio');
  assert.strictEqual(t.especialidad, 'psiquiatria');
});

test('triaje: sintoma desconocido -> medicina_general (default)', () => {
  const t = est.triajePorReglas('quiero saber algo muy raro xyz123');
  assert.strictEqual(t.especialidad, 'medicina_general');
});

// ── Tolerancia a faltas de ortografia ───────────────────────────────
test('faltas: "pechoo" (repetida) sigue siendo cardiologia', () => {
  assert.strictEqual(est.triajePorReglas('me duele el pechoo').especialidad, 'cardiologia');
});

test('faltas: "orinaar" -> urologia', () => {
  assert.strictEqual(est.triajePorReglas('me arde al orinaar').especialidad, 'urologia');
});

test('faltas: "cavesa" (cabeza) -> neurologia', () => {
  assert.strictEqual(est.triajePorReglas('dolor de cavesa fuerte').especialidad, 'neurologia');
});

// ── Deteccion de plan en texto libre ────────────────────────────────
test('detectarPlan: "tengo plan premium" -> PLAN-PREMIUM', () => {
  assert.strictEqual(est.detectarPlan('yo tengo el plan premium'), 'PLAN-PREMIUM');
});

test('detectarPlan: sin plan -> null', () => {
  assert.strictEqual(est.detectarPlan('me duele la cabeza'), null);
});

// ── Calculo de copago y cobertura ───────────────────────────────────
test('estimar: cardiologia + Plus da cobertura y hospitales', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-PLUS' });
  assert.strictEqual(e.cubierta, true);
  assert.ok(e.hospitales.length > 0, 'debe haber hospitales en red');
  assert.ok(e.recomendado, 'debe haber recomendado');
});

test('estimar: copago nunca supera la tarifa', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-ESENCIAL' });
  for (const h of e.hospitales) {
    assert.ok(h.copago <= h.tarifa, `copago ${h.copago} no debe superar tarifa ${h.tarifa}`);
    assert.ok(h.copago >= 0, 'copago no debe ser negativo');
  }
});

test('estimar: Premium (coaseguro 10%) paga menos que Esencial (30%)', () => {
  const prem = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-PREMIUM' });
  const esen = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-ESENCIAL' });
  assert.ok(prem.recomendado.copago < esen.recomendado.copago, 'Premium debe costar menos');
});

test('estimar: cubreSeguro + copago = tarifa', () => {
  const e = est.estimar({ especialidadId: 'neumologia', planId: 'PLAN-PLUS' });
  for (const h of e.hospitales) {
    assert.ok(Math.abs((h.cubreSeguro + h.copago) - h.tarifa) < 0.02, 'la suma debe cuadrar');
  }
});

// ── Exclusiones de cobertura ────────────────────────────────────────
test('estimar: psiquiatria excluida en Esencial', () => {
  const e = est.estimar({ especialidadId: 'psiquiatria', planId: 'PLAN-ESENCIAL' });
  assert.strictEqual(e.cubierta, false);
  assert.strictEqual(e.excluida, true);
});

test('estimar: psiquiatria SI cubierta en Premium', () => {
  const e = est.estimar({ especialidadId: 'psiquiatria', planId: 'PLAN-PREMIUM' });
  assert.strictEqual(e.cubierta, true);
});

// ── Plan invalido ───────────────────────────────────────────────────
test('estimar: plan inexistente devuelve error', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-FANTASMA' });
  assert.ok(e.error, 'debe devolver error');
});

// ── Indice CLARO ────────────────────────────────────────────────────
test('CLARO: cada hospital tiene nota entre 0 y 10', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-PLUS' });
  for (const h of e.hospitales) {
    assert.ok(h.claro, 'debe tener objeto claro');
    assert.ok(h.claro.nota >= 0 && h.claro.nota <= 10, `nota ${h.claro.nota} fuera de rango`);
  }
});

test('CLARO: el recomendado tiene la nota mas alta', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-PLUS' });
  const maxNota = Math.max(...e.hospitales.map((h) => h.claro.nota));
  assert.strictEqual(e.recomendado.claro.nota, maxNota);
});

// ── Geolocalizacion (distancia real reordena) ───────────────────────
test('geo: con ubicacion se calcula distancia real y se marca', () => {
  const e = est.estimar({
    especialidadId: 'cardiologia', planId: 'PLAN-PLUS',
    ubicacion: { lat: 8.88, lng: -79.78 }, // cerca de La Chorrera
  });
  assert.strictEqual(e.ubicacionUsada, true);
  const bienestar = e.hospitales.find((h) => h.id === 'HOSP-BIENESTAR');
  assert.ok(bienestar.distanciaReal, 'la distancia debe ser real');
  assert.ok(bienestar.distanciaKm < 5, 'Bienestar debe quedar muy cerca (<5km)');
});

test('geo: sin ubicacion usa distancias del dataset', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-PLUS' });
  assert.strictEqual(e.ubicacionUsada, false);
});

// ── Comparador de planes ────────────────────────────────────────────
test('comparador: incluye los 3 planes', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-ESENCIAL' });
  assert.strictEqual(e.comparadorPlanes.length, 3);
});

// ── Datos de contacto de hospitales ─────────────────────────────────
test('contacto: hospitales traen telefono y coordenadas', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-PLUS' });
  for (const h of e.hospitales) {
    assert.ok(h.telefono, 'debe tener telefono');
    assert.ok(typeof h.lat === 'number' && typeof h.lng === 'number', 'debe tener coordenadas');
  }
});

// ── Resumen CLARO ───────────────────────────────────────────────────
test('resumen CLARO: 3 rutas (precio, calidad, balance)', () => {
  const e = est.estimar({ especialidadId: 'cardiologia', planId: 'PLAN-PLUS' });
  assert.ok(e.resumenClaro.precio, 'ruta precio');
  assert.ok(e.resumenClaro.calidad, 'ruta calidad');
  assert.ok(e.resumenClaro.balance, 'ruta balance');
});

// ── Base de conocimiento ────────────────────────────────────────────
test('base de conocimiento: al menos 12 afecciones', () => {
  assert.ok(est.listarAfecciones().length >= 12);
});
