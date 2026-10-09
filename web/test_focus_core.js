/**
 * test_focus_core.js
 * Tests unitarios con node:test para web/focus-core.js (Fase B1).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const FocusCore = require('./focus-core.js');

test('FocusCore - Suite de Lógica Pura de Materias y Temas (Fase B1)', async (t) => {

  await t.test('1. planSeedCreation genera 4 materias y 8 temas sugeridos con op=create_if_absent', () => {
    const plan = FocusCore.planSeedCreation();
    assert.equal(plan.subjects.length, 4);
    assert.equal(plan.topics.length, 8);
    assert.equal(plan.total_items, 12);

    const subjectIds = plan.subjects.map(s => s.id);
    assert.ok(subjectIds.includes('subject-seed-ingles'));
    assert.ok(subjectIds.includes('subject-seed-genai'));
    assert.ok(subjectIds.includes('subject-seed-mlops'));
    assert.ok(subjectIds.includes('subject-seed-spark'));

    plan.subjects.forEach(s => {
      assert.equal(s.op, 'create_if_absent');
      assert.equal(s.archived, 0);
      assert.ok(s.name);
      assert.ok(s.color.startsWith('#'));
      assert.ok(s.weekly_goal_minutes >= 0);
    });

    plan.topics.forEach(top => {
      assert.equal(top.op, 'create_if_absent');
      assert.ok(top.subject_id.startsWith('subject-seed-'));
      assert.ok(top.name);
      assert.equal(top.status, 'not_started');
    });
  });

  await t.test('2. decideSubjectRemoval decide archivar si existen sesiones activas', () => {
    const subject = { id: 'sub_math', name: 'Matemáticas', version: 2 };
    const sessions = [
      { id: 'sess_1', subject_id: 'sub_math', effective_seconds: 1800, deleted_at: null }
    ];
    const notes = [];
    const childTopics = [{ id: 'top_algebra', subject_id: 'sub_math' }];

    const decision = FocusCore.decideSubjectRemoval(subject, sessions, notes, childTopics);
    assert.equal(decision.action, 'archive');
    assert.equal(decision.reason, 'has_history');
    assert.equal(decision.session_count, 1);
    assert.equal(decision.subjectPatch.id, 'sub_math');
    assert.equal(decision.subjectPatch.archived, 1);
    assert.equal(decision.subjectPatch.base_version, 2);
    assert.equal(decision.subjectPatch.deleted_at, undefined);
  });

  await t.test('3. decideSubjectRemoval decide archivar si existen notas activas', () => {
    const subject = { id: 'sub_history', name: 'Historia', version: 1 };
    const sessions = [];
    const notes = [
      { id: 'note_1', subject_id: 'sub_history', learned_text: 'Revolución Francesa', deleted_at: null }
    ];
    const childTopics = [];

    const decision = FocusCore.decideSubjectRemoval(subject, sessions, notes, childTopics);
    assert.equal(decision.action, 'archive');
    assert.equal(decision.reason, 'has_history');
    assert.equal(decision.note_count, 1);
    assert.equal(decision.subjectPatch.archived, 1);
  });

  await t.test('4. decideSubjectRemoval decide borrar con tombstones en cascada si no hay historial', () => {
    const subject = { id: 'sub_empty', name: 'Vacia', version: 3 };
    const sessions = [
      { id: 'sess_old', subject_id: 'sub_empty', effective_seconds: 1200, deleted_at: '2026-10-01T00:00:00Z' }
    ];
    const notes = [];
    const childTopics = [
      { id: 'top_1', subject_id: 'sub_empty', version: 1 },
      { id: 'top_2', subject_id: 'sub_empty', version: 2 }
    ];

    const decision = FocusCore.decideSubjectRemoval(subject, sessions, notes, childTopics);
    assert.equal(decision.action, 'delete');
    assert.equal(decision.reason, 'no_history');
    assert.ok(decision.subjectPatch.deleted_at);
    assert.equal(decision.subjectPatch.base_version, 3);
    assert.equal(decision.topicTombstones.length, 2);
    assert.equal(decision.topicTombstones[0].id, 'top_1');
    assert.ok(decision.topicTombstones[0].deleted_at);
    assert.equal(decision.topicTombstones[1].id, 'top_2');
    assert.ok(decision.topicTombstones[1].deleted_at);
  });

  await t.test('5. summarizeSubject calcula minutos, horas y reparto equitativo entre múltiples subtemas', () => {
    const subject = {
      id: 'sub_prog',
      name: 'Programación',
      weekly_goal_minutes: 120
    };
    const topics = [
      { id: 'top_js', subject_id: 'sub_prog', name: 'JavaScript', status: 'in_progress' },
      { id: 'top_py', subject_id: 'sub_prog', name: 'Python', status: 'completed' },
      { id: 'top_rust', subject_id: 'sub_prog', name: 'Rust', status: 'not_started' }
    ];
    const sessions = [
      // Sesión 1: 3600 segundos (60 min) divididos entre JS y Python (1800s c/u = 30 min c/u)
      {
        id: 'sess_1',
        subject_id: 'sub_prog',
        topic_ids: ['top_js', 'top_py'],
        effective_seconds: 3600,
        deleted_at: null
      },
      // Sesión 2: 1800 segundos (30 min) solo para JS (1800s = 30 min)
      {
        id: 'sess_2',
        subject_id: 'sub_prog',
        topic_ids: ['top_js'],
        effective_seconds: 1800,
        deleted_at: null
      },
      // Sesión 3: 1200 segundos (20 min) sin temas asociados (solo a la materia)
      {
        id: 'sess_3',
        subject_id: 'sub_prog',
        topic_ids: [],
        effective_seconds: 1200,
        deleted_at: null
      },
      // Sesión borrada (tombstone) debe ser ignorada
      {
        id: 'sess_del',
        subject_id: 'sub_prog',
        topic_ids: ['top_rust'],
        effective_seconds: 9999,
        deleted_at: '2026-10-09T00:00:00Z'
      }
    ];

    const summary = FocusCore.summarizeSubject(subject, topics, sessions);

    // Total segundos: 3600 + 1800 + 1200 = 6600 segundos (110 minutos = 1.83 horas)
    assert.equal(summary.total_seconds, 6600);
    assert.equal(summary.total_minutes, 110);
    assert.equal(summary.total_hours, 1.83);
    assert.equal(summary.session_count, 3);
    assert.equal(summary.goal_progress_percent, 92); // 110 / 120 = 91.66% -> 92%

    // JS: 1800 (de sesión 1) + 1800 (de sesión 2) = 3600s (60 min, 1.0 h, 55% del total)
    assert.equal(summary.topic_stats['top_js'].seconds, 3600);
    assert.equal(summary.topic_stats['top_js'].minutes, 60);
    assert.equal(summary.topic_stats['top_js'].hours, 1);
    assert.equal(summary.topic_stats['top_js'].percentage, 55);

    // Python: 1800s (30 min, 0.5 h, 27% del total)
    assert.equal(summary.topic_stats['top_py'].seconds, 1800);
    assert.equal(summary.topic_stats['top_py'].minutes, 30);
    assert.equal(summary.topic_stats['top_py'].hours, 0.5);
    assert.equal(summary.topic_stats['top_py'].percentage, 27);

    // Rust: 0s
    assert.equal(summary.topic_stats['top_rust'].seconds, 0);
    assert.equal(summary.topic_stats['top_rust'].minutes, 0);
    assert.equal(summary.topic_stats['top_rust'].percentage, 0);
  });

  await t.test('6. validateSubjectForm valida longitud, unicidad case-insensitive, color y meta', () => {
    const existing = [
      { id: 'sub_1', name: 'Física Clásica' },
      { id: 'sub_2', name: 'Química Orgánica', deleted_at: '2026-10-01T00:00:00Z' }
    ];

    // Vacío
    assert.equal(FocusCore.validateSubjectForm({ name: '' }, existing).valid, false);

    // > 60 caracteres
    assert.equal(FocusCore.validateSubjectForm({ name: 'A'.repeat(61) }, existing).valid, false);

    // Duplicado activo case-insensitive
    const dup = FocusCore.validateSubjectForm({ name: '  física clásica  ' }, existing);
    assert.equal(dup.valid, false);
    assert.ok(dup.errors[0].includes('Ya existe una materia'));

    // Reutilizar nombre de materia borrada -> Aceptado
    assert.equal(FocusCore.validateSubjectForm({ name: 'Química Orgánica' }, existing).valid, true);

    // Edición conservando mismo nombre -> Aceptado
    assert.equal(FocusCore.validateSubjectForm({ name: 'Física Clásica' }, existing, 'sub_1').valid, true);

    // Color inválido
    const badColor = FocusCore.validateSubjectForm({ name: 'Biología', color: 'blue' }, existing);
    assert.equal(badColor.valid, false);
    assert.ok(badColor.errors[0].includes('hexadecimal'));

    // Meta negativa
    const badGoal = FocusCore.validateSubjectForm({ name: 'Biología', weekly_goal_minutes: -15 }, existing);
    assert.equal(badGoal.valid, false);
    assert.ok(badGoal.errors[0].includes('mayor o igual a 0'));

    // Válido completo
    const valid = FocusCore.validateSubjectForm({
      name: 'Biología Celular',
      color: '#10B981',
      weekly_goal_minutes: 180
    }, existing);
    assert.equal(valid.valid, true);
    assert.equal(valid.errors.length, 0);
  });

  await t.test('7. validateTopicForm valida materia asociada, longitud y unicidad por materia', () => {
    const existing = [
      { id: 'top_1', subject_id: 'sub_1', name: 'Cinemática' },
      { id: 'top_2', subject_id: 'sub_2', name: 'Cinemática' } // Mismo nombre pero en otra materia
    ];

    // Sin subject_id
    assert.equal(FocusCore.validateTopicForm({ name: 'Dinámica' }, existing).valid, false);

    // Duplicado en la misma materia
    const dup = FocusCore.validateTopicForm({ subject_id: 'sub_1', name: '  cinemática ' }, existing);
    assert.equal(dup.valid, false);
    assert.ok(dup.errors[0].includes('Ya existe un tema'));

    // Mismo nombre en materia diferente -> Aceptado
    const diffSub = FocusCore.validateTopicForm({ subject_id: 'sub_3', name: 'Cinemática' }, existing);
    assert.equal(diffSub.valid, true);

    // Status inválido
    const badSt = FocusCore.validateTopicForm({ subject_id: 'sub_1', name: 'Dinámica', status: 'xyz' }, existing);
    assert.equal(badSt.valid, false);
    assert.ok(badSt.errors[0].includes('Estado inválido'));

    // Válido
    const ok = FocusCore.validateTopicForm({ subject_id: 'sub_1', name: 'Dinámica', status: 'in_progress' }, existing);
    assert.equal(ok.valid, true);
  });

});
