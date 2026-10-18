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
      assert.equal(top.status, 'pending');
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

  await t.test('5. summarizeSubject calcula minutos, horas y reparto equitativo, separando total histórico de la semana en curso', () => {
    const subject = {
      id: 'sub_prog',
      name: 'Programación',
      weekly_goal_minutes: 120 // Meta semanal: 2 horas (120 min)
    };
    const topics = [
      { id: 'top_js', subject_id: 'sub_prog', name: 'JavaScript', status: 'in_progress' },
      { id: 'top_py', subject_id: 'sub_prog', name: 'Python', status: 'mastered' },
      { id: 'top_rust', subject_id: 'sub_prog', name: 'Rust', status: 'pending' }
    ];
    // Referencia temporal: Jueves 2026-10-15 (Semana: Lun 2026-10-12 a Dom 2026-10-18)
    const sessions = [
      // Sesión Antigua (semana previa: 2026-10-05): 3600 segundos (60 min)
      {
        id: 'sess_old',
        subject_id: 'sub_prog',
        topic_ids: ['top_js'],
        started_at: '2026-10-05T10:00:00.000Z',
        ended_at: '2026-10-05T11:00:00.000Z',
        focus_intervals: [['2026-10-05T10:00:00.000Z', '2026-10-05T11:00:00.000Z']],
        effective_seconds: 3600,
        deleted_at: null
      },
      // Sesión Esta Semana 1 (2026-10-13): 3600 segundos (60 min) divididos entre JS y Python (30 min c/u)
      {
        id: 'sess_1',
        subject_id: 'sub_prog',
        topic_ids: ['top_js', 'top_py'],
        started_at: '2026-10-13T10:00:00.000Z',
        ended_at: '2026-10-13T11:00:00.000Z',
        focus_intervals: [['2026-10-13T10:00:00.000Z', '2026-10-13T11:00:00.000Z']],
        effective_seconds: 3600,
        deleted_at: null
      },
      // Sesión Esta Semana 2 (2026-10-15): 1800 segundos (30 min) solo JS
      {
        id: 'sess_2',
        subject_id: 'sub_prog',
        topic_ids: ['top_js'],
        started_at: '2026-10-15T14:00:00.000Z',
        ended_at: '2026-10-15T14:30:00.000Z',
        focus_intervals: [['2026-10-15T14:00:00.000Z', '2026-10-15T14:30:00.000Z']],
        effective_seconds: 1800,
        deleted_at: null
      },
      // Sesión borrada (tombstone) debe ser ignorada
      {
        id: 'sess_del',
        subject_id: 'sub_prog',
        topic_ids: ['top_rust'],
        started_at: '2026-10-15T16:00:00.000Z',
        effective_seconds: 9999,
        deleted_at: '2026-10-15T17:00:00Z'
      }
    ];

    const summary = FocusCore.summarizeSubject(subject, topics, sessions, {
      todayStr: '2026-10-15',
      ianaTimezone: 'UTC'
    });

    // Total histórico acumulado: 3600 (antigua) + 3600 + 1800 = 9000 segundos (150 min = 2.50 horas)
    assert.equal(summary.total_seconds, 9000);
    assert.equal(summary.total_minutes, 150);
    assert.equal(summary.total_hours, 2.5);
    assert.equal(summary.session_count, 3);

    // Total de esta semana en curso (L-D): 3600 + 1800 = 5400 segundos (90 min = 1.50 horas)
    assert.equal(summary.week_seconds, 5400);
    assert.equal(summary.week_minutes, 90);
    assert.equal(summary.week_hours, 1.5);

    // Progreso semanal hacia la meta de 120 min: 90 / 120 = 75% (NO el 125% del total histórico)
    assert.equal(summary.goal_progress_percent, 75);

    // JS acumulado: 3600 (antigua) + 1800 (sess_1) + 1800 (sess_2) = 7200s (120 min, 2.0 h, 80%)
    assert.equal(summary.topic_stats['top_js'].seconds, 7200);
    assert.equal(summary.topic_stats['top_js'].minutes, 120);
    assert.equal(summary.topic_stats['top_js'].hours, 2);
    assert.equal(summary.topic_stats['top_js'].percentage, 80);

    // Python acumulado: 1800s (30 min, 0.5 h, 20%)
    assert.equal(summary.topic_stats['top_py'].seconds, 1800);
    assert.equal(summary.topic_stats['top_py'].minutes, 30);
    assert.equal(summary.topic_stats['top_py'].hours, 0.5);
    assert.equal(summary.topic_stats['top_py'].percentage, 20);
  });

  await t.test('6. summarizeSubject con sesiones que referencian subtemas inexistentes, de otra materia o con tombstone acumula segundos a la materia sin error', () => {
    const subject = {
      id: 'sub_main',
      name: 'Arquitectura',
      weekly_goal_minutes: 60
    };
    const topics = [
      { id: 'top_valid', subject_id: 'sub_main', name: 'Microservicios', status: 'in_progress' },
      { id: 'top_deleted', subject_id: 'sub_main', name: 'Monolito', status: 'pending', deleted_at: '2026-10-09T00:00:00Z' },
      { id: 'top_other_sub', subject_id: 'sub_other', name: 'Química', status: 'pending' }
    ];
    const sessions = [
      // Sesión con topic inexistente ('top_non_existent') y topic de otra materia ('top_other_sub')
      {
        id: 'sess_orphan',
        subject_id: 'sub_main',
        topic_ids: ['top_non_existent', 'top_other_sub'],
        effective_seconds: 1200, // 20 min
        deleted_at: null
      },
      // Sesión con topic borrado ('top_deleted') y topic válido ('top_valid')
      {
        id: 'sess_mixed',
        subject_id: 'sub_main',
        topic_ids: ['top_deleted', 'top_valid'],
        effective_seconds: 2400, // 40 min -> Solo 'top_valid' es válido, se le asigna 2400s
        deleted_at: null
      }
    ];

    const summary = FocusCore.summarizeSubject(subject, topics, sessions);

    // Total segundos para la materia: 1200 + 2400 = 3600 segundos (60 minutos = 1.0 hora)
    assert.equal(summary.total_seconds, 3600);
    assert.equal(summary.total_minutes, 60);
    assert.equal(summary.total_hours, 1);
    assert.equal(summary.session_count, 2);
    assert.equal(summary.goal_progress_percent, 100);

    // Topic válido se lleva los 2400s de la sesión mixed
    assert.equal(summary.topic_stats['top_valid'].seconds, 2400);
    assert.equal(summary.topic_stats['top_valid'].minutes, 40);

    // El topic borrado NO debe estar en topic_stats
    assert.equal(summary.topic_stats['top_deleted'], undefined);
    // El topic de otra materia NO debe estar en topic_stats
    assert.equal(summary.topic_stats['top_other_sub'], undefined);
  });

  await t.test('7. validateSubjectForm valida longitud, unicidad case-insensitive, color y meta', () => {
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

  await t.test('8. validateTopicForm valida materia asociada, longitud, unicidad por materia y los 3 estados permitidos (pending, in_progress, mastered)', () => {
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

    // Status inválido (ej. 'not_started' legacy o 'xyz')
    const badSt = FocusCore.validateTopicForm({ subject_id: 'sub_1', name: 'Dinámica', status: 'not_started' }, existing);
    assert.equal(badSt.valid, false);
    assert.ok(badSt.errors[0].includes('Estado inválido'));

    // Todos los 3 estados permitidos son válidos
    const allowed = ['pending', 'in_progress', 'mastered'];
    allowed.forEach(status => {
      const res = FocusCore.validateTopicForm({ subject_id: 'sub_1', name: `Dinámica ${status}`, status }, existing);
      assert.equal(res.valid, true, `Estado ${status} debe ser válido`);
    });
  });

  await t.test('9. shouldAllowFocusDefault calcula allow_focus por etiquetas, soporta lista personalizada y respeta override explícito', () => {
    // 1. Tags matching default allowed tags
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['estudio'] }), true);
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['proyectos'] }), true);
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['IA'] }), true);
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['idiomas'] }), true);

    // 2. Non-matching tags
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['salud'], category: 'salud' }), false);
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['alimentación'] }), false);
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['entretenimiento'] }), false);

    // 3. Custom focus tags list in settings
    const customSettings = { defaultFocusTags: ['fitness', 'cocina'] };
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['fitness'] }, customSettings), true);
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['estudio'] }, customSettings), false);

    // 4. Explicit user override takes precedence over rule
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['salud'], allow_focus: true }), true);
    assert.equal(FocusCore.shouldAllowFocusDefault({ tags: ['estudio'], allow_focus: false }), false);
  });

  await t.test('10. planSpacedReviews programa repasos a 1, 3, 7 y 21 días cruzando meses y años', () => {
    const plan = FocusCore.planSpacedReviews('2026-12-28', 'Inglés - Phrasal verbs');
    assert.deepEqual(plan.map(r => r.days), [1, 3, 7, 21]);
    assert.deepEqual(plan.map(r => r.date), ['2026-12-29', '2026-12-31', '2027-01-04', '2027-01-18']);
    assert.equal(plan[0].title, 'Repaso 1/4: Inglés - Phrasal verbs');
    assert.equal(plan[3].title, 'Repaso 4/4: Inglés - Phrasal verbs');

    assert.equal(FocusCore.planSpacedReviews('2026-02-27', '')[1].date, '2026-03-02', 'Febrero no bisiesto');
    assert.equal(FocusCore.planSpacedReviews('2026-02-27', '')[0].title, 'Repaso 1/4: Nota de aprendizaje');
    assert.deepEqual(FocusCore.planSpacedReviews('fecha-mala', 'x'), []);
    assert.deepEqual(FocusCore.planSpacedReviews('2026-10-17', 'x', [2]).map(r => r.date), ['2026-10-19']);
  });

});
