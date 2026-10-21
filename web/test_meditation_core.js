/**
 * test_meditation_core.js
 * Tests unitarios con node:test para web/meditation-core.js (temporizador de meditación).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./meditation-core.js');

const T0 = 1_700_000_000_000;
const MIN = 60000;

test('MeditationCore - Temporizador de meditación', async (t) => {

  await t.test('1. Duraciones 5, 10, 15 y 20 min; una duración inválida cae en 5', () => {
    assert.deepEqual(M.DURATIONS, [5, 10, 15, 20]);
    assert.equal(M.create(15, T0).durationMs, 15 * MIN);
    assert.equal(M.create(7, T0).durationMs, 5 * MIN);
  });

  await t.test('2. Cuenta atrás y fin de sesión', () => {
    let s = M.create(5, T0);
    assert.equal(M.remainingMs(s, T0 + 2 * MIN), 3 * MIN);
    assert.equal(M.tick(s, T0 + 4 * MIN).finished, false);
    const r = M.tick(s, T0 + 5 * MIN + 10);
    assert.equal(r.finished, true);
    assert.equal(r.state.status, 'done');
    assert.equal(M.elapsedMs(r.state, T0 + 9 * MIN), 5 * MIN, 'nunca pasa de la duración');
  });

  await t.test('3. La pausa congela el tiempo y la reanudación lo descuenta', () => {
    let s = M.create(10, T0);
    s = M.pause(s, T0 + 3 * MIN);
    assert.equal(M.remainingMs(s, T0 + 8 * MIN), 7 * MIN, 'en pausa no avanza');
    assert.equal(M.endsAt(s, T0 + 8 * MIN), null);
    s = M.resume(s, T0 + 8 * MIN);
    assert.equal(M.remainingMs(s, T0 + 9 * MIN), 6 * MIN);
    assert.equal(M.endsAt(s, T0 + 9 * MIN), T0 + 15 * MIN);
    assert.equal(M.tick(s, T0 + 14 * MIN).finished, false);
    assert.equal(M.tick(s, T0 + 15 * MIN).finished, true);
  });

  await t.test('4. Guía de respiración 4-6', () => {
    assert.equal(M.breathPhase(0).phase, 'inhale');
    assert.equal(M.breathPhase(3999).phase, 'inhale');
    assert.equal(M.breathPhase(4000).phase, 'exhale');
    assert.equal(M.breathPhase(7000).progress, 0.5);
    assert.equal(M.breathPhase(10000).phase, 'inhale', 'el ciclo se repite cada 10 s');
  });

  await t.test('5. Formato del reloj', () => {
    assert.equal(M.formatClock(20 * MIN), '20:00');
    assert.equal(M.formatClock(61001), '01:02', 'redondea hacia arriba los segundos');
    assert.equal(M.formatClock(-5), '00:00');
  });

  await t.test('6. Historial: minutos de hoy, racha y sesiones', () => {
    let log = [];
    log = M.addToLog(log, '2026-10-19', 10);
    log = M.addToLog(log, '2026-10-20', 5);
    log = M.addToLog(log, '2026-10-21', 15);
    log = M.addToLog(log, '2026-10-21', 5);
    log = M.addToLog(log, '2026-10-21', 0.2); // menos de 1 minuto no cuenta
    assert.deepEqual(M.summarize(log, '2026-10-21'), { todayMinutes: 20, streak: 3, sessions: 4 });
    assert.equal(M.summarize(log, '2026-10-22').streak, 3, 'la racha sigue viva si hoy aún no meditaste');
    assert.equal(M.summarize(log, '2026-10-23').streak, 0, 'un día sin meditar la corta');
    assert.equal(M.summarize(M.addToLog([], '2026-03-01', 5).concat({ date: '2026-02-28', minutes: 5 }), '2026-03-01').streak, 2, 'cruza fin de mes');
  });
});
