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
    assert.deepEqual(WorkoutCore.summarizeWorkout(WORKOUTS[1]), { exercises: 2, sets: 4, reps: 33, seconds: 0, weightedVolume: 110 });
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
    assert.deepEqual(draft.exercises[0].sets, [{ reps: 8, seconds: 0, weight_kg: 10 }, { reps: 8, seconds: 0, weight_kg: 10 }, { reps: 8, seconds: 0, weight_kg: 10 }]);
    assert.equal(draft.exercises[0].last, '2026-10-13: 6 · 5 reps (+10 kg)');
    assert.deepEqual(draft.exercises[1].sets, [{ reps: 0, seconds: 60, weight_kg: 0 }, { reps: 0, seconds: 60, weight_kg: 0 }]);
    assert.equal(draft.exercises[2].sets.length, 1, 'al menos una serie');
    assert.equal(draft.exercises[2].last, '');
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
