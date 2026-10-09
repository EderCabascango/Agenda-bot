const test = require('node:test');
const assert = require('node:assert/strict');
const TimerCore = require('./timer-core.js');

test('TimerCore - Suite de Lógica Pura del Temporizador (Fase C1)', async (t) => {
  // 1. Métodos soportados e inicialización
  await t.test('1. createTimer inicializa correctamente los diferentes métodos de enfoque', () => {
    const pomodoro = TimerCore.createTimer({ method: 'pomodoro', goal: 'Estudiar FastAPI' });
    assert.equal(pomodoro.method, 'pomodoro');
    assert.equal(pomodoro.config.focusDurationSec, 25 * 60);
    assert.equal(pomodoro.config.breakDurationSec, 5 * 60);
    assert.equal(pomodoro.config.longBreakDurationSec, 15 * 60);
    assert.equal(pomodoro.config.cyclesBeforeLongBreak, 4);
    assert.equal(pomodoro.config.allowPause, true);
    assert.equal(pomodoro.status, 'idle');
    assert.equal(pomodoro.phase, 'focus');

    const deepWork = TimerCore.createTimer({ method: 'deep_work' });
    assert.equal(deepWork.method, 'deep_work');
    assert.equal(deepWork.config.allowPause, false); // Deep work no permite pausa

    const custom = TimerCore.createTimer({ method: 'custom', customFocusMinutes: 45 });
    assert.equal(custom.config.focusDurationSec, 45 * 60);

    const flowtime = TimerCore.createTimer({ method: 'flowtime' });
    assert.equal(flowtime.config.isCountdown, false);
  });

  // 2. Start, Pause, Resume y restricción Deep Work
  await t.test('2. start, pause y resume acumulan intervalos de enfoque efectivo con reloj inyectable', () => {
    let now = 1700000000000;
    const nowFn = () => now;

    let timer = TimerCore.createTimer({ method: 'pomodoro' });
    timer = TimerCore.start(timer, nowFn);
    assert.equal(timer.status, 'running');
    assert.equal(timer.started_at, new Date(now).toISOString());

    // Avanzar 10 minutos (600s)
    now += 600 * 1000;
    timer = TimerCore.pause(timer, nowFn);
    assert.equal(timer.status, 'paused');
    assert.equal(timer.effective_seconds, 600);
    assert.equal(timer.focus_intervals.length, 1);

    // Pausa en Deep Work debe ser rechazada
    let dwTimer = TimerCore.createTimer({ method: 'deep_work' });
    dwTimer = TimerCore.start(dwTimer, nowFn);
    dwTimer = TimerCore.pause(dwTimer, nowFn);
    assert.equal(dwTimer.status, 'running'); // No cambia a paused

    // Reanudar pomodoro
    now += 120 * 1000; // 2 min de pausa
    timer = TimerCore.resume(timer, nowFn);
    assert.equal(timer.status, 'running');

    // Avanzar otros 5 minutos (300s) y pausar de nuevo
    now += 300 * 1000;
    timer = TimerCore.pause(timer, nowFn);
    assert.equal(timer.effective_seconds, 900);
    assert.equal(timer.focus_intervals.length, 2);
  });

  // 3. StartBreak, EndBreak, SkipBreak y ciclo largo
  await t.test('3. startBreak, endBreak y skipBreak acumulan segundos de descanso y gestionan ciclo largo', () => {
    let now = 1700000000000;
    const nowFn = () => now;

    let timer = TimerCore.createTimer({ method: 'pomodoro' });

    // Simular 4 ciclos completados
    for (let i = 1; i <= 3; i++) {
      timer = TimerCore.start(timer, nowFn);
      now += 25 * 60 * 1000;
      timer = TimerCore.startBreak(timer, false, nowFn);
      assert.equal(timer.phase, 'break');
      now += 5 * 60 * 1000;
      timer = TimerCore.endBreak(timer, nowFn);
      assert.equal(timer.cycles_completed, i);
    }

    // 4to ciclo debe activar descanso largo
    timer = TimerCore.start(timer, nowFn);
    now += 25 * 60 * 1000;
    timer = TimerCore.startBreak(timer, false, nowFn);
    assert.equal(timer.phase, 'long_break');
    assert.equal(timer.cycles_completed, 4);

    // SkipBreak debe cerrar descanso de inmediato
    timer = TimerCore.skipBreak(timer, nowFn);
    assert.equal(timer.phase, 'focus');
    assert.equal(timer.status, 'paused');
  });

  // 4. Flowtime descanso dinámico
  await t.test('4. Flowtime calcula descansos proporcionales al tiempo de enfoque acumulado', () => {
    assert.equal(TimerCore.calculateFlowtimeBreak(20 * 60), 5 * 60);  // <25m -> 5m
    assert.equal(TimerCore.calculateFlowtimeBreak(35 * 60), 8 * 60);  // 25-50m -> 8m
    assert.equal(TimerCore.calculateFlowtimeBreak(70 * 60), 10 * 60); // 50-90m -> 10m
    assert.equal(TimerCore.calculateFlowtimeBreak(100 * 60), 15 * 60); // >90m -> 15m
  });

  // 5. Tick con latido vivo y avance automático de fase
  await t.test('5. tick con latido vivo (<= 2 min) completa fase y emite evento de avance', () => {
    let now = 1700000000000;
    const nowFn = () => now;

    let timer = TimerCore.createTimer({ method: 'pomodoro' });
    timer = TimerCore.start(timer, nowFn);

    // Ticks periódicos cada 10s durante 25 min
    for (let s = 10; s < 25 * 60; s += 10) {
      now += 10 * 1000;
      const res = TimerCore.tick(timer, nowFn);
      assert.equal(res.events.length, 0);
      assert.equal(timer.status, 'running');
    }

    // Al cumplir los 25 minutos exactos con latido vivo (hueco = 10s <= 2m)
    now += 10 * 1000;
    const res = TimerCore.tick(timer, nowFn);
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].type, 'phase_completed');
    assert.equal(timer.status, 'break');
    assert.equal(timer.effective_seconds, 25 * 60);
  });

  // 6. Tick con hueco > 2 min en método fijo limita tiempo a duración de fase y pasa a waiting
  await t.test('6. tick con hueco > 2 min tras expirar fase pasa a waiting y limita segundos a la fase', () => {
    let now = 1700000000000;
    const nowFn = () => now;

    let timer = TimerCore.createTimer({ method: 'pomodoro' });
    timer = TimerCore.start(timer, nowFn);

    // La pestaña se durmió durante 3 horas (180 min)
    now += 180 * 60 * 1000;
    const res = TimerCore.tick(timer, nowFn);
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].type, 'phase_finished_waiting');
    assert.equal(timer.status, 'waiting');
    assert.equal(timer.waiting_reason, 'fixed_gap');
    // Segundos acreditados deben ser estrictamente 25 min (1500s), NO 3 horas
    assert.equal(timer.effective_seconds, 25 * 60);
  });

  // 7. Flowtime con ausencia > 30 min pasa a waiting pidiendo confirmación
  await t.test('7. Flowtime con ausencia > 30 min pasa a waiting pidiendo confirmación de hora real', () => {
    let now = 1700000000000;
    const nowFn = () => now;

    let timer = TimerCore.createTimer({ method: 'flowtime' });
    timer = TimerCore.start(timer, nowFn);

    now += 45 * 60 * 1000; // 45 min sin tick
    const res = TimerCore.tick(timer, nowFn);
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].type, 'gap_detected');
    assert.equal(timer.status, 'waiting');
    assert.equal(timer.waiting_reason, 'flowtime_gap');

    // Si el usuario corta en el último latido (inicio)
    TimerCore.resolveGap(timer, false, null, nowFn);
    assert.equal(timer.status, 'paused');
  });

  // 8. finish y confirmación de descarte en < 60s
  await t.test('8. finish con menos de 60s devuelve ask_discard, y con >= 60s completa la sesión', () => {
    let now = 1700000000000;
    const nowFn = () => now;

    let shortTimer = TimerCore.createTimer({ method: 'pomodoro' });
    shortTimer = TimerCore.start(shortTimer, nowFn);
    now += 40 * 1000; // 40 segundos

    const shortRes = TimerCore.finish(shortTimer, nowFn);
    assert.equal(shortRes.action, 'ask_discard');
    assert.equal(shortRes.totalEffectiveSeconds, 40);

    let longTimer = TimerCore.createTimer({ method: 'pomodoro' });
    longTimer = TimerCore.start(longTimer, nowFn);
    now += 120 * 1000; // 2 minutos

    const longRes = TimerCore.finish(longTimer, nowFn);
    assert.equal(longRes.action, 'completed');
    assert.equal(longRes.totalEffectiveSeconds, 120);
    assert.equal(longTimer.status, 'completed');
  });

  // 9. buildSessionRecord genera registro sin versión hardcodeada conforme a invariantes
  await t.test('9. buildSessionRecord y buildManualSession generan payloads válidos sin solapamiento', () => {
    let now = 1700000000000;
    const nowFn = () => now;

    let timer = TimerCore.createTimer({
      method: 'pomodoro',
      subject_id: 'sub-math-1',
      topic_ids: ['top-algebra-1'],
      goal: 'Resolver derivadas'
    });
    timer = TimerCore.start(timer, nowFn);
    now += 1500 * 1000; // 25 min
    TimerCore.logDistraction(timer, 'Notificación de Slack', nowFn);
    TimerCore.finish(timer, nowFn);

    const record = TimerCore.buildSessionRecord(timer, {}, nowFn);
    assert.equal(record.subject_id, 'sub-math-1');
    assert.deepEqual(record.topic_ids, ['top-algebra-1']);
    assert.equal(record.goal, 'Resolver derivadas');
    assert.equal(record.effective_seconds, 1500);
    assert.equal(record.distractions_count, 1);
    assert.equal(record.source, 'timer');
    assert.equal(record.status, 'completed');
    assert.equal(record.version, undefined); // version NO se incluye (manejado por servidor/sync)
    assert.equal(record.focus_intervals.length, 1);

    // Sesión manual
    const manual = TimerCore.buildManualSession({
      subject_id: 'sub-math-1',
      durationMinutes: 45,
      goal: 'Lectura de apuntes'
    }, nowFn);
    assert.equal(manual.source, 'manual');
    assert.equal(manual.effective_seconds, 45 * 60);
    assert.equal(manual.focus_intervals.length, 1);
    assert.equal(manual.version, undefined);
  });
});
