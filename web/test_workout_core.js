/**
 * test_workout_core.js
 * Tests unitarios con node:test para web/workout-core.js (módulo de ejercicio / calistenia).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const WorkoutCore = require('./workout-core.js');

const W = (id, date, exercises, extra = {}) => ({ id, date, started_at: `${date}T07:00:00Z`, exercises, ...extra });
const reps = (...list) => list.map(r => (Array.isArray(r) ? { reps: r[0], weight_kg: r[1] } : { reps: r }));
const secs = (...list) => list.map(s => ({ seconds: s }));

const WORKOUTS = [
  W('w1', '2026-10-05', [ // semana del 5 oct (lunes)
    { name: 'Dominadas', measure: 'reps', sets: reps(8, 7, 6) },
    { name: 'Plancha', measure: 'time', sets: secs(45, 40) }
  ], { duration_minutes: 40 }),
  W('w2', '2026-10-13', [ // semana del 12 oct
    { name: 'Dominadas', measure: 'reps', sets: reps([6, 10], [5, 10]) },
    { name: 'Fondos', measure: 'reps', sets: reps(12, 10) }
  ], { duration_minutes: 50 }),
  W('w3', '2026-10-19', [ // semana del 19 oct (actual)
    { name: 'dominadas ', measure: 'reps', sets: reps(10, 9, 8) },
    { name: 'Plancha', measure: 'time', sets: secs(60, 50) }
  ], { duration_minutes: 45 }),
  W('borrado', '2026-10-19', [{ name: 'Dominadas', measure: 'reps', sets: reps(50) }], { deleted_at: '2026-10-19T10:00:00Z' })
];

test('WorkoutCore - Módulo de ejercicio (calistenia)', async (t) => {

  await t.test('1. Fechas: semanas de lunes a domingo y suma de días cruzando meses', () => {
    assert.equal(WorkoutCore.weekStart('2026-10-19'), '2026-10-19'); // lunes
    assert.equal(WorkoutCore.weekStart('2026-10-25'), '2026-10-19'); // domingo
    assert.equal(WorkoutCore.weekStart('2026-11-01'), '2026-10-26');
    assert.equal(WorkoutCore.addDays('2026-12-30', 3), '2027-01-02');
  });

  await t.test('2. 1RM estimado (Epley) solo con lastre y resumen de un entreno', () => {
    assert.equal(WorkoutCore.estimate1RM(10, 6), 12);
    assert.equal(WorkoutCore.estimate1RM(0, 10), 0);
    assert.deepEqual(WorkoutCore.summarizeWorkout(WORKOUTS[1]), { exercises: 2, sets: 4, reps: 33, seconds: 0, weightedVolume: 110, cardioSeconds: 0, distanceKm: 0 });
    assert.equal(WorkoutCore.summarizeWorkout(WORKOUTS[0]).seconds, 85);
  });

  await t.test('3. Texto de series: reps, isométricos y lastre', () => {
    assert.equal(WorkoutCore.formatSets(reps(10, 8, 8), 'reps'), '10 · 8 · 8 reps');
    assert.equal(WorkoutCore.formatSets(reps([6, 10], [5, 10]), 'reps'), '6 · 5 reps (+10 kg)');
    assert.equal(WorkoutCore.formatSets(reps([6, 10], 8), 'reps'), '6@+10kg · 8 reps');
    assert.equal(WorkoutCore.formatSets(secs(60, 0, 50), 'time'), '60 · 50 s');
    assert.equal(WorkoutCore.formatSets([], 'reps'), '');
  });

  await t.test('4. Historial y "la última vez" por ejercicio (sin distinguir mayúsculas/espacios, sin borrados)', () => {
    const hist = WorkoutCore.exerciseHistory(WORKOUTS, 'Dominadas');
    assert.deepEqual(hist.map(h => h.date), ['2026-10-19', '2026-10-13', '2026-10-05']);
    assert.equal(hist[0].bestReps, 10);
    assert.equal(hist[1].maxWeight, 10);
    assert.equal(WorkoutCore.lastPerformance(WORKOUTS, 'DOMINADAS').text, '10 · 9 · 8 reps');
    assert.equal(WorkoutCore.lastPerformance(WORKOUTS, 'Dominadas', 'w3').date, '2026-10-13', 'excluye el entreno que se está editando');
    assert.equal(WorkoutCore.lastPerformance(WORKOUTS, 'Muscle-up'), null);
  });

  await t.test('5. Récords personales por ejercicio con su fecha', () => {
    const recs = Object.fromEntries(WorkoutCore.personalRecords(WORKOUTS).map(r => [WorkoutCore.normalizeName(r.name), r]));
    assert.equal(recs.dominadas.sessions, 3);
    assert.equal(recs.dominadas.maxReps, 10);
    assert.equal(recs.dominadas.maxRepsDate, '2026-10-19');
    assert.equal(recs.dominadas.maxWeight, 10);
    assert.equal(recs.dominadas.best1RM, 12);
    assert.equal(recs.plancha.maxSeconds, 60);
    assert.equal(recs.fondos.maxReps, 12);
    assert.ok(!Object.values(recs).some(r => r.maxReps === 50), 'los entrenos borrados no cuentan');
  });

  await t.test('6. Serie semanal para la gráfica (global y por ejercicio)', () => {
    const all = WorkoutCore.weeklySeries(WORKOUTS, { today: '2026-10-21', weeks: 4 });
    assert.deepEqual(all.map(s => s.weekStart), ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
    assert.deepEqual(all.map(s => s.workouts), [0, 1, 1, 1]);
    assert.deepEqual(all.map(s => s.reps), [0, 21, 33, 27]);
    const pull = WorkoutCore.weeklySeries(WORKOUTS, { today: '2026-10-21', weeks: 4, exerciseName: 'Dominadas' });
    assert.deepEqual(pull.map(s => s.bestReps), [0, 8, 6, 10]);
    assert.deepEqual(pull.map(s => s.best1RM), [0, 0, 12, 0]);
  });

  await t.test('7. Resumen semanal y racha de semanas seguidas', () => {
    const sum = WorkoutCore.weeklySummary(WORKOUTS, '2026-10-21');
    assert.equal(sum.workouts, 1);
    assert.equal(sum.reps, 27);
    assert.equal(sum.seconds, 110);
    assert.equal(sum.minutes, 45);
    assert.equal(sum.previousWeekWorkouts, 1);
    assert.equal(sum.weekStreak, 3);
    // La semana siguiente aún sin entrenos: la racha se mantiene contando hasta la anterior.
    assert.equal(WorkoutCore.weeklySummary(WORKOUTS, '2026-10-27').weekStreak, 3);
    assert.equal(WorkoutCore.weeklySummary(WORKOUTS, '2026-11-04').weekStreak, 0);
  });

  await t.test('8. Borrador desde rutina: series objetivo, lastre de la última vez y referencia', () => {
    const routine = { id: 'r1', name: 'Tirón', exercises: [
      { name: 'Dominadas', measure: 'reps', target_sets: 3, target_reps: 8 },
      { name: 'Plancha', measure: 'time', target_sets: 2, target_seconds: 60 },
      { name: 'Remo invertido', measure: 'reps', target_sets: 0, target_reps: 12 }
    ] };
    const draft = WorkoutCore.buildDraftFromRoutine(routine, WORKOUTS.filter(w => w.id !== 'w3'));
    assert.equal(draft.routine_id, 'r1');
    assert.deepEqual(draft.exercises[0].sets, Array(3).fill({ reps: 8, seconds: 0, weight_kg: 10, distance_km: 0 }));
    assert.equal(draft.exercises[0].rest_seconds, 60, 'descanso por defecto');
    assert.equal(draft.exercises[0].last, '2026-10-13: 6 · 5 reps (+10 kg)');
    assert.deepEqual(draft.exercises[1].sets, Array(2).fill({ reps: 0, seconds: 60, weight_kg: 0, distance_km: 0 }));
    assert.equal(draft.exercises[2].sets.length, 1, 'al menos una serie');
    assert.equal(draft.exercises[2].last, '');
  });

  await t.test('10. Objetivos con rango, cardio y formato de duración', () => {
    assert.equal(WorkoutCore.formatTarget({ measure: 'reps', target_reps_min: 10, target_reps_max: 15 }), '10–15 reps');
    assert.equal(WorkoutCore.formatTarget({ measure: 'reps', target_reps: 12 }), '12 reps');
    assert.equal(WorkoutCore.formatTarget({ measure: 'time', target_seconds: 30 }), '30 s');
    assert.equal(WorkoutCore.formatTarget({ measure: 'cardio', target_seconds: 2700 }), '45 min');
    assert.equal(WorkoutCore.formatDuration(75), '1:15');
    assert.equal(WorkoutCore.formatDuration(3725), '1:02:05');
    const run = { id: 'c1', date: '2026-10-22', exercises: [{ name: 'Correr suave', measure: 'cardio', sets: [{ seconds: 1920, distance_km: 4.25 }] }] };
    const sum = WorkoutCore.summarizeWorkout(run);
    assert.equal(sum.cardioSeconds, 1920);
    assert.equal(sum.distanceKm, 4.25);
    assert.equal(sum.seconds, 0, 'el cardio no cuenta como isométrico');
    assert.equal(WorkoutCore.formatSets(run.exercises[0].sets, 'cardio'), '32 min · 4.25 km');
    const week = WorkoutCore.weeklySummary([run], '2026-10-23');
    assert.equal(week.cardioMinutes, 32);
    assert.equal(week.distanceKm, 4.25);
    assert.equal(WorkoutCore.personalRecords([run])[0].maxDistanceKm, 4.25);
    assert.equal(WorkoutCore.validateWorkout(run).valid, true);
  });

  await t.test('11. Plan sugerido: 5 rutinas en días distintos, idempotente y "hoy toca"', () => {
    assert.equal(WorkoutCore.SUGGESTED_PLAN.length, 5);
    const days = WorkoutCore.SUGGESTED_PLAN.flatMap(p => p.days);
    assert.deepEqual([...days].sort(), [0, 1, 2, 3, 4]);
    const seed = WorkoutCore.planSeed([{ id: 'plan-a' }, { id: 'plan-correr', deleted_at: 'x' }]);
    assert.deepEqual(seed.map(p => p.id), ['plan-caminar', 'plan-b', 'plan-c'], 'no duplica ni resucita borradas');
    seed[0].exercises[0].name = 'cambiado';
    assert.notEqual(WorkoutCore.SUGGESTED_PLAN[1].exercises[0].name, 'cambiado', 'devuelve copias');
    const plan = WorkoutCore.SUGGESTED_PLAN;
    assert.equal(WorkoutCore.weekdayIndex('2026-10-19'), 0);
    assert.deepEqual(WorkoutCore.plannedRoutinesFor(plan, '2026-10-19').map(p => p.id), ['plan-a']);
    assert.deepEqual(WorkoutCore.plannedRoutinesFor(plan, '2026-10-22').map(p => p.id), ['plan-correr']);
    assert.deepEqual(WorkoutCore.plannedRoutinesFor(plan, '2026-10-25'), [], 'domingo de descanso');
    assert.equal(WorkoutCore.formatDays([4, 0, 2]), 'L · X · V');
    assert.equal(WorkoutCore.isCardioRoutine(plan[1]), true);
    assert.equal(WorkoutCore.isCardioRoutine(plan[0]), false);
    assert.equal(WorkoutCore.routineForActivity(plan, { title: 'Calistenia' }, '2026-10-19').id, 'plan-a');
    assert.equal(WorkoutCore.routineForActivity(plan, { title: 'Correr' }, '2026-10-19').id, 'plan-correr', 'por nombre aunque no toque');
    assert.equal(WorkoutCore.routineForActivity(plan, { title: 'Calistenia' }, '2026-10-25'), null);
  });

  await t.test('12. Pasos del entreno guiado: serie, descanso, serie… sin descanso al final', () => {
    const draft = WorkoutCore.buildDraftFromRoutine({ exercises: [
      { name: 'Flexiones', measure: 'reps', target_sets: 2, target_reps_min: 10, target_reps_max: 15, rest_seconds: 45 },
      { name: 'Plancha', measure: 'time', target_sets: 2, target_seconds: 30, rest_seconds: 0 },
      { name: 'Sentadillas', measure: 'reps', target_sets: 1, target_reps: 12, rest_seconds: 60 }
    ] }, []);
    const steps = WorkoutCore.buildSessionSteps(draft);
    assert.deepEqual(steps.map(s => s.type + (s.seconds ? s.seconds : '')), ['work', 'rest45', 'work', 'rest45', 'work', 'work', 'work']);
    assert.equal(steps[steps.length - 1].type, 'work');
  });

  await t.test('13. Estado guiado por marcas de tiempo: descanso que termina y espera, +15 s, pausa e isométrico', () => {
    const draft = WorkoutCore.buildDraftFromRoutine({ exercises: [
      { name: 'Flexiones', measure: 'reps', target_sets: 2, target_reps_min: 10, target_reps_max: 15, rest_seconds: 60 },
      { name: 'Plancha', measure: 'time', target_sets: 1, target_seconds: 30 }
    ] }, []);
    const T = 1_000_000;
    let st = WorkoutCore.guidedStart(T);
    let v = WorkoutCore.guidedView(draft, st, T + 5000);
    assert.equal(v.step.type, 'work');
    assert.equal(v.target, '10–15 reps');
    assert.equal(v.setNumber, 1);
    assert.equal(v.duration, 0, 'las series de reps no tienen cuenta atrás');
    assert.equal(v.next.name, 'Flexiones');

    st = WorkoutCore.guidedAdvance(st, draft, T + 20000); // serie hecha -> descanso de 60 s
    v = WorkoutCore.guidedView(draft, st, T + 50000);
    assert.equal(v.step.type, 'rest');
    assert.equal(v.remaining, 30);
    assert.equal(v.timeUp, false);
    assert.equal(v.next.setNumber, 2);

    st = WorkoutCore.guidedAddRest(st, 15);
    assert.equal(WorkoutCore.guidedView(draft, st, T + 50000).remaining, 45);

    st = WorkoutCore.guidedPause(st, T + 50000);
    assert.equal(WorkoutCore.guidedView(draft, st, T + 200000).remaining, 45, 'en pausa no corre');
    st = WorkoutCore.guidedResume(st, T + 200000);
    v = WorkoutCore.guidedView(draft, st, T + 200000 + 46000);
    assert.equal(v.remaining, 0);
    assert.equal(v.timeUp, true);
    assert.equal(v.step.type, 'rest', 'al terminar el descanso NO avanza solo: espera a "Siguiente"');
    assert.equal(WorkoutCore.guidedView(draft, st, T + 900000).step.type, 'rest', 'sigue esperando');

    st = WorkoutCore.guidedAdvance(st, draft, T + 300000); // serie 2
    st = WorkoutCore.guidedAdvance(st, draft, T + 320000); // descanso
    st = WorkoutCore.guidedAdvance(st, draft, T + 330000); // plancha
    v = WorkoutCore.guidedView(draft, st, T + 340000);
    assert.equal(v.exercise.name, 'Plancha');
    assert.equal(v.duration, 30);
    assert.equal(v.remaining, 20);
    assert.equal(v.next, null);
    assert.equal(v.position, v.total);

    st = WorkoutCore.guidedBack(st, T + 341000);
    assert.equal(WorkoutCore.guidedView(draft, st, T + 341000).step.type, 'rest');
    st = WorkoutCore.guidedAdvance(WorkoutCore.guidedAdvance(st, draft, T + 342000), draft, T + 380000);
    v = WorkoutCore.guidedView(draft, st, T + 380000);
    assert.equal(v.finished, true);
    assert.equal(v.totalElapsed, 380 - 150, 'el tiempo total descuenta la pausa');
  });

  await t.test('9. Actividades de ejercicio de la agenda y validaciones', () => {
    assert.equal(WorkoutCore.isExerciseActivity({ title: 'Calistenia', tags: ['salud'] }), true);
    assert.equal(WorkoutCore.isExerciseActivity({ title: 'Correr', tags: [] }), true);
    assert.equal(WorkoutCore.isExerciseActivity({ title: 'Mañana', tags: ['Ejercicio'] }), true);
    assert.equal(WorkoutCore.isExerciseActivity({ title: 'Inglés', tags: ['estudio'] }), false);

    assert.equal(WorkoutCore.validateRoutine({ name: 'Empuje', exercises: [{ name: 'Fondos' }] }).valid, true);
    assert.equal(WorkoutCore.validateRoutine({ name: ' ', exercises: [] }).errors.length, 2);
    assert.equal(WorkoutCore.validateWorkout({ date: '2026-10-19', exercises: [{ name: 'Fondos', sets: reps(10) }] }).valid, true);
    assert.equal(WorkoutCore.validateWorkout({ date: '2026-10-19', exercises: [{ name: 'Fondos', sets: reps(0) }] }).valid, false);
    assert.equal(WorkoutCore.validateWorkout({ date: '19/10', exercises: [{ name: 'Fondos', sets: reps(5) }] }).valid, false);
  });
});
