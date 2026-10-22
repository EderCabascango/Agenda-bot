/**
 * test_matrix_core.js
 * Tests unitarios con node:test para web/matrix-core.js (vinculación automática de la matriz).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./matrix-core.js');

const ROWS = [
  { label: 'Inglés', keys: ['inglés', 'ingles'] },
  { label: 'Ejercicio', keys: ['calistenia', 'ejercicio', 'gym'] },
  { label: 'AI-300', keys: ['ai-300', 'ai300'] },
  { label: 'Leer', keys: ['leer'] },
  { label: 'Fuyu', keys: ['fuyu'] },
  { label: 'Proyectos', keys: ['proyecto', 'proyectos', 'estudio'] },
];
const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('MatrixCore - Vinculación de la matriz', async (t) => {

  await t.test('1. Fila de una materia: la elegida a mano manda; si no, coincide por nombre', () => {
    assert.equal(M.rowForSubject({ name: 'Python', matrix_row: 'Fuyu' }, ROWS).label, 'Fuyu');
    assert.equal(M.rowForSubject({ name: 'Inglés B2' }, ROWS).label, 'Inglés');
    assert.equal(M.rowForSubject({ name: 'Certificación AI-300' }, ROWS).label, 'AI-300');
    assert.equal(M.rowForSubject({ name: 'ingles' }, ROWS).label, 'Inglés', 'ignora tildes');
    assert.equal(M.rowForSubject({ name: 'Apache Spark' }, ROWS), null);
    assert.equal(M.rowForSubject({ name: 'Spark', matrix_row: 'Fila borrada' }, ROWS), null, 'fila inexistente y sin coincidencia');
  });

  await t.test('2. Entreno completo: todas las series objetivo de la rutina', () => {
    const routine = { exercises: [{ name: 'Flexiones', target_sets: 3 }, { name: 'Trote', measure: 'cardio', target_sets: 1 }] };
    const full = { exercises: [{ name: 'Flexiones', sets: [{}, {}, {}] }, { name: 'trote', sets: [{}] }] };
    const partial = { exercises: [{ name: 'Flexiones', sets: [{}, {}] }, { name: 'Trote', sets: [{}] }] };
    assert.equal(M.isWorkoutComplete(full, routine), true);
    assert.equal(M.isWorkoutComplete(partial, routine), false);
    assert.equal(M.isWorkoutComplete({ exercises: [] }, null), true, 'entreno libre cuenta');
  });

  await t.test('3. Minutos vinculados: sesiones terminadas y entrenos completos', () => {
    const subjects = [
      { id: 's1', name: 'Inglés' },
      { id: 's2', name: 'Python', kind: 'skill', matrix_row: 'Fuyu' },
      { id: 's3', name: 'Hábitos atómicos', kind: 'book', matrix_row: 'Leer' },
      { id: 's4', name: 'Spark' },
    ];
    const at = '2026-10-21T15:00:00';
    const day = localDate(new Date(at));
    const sessions = [
      { subject_id: 's1', status: 'completed', started_at: at, effective_seconds: 1500 },
      { subject_id: 's1', status: 'completed', started_at: at, effective_seconds: 1500 },
      { subject_id: 's2', status: 'completed', started_at: at, effective_seconds: 3600 },
      { subject_id: 's3', status: 'completed', started_at: at, effective_seconds: 900 },
      { subject_id: 's3', status: 'abandoned', started_at: at, effective_seconds: 900 },
      { subject_id: 's1', status: 'completed', started_at: at, effective_seconds: 30 },
      { subject_id: 's4', status: 'completed', started_at: at, effective_seconds: 3000 },
      { subject_id: 's1', status: 'completed', started_at: at, effective_seconds: 3000, deleted_at: 'x' },
    ];
    const routines = [{ id: 'r1', exercises: [{ name: 'Dominadas', target_sets: 2 }] }];
    const workouts = [
      { date: '2026-10-20', routine_id: 'r1', duration_minutes: 40, exercises: [{ name: 'Dominadas', sets: [{}, {}] }] },
      { date: '2026-10-19', routine_id: 'r1', duration_minutes: 40, exercises: [{ name: 'Dominadas', sets: [{}] }] },
      { date: '2026-10-18', duration_minutes: 25, exercises: [] },
    ];
    const out = M.linkedMinutes({ rows: ROWS, subjects, sessions, workouts, routines }, localDate);
    assert.deepEqual(out[day], { 'Inglés': 50, 'Fuyu': 60, 'Leer': 15 });
    assert.deepEqual(out['2026-10-20'], { 'Ejercicio': 40 });
    assert.equal(out['2026-10-19'], undefined, 'rutina a medias no marca');
    assert.deepEqual(out['2026-10-18'], { 'Ejercicio': 25 });
  });

  await t.test('4. Intensidad por minutos', () => {
    assert.equal(M.levelForMinutes(0), 0);
    assert.equal(M.levelForMinutes(20), 1);
    assert.equal(M.levelForMinutes(60), 2);
    assert.equal(M.levelForMinutes(150), 3);
  });
});
