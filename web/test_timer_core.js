/**
 * test_timer_core.js
 * Tests unitarios con node:test para web/timer-core.js (Fase C1).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const TimerCore = require('./timer-core.js');

test('TimerCore - Suite de Lógica Pura del Temporizador (Fase C1)', async (t) => {

  await t.test('1. createTimer inicializa correctamente los diferentes métodos de enfoque', () => {
    // Pomodoro clásico
    const pomo = TimerCore.createTimer({ method: 'pomodoro' });
    assert.equal(pomo.method, 'pomodoro');
    assert.equal(pomo.status, 'idle');
    assert.equal(pomo.phase, 'focus');
    assert.equal(pomo.config.focusDurationSec, 1500); // 25 min
    assert.equal(pomo.config.breakDurationSec, 300);   // 5 min
    assert.equal(pomo.config.cyclesBeforeLongBreak, 4);
    assert.equal(pomo.config.isCountdown, true);

    // 52/17
    const t52 = TimerCore.createTimer({ method: '52_17' });
    assert.equal(t52.config.focusDurationSec, 3120); // 52 min
    assert.equal(t52.config.breakDurationSec, 1020);  // 17 min

    // Ultradiano
    const ultra = TimerCore.createTimer({ method: 'ultradian' });
    assert.equal(ultra.config.focusDurationSec, 5400); // 90 min
    assert.equal(ultra.config.breakDurationSec, 1200);  // 20 min

    // Flowtime
    const flow = TimerCore.createTimer({ method: 'flowtime' });
    assert.equal(flow.config.isCountdown, false);

    // Custom countdown
    const custom = TimerCore.createTimer({ method: 'custom', customFocusMinutes: 45 });
    assert.equal(custom.config.focusDurationSec, 2700); // 45 min
  });

  await t.test('2. start, pause y resume acumulan intervalos de enfoque efectivo con reloj inyectable', () => {
    let mockTime = 1700000000000;
    const now = () => mockTime;

    let timer = TimerCore.createTimer({ method: 'pomodoro' }, now);
    assert.equal(timer.status, 'idle');

    // Iniciar
    timer = TimerCore.start(timer, now);
    assert.equal(timer.status, 'running');
    assert.equal(timer.current_interval_start, mockTime);

    // Avanzar 10 minutos (600.000 ms)
    mockTime += 600000;
    timer = TimerCore.pause(timer, now);
    assert.equal(timer.status, 'paused');
    assert.equal(timer.effective_seconds, 600);
    assert.equal(timer.focus_intervals.length, 1);

    // Reanudar tras 2 minutos de pausa
    mockTime += 120000;
    timer = TimerCore.resume(timer, now);
    assert.equal(timer.status, 'running');

    // Avanzar 15 minutos más (900.000 ms)
    mockTime += 900000;
    timer = TimerCore.pause(timer, now);
    assert.equal(timer.effective_seconds, 1500); // 600 + 900 = 1500s (25 min)
    assert.equal(timer.focus_intervals.length, 2);
  });

  await t.test('3. startBreak y endBreak acumulan segundos de descanso y gestionan ciclo largo', () => {
    let mockTime = 1700000000000;
    const now = () => mockTime;

    let timer = TimerCore.createTimer({ method: 'pomodoro' }, now);
    timer = TimerCore.start(timer, now);

    // 25 min de enfoque
    mockTime += 1500000;
    timer = TimerCore.startBreak(timer, false, now);
    assert.equal(timer.status, 'break');
    assert.equal(timer.phase, 'break');
    assert.equal(timer.cycles_completed, 1);
    assert.equal(timer.effective_seconds, 1500);

    // 5 min de descanso
    mockTime += 300000;
    timer = TimerCore.endBreak(timer, now);
    assert.equal(timer.status, 'paused');
    assert.equal(timer.break_seconds, 300);
  });

  await t.test('4. Flowtime calcula descansos proporcionales al tiempo de enfoque acumulado', () => {
    assert.equal(TimerCore.calculateFlowtimeBreak(20 * 60), 5 * 60);  // 20 min -> 5 min break
    assert.equal(TimerCore.calculateFlowtimeBreak(35 * 60), 8 * 60);  // 35 min -> 8 min break
    assert.equal(TimerCore.calculateFlowtimeBreak(70 * 60), 10 * 60); // 70 min -> 10 min break
    assert.equal(TimerCore.calculateFlowtimeBreak(100 * 60), 15 * 60);// 100 min -> 15 min break
  });

  await t.test('5. Detección de ausencias (gaps) y política de confirmación', () => {
    let mockTime = 1700000000000;
    const now = () => mockTime;

    let timer = TimerCore.createTimer({ method: 'pomodoro' }, now);
    timer = TimerCore.start(timer, now);

    // Tick normal tras 10 segundos
    mockTime += 10000;
    timer = TimerCore.tick(timer, now);
    assert.equal(timer.status, 'running');

    // Simular pestaña suspendida / cerrada por 5 minutos (> 2 min gap)
    mockTime += 300000;
    timer = TimerCore.tick(timer, now);
    assert.equal(timer.status, 'waiting');
    assert.equal(timer.waiting_reason, 'fixed_gap');

    // Caso A: Usuario acepta que continuó estudiando
    let timerAccepted = JSON.parse(JSON.stringify(timer));
    timerAccepted = TimerCore.resolveGap(timerAccepted, true, null, now);
    assert.equal(timerAccepted.status, 'running');

    // Caso B: Usuario indica que se detuvo antes (corte al último heartbeat)
    let timerCutoff = JSON.parse(JSON.stringify(timer));
    timerCutoff = TimerCore.resolveGap(timerCutoff, false, null, now);
    assert.equal(timerCutoff.status, 'paused');
    assert.equal(timerCutoff.effective_seconds, 10); // Solo los 10 segundos previos a la ausencia
  });

  await t.test('6. logDistraction registra distracciones con timestamp ISO y nota acotada', () => {
    let mockTime = 1700000000000;
    const now = () => mockTime;

    let timer = TimerCore.createTimer({ method: 'deep_work' }, now);
    timer = TimerCore.start(timer, now);

    timer = TimerCore.logDistraction(timer, 'Revisé una notificación de Slack', now);
    assert.equal(timer.distractions.length, 1);
    assert.equal(timer.distractions[0].note, 'Revisé una notificación de Slack');
    assert.ok(timer.distractions[0].timestamp);
  });

  await t.test('7. buildSessionRecord genera payload válido para focus_sessions cumpliendo invariantes', () => {
    let mockTime = 1700000000000;
    const now = () => mockTime;

    let timer = TimerCore.createTimer({
      id: 'foc-test-record-1',
      method: 'pomodoro',
      goal: 'Estudiar Gramática C1',
      subject_id: 'sub-ingles',
      topic_ids: ['top-gramatica']
    }, now);

    timer = TimerCore.start(timer, now);
    mockTime += 1500000; // 25 min
    timer = TimerCore.startBreak(timer, false, now);
    mockTime += 300000;  // 5 min break
    timer = TimerCore.endBreak(timer, now);

    const record = TimerCore.buildSessionRecord(timer, { source: 'timer' }, now);

    assert.equal(record.id, 'foc-test-record-1');
    assert.equal(record.subject_id, 'sub-ingles');
    assert.deepEqual(record.topic_ids, ['top-gramatica']);
    assert.equal(record.method, 'pomodoro');
    assert.equal(record.goal, 'Estudiar Gramática C1');
    assert.equal(record.effective_seconds, 1500);
    assert.equal(record.break_seconds, 300);
    assert.equal(record.cycles_completed, 1);
    assert.equal(record.status, 'completed');
    assert.equal(record.source, 'timer');
    assert.equal(record.op, 'create_if_absent');
    assert.equal(record.focus_intervals.length, 1);
    assert.ok(record.started_at);
    assert.ok(record.ended_at);
    assert.ok(new Date(record.ended_at) >= new Date(record.started_at));
  });

});
