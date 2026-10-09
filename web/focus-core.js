/**
 * focus-core.js
 * Módulo de lógica pura para materias, temas, metas y métricas de estudio (Fase B).
 * Compatible con Node.js (CommonJS) y navegadores web (UMD / Global).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FocusCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================================================================
  // 1. SEMILLAS SUGERIDAS (SEEDS DETERMINISTAS)
  // ============================================================================

  const SUGGESTED_SEEDS = {
    subjects: [
      {
        id: 'subject-seed-ingles',
        name: 'Inglés',
        color: '#3B82F6',
        icon: 'language',
        weekly_goal_minutes: 300,
        archived: 0
      },
      {
        id: 'subject-seed-genai',
        name: 'GenAI & LLMs',
        color: '#8B5CF6',
        icon: 'psychology',
        weekly_goal_minutes: 360,
        archived: 0
      },
      {
        id: 'subject-seed-mlops',
        name: 'MLOps & Cloud',
        color: '#10B981',
        icon: 'cloud',
        weekly_goal_minutes: 240,
        archived: 0
      },
      {
        id: 'subject-seed-spark',
        name: 'Apache Spark & Big Data',
        color: '#F59E0B',
        icon: 'dataset',
        weekly_goal_minutes: 240,
        archived: 0
      }
    ],
    topics: [
      // Inglés
      {
        id: 'topic-seed-ingles-vocabulario',
        subject_id: 'subject-seed-ingles',
        name: 'Vocabulario y Speaking',
        status: 'pending'
      },
      {
        id: 'topic-seed-ingles-gramatica',
        subject_id: 'subject-seed-ingles',
        name: 'Gramática y Listening',
        status: 'pending'
      },
      // GenAI
      {
        id: 'topic-seed-genai-prompting',
        subject_id: 'subject-seed-genai',
        name: 'Prompt Engineering & RAG',
        status: 'pending'
      },
      {
        id: 'topic-seed-genai-fine-tuning',
        subject_id: 'subject-seed-genai',
        name: 'Fine-tuning & Evaluación',
        status: 'pending'
      },
      // MLOps
      {
        id: 'topic-seed-mlops-ci-cd',
        subject_id: 'subject-seed-mlops',
        name: 'CI/CD para Machine Learning',
        status: 'pending'
      },
      {
        id: 'topic-seed-mlops-docker',
        subject_id: 'subject-seed-mlops',
        name: 'Docker & Despliegues',
        status: 'pending'
      },
      // Spark
      {
        id: 'topic-seed-spark-dataframes',
        subject_id: 'subject-seed-spark',
        name: 'PySpark DataFrames & SQL',
        status: 'pending'
      },
      {
        id: 'topic-seed-spark-streaming',
        subject_id: 'subject-seed-spark',
        name: 'Structured Streaming & Optimización',
        status: 'pending'
      }
    ]
  };

  // ============================================================================
  // 2. PLANIFICACIÓN DE CREACIÓN DE SEMILLAS (create_if_absent)
  // ============================================================================

  function planSeedCreation(localSubjects = [], localTopics = [], serverSubjects = [], serverTopics = []) {
    const existingSubjectIds = new Set();
    const existingTopicIds = new Set();

    (localSubjects || []).forEach(s => s && s.id && existingSubjectIds.add(s.id));
    (serverSubjects || []).forEach(s => s && s.id && existingSubjectIds.add(s.id));
    (localTopics || []).forEach(t => t && t.id && existingTopicIds.add(t.id));
    (serverTopics || []).forEach(t => t && t.id && existingTopicIds.add(t.id));

    const now = new Date().toISOString();

    const subjectChanges = SUGGESTED_SEEDS.subjects.map(seed => ({
      id: seed.id,
      name: seed.name,
      color: seed.color,
      icon: seed.icon,
      weekly_goal_minutes: seed.weekly_goal_minutes,
      archived: 0,
      op: 'create_if_absent',
      created_at: now,
      updated_at: now,
      deleted_at: null,
      version: 1
    }));

    const topicChanges = SUGGESTED_SEEDS.topics.map(seed => ({
      id: seed.id,
      subject_id: seed.subject_id,
      name: seed.name,
      status: seed.status,
      op: 'create_if_absent',
      created_at: now,
      updated_at: now,
      deleted_at: null,
      version: 1
    }));

    return {
      subjects: subjectChanges,
      topics: topicChanges,
      total_items: subjectChanges.length + topicChanges.length
    };
  }

  // ============================================================================
  // 3. DECISIÓN DE ELIMINACIÓN O ARCHIVADO DE MATERIA
  // ============================================================================

  function decideSubjectRemoval(subject, sessions = [], notes = [], childTopics = []) {
    if (!subject || !subject.id) {
      return { action: 'noop', reason: 'invalid_subject' };
    }

    const activeSessions = (sessions || []).filter(
      s => s && s.subject_id === subject.id && !s.deleted_at
    );

    const activeNotes = (notes || []).filter(
      n => n && !n.deleted_at && (
        n.subject_id === subject.id ||
        (Array.isArray(n.topic_ids) && (childTopics || []).some(t => t && t.id && n.topic_ids.includes(t.id)))
      )
    );

    const now = new Date().toISOString();

    if (activeSessions.length > 0 || activeNotes.length > 0) {
      return {
        action: 'archive',
        reason: 'has_history',
        session_count: activeSessions.length,
        note_count: activeNotes.length,
        subjectPatch: {
          id: subject.id,
          archived: 1,
          base_version: subject.version || 1,
          updated_at: now
        }
      };
    } else {
      const topicTombstones = (childTopics || [])
        .filter(t => t && t.subject_id === subject.id && !t.deleted_at)
        .map(t => ({
          id: t.id,
          subject_id: t.subject_id,
          base_version: t.version || 1,
          deleted_at: now,
          updated_at: now
        }));

      return {
        action: 'delete',
        reason: 'no_history',
        session_count: 0,
        note_count: 0,
        subjectPatch: {
          id: subject.id,
          base_version: subject.version || 1,
          deleted_at: now,
          updated_at: now
        },
        topicTombstones: topicTombstones
      };
    }
  }

  // ============================================================================
  // 4. RESUMEN Y MÉTRICAS DE MATERIA Y TEMAS (REPARTO EQUITATIVO DE SEGUNDOS)
  // ============================================================================

  function summarizeSubject(subject, topics = [], sessions = []) {
    if (!subject || !subject.id) {
      return {
        total_seconds: 0,
        total_minutes: 0,
        total_hours: 0,
        session_count: 0,
        topic_stats: {},
        goal_progress_percent: 0
      };
    }

    const subjectTopics = (topics || []).filter(
      t => t && t.subject_id === subject.id && !t.deleted_at
    );
    const validTopicIds = new Set(subjectTopics.map(t => t.id));

    const activeSessions = (sessions || []).filter(
      s => s && s.subject_id === subject.id && !s.deleted_at
    );

    let totalEffectiveSeconds = 0;
    const topicStats = {};

    subjectTopics.forEach(t => {
      topicStats[t.id] = {
        topic_id: t.id,
        name: t.name,
        status: t.status || 'pending',
        seconds: 0,
        minutes: 0,
        hours: 0,
        percentage: 0
      };
    });

    activeSessions.forEach(session => {
      const effSec = Number(session.effective_seconds) || 0;
      totalEffectiveSeconds += effSec;

      let sessionTopicIds = Array.isArray(session.topic_ids) ? session.topic_ids : [];
      sessionTopicIds = sessionTopicIds.filter(tid => validTopicIds.has(tid));

      if (sessionTopicIds.length > 0) {
        const splitSec = effSec / sessionTopicIds.length;
        sessionTopicIds.forEach(tid => {
          if (topicStats[tid]) {
            topicStats[tid].seconds += splitSec;
          }
        });
      }
    });

    // Calcular minutos, horas y porcentajes
    Object.keys(topicStats).forEach(tid => {
      const stat = topicStats[tid];
      stat.minutes = Math.round(stat.seconds / 60);
      stat.hours = Number((stat.seconds / 3600).toFixed(2));
      stat.percentage = totalEffectiveSeconds > 0
        ? Math.round((stat.seconds / totalEffectiveSeconds) * 100)
        : 0;
    });

    const totalMinutes = Math.round(totalEffectiveSeconds / 60);
    const totalHours = Number((totalEffectiveSeconds / 3600).toFixed(2));

    const weeklyGoalMinutes = Number(subject.weekly_goal_minutes) || 0;
    const goalProgressPercent = weeklyGoalMinutes > 0
      ? Math.min(100, Math.round((totalMinutes / weeklyGoalMinutes) * 100))
      : 0;

    return {
      subject_id: subject.id,
      name: subject.name,
      color: subject.color || '#3B82F6',
      icon: subject.icon || 'book',
      archived: !!subject.archived,
      total_seconds: totalEffectiveSeconds,
      total_minutes: totalMinutes,
      total_hours: totalHours,
      weekly_goal_minutes: weeklyGoalMinutes,
      goal_progress_percent: goalProgressPercent,
      session_count: activeSessions.length,
      topic_count: subjectTopics.length,
      topic_stats: topicStats
    };
  }

  // ============================================================================
  // 5. VALIDACIÓN DE FORMULARIOS
  // ============================================================================

  function validateSubjectForm(data = {}, existingSubjects = [], currentId = null) {
    const errors = [];
    const name = (data.name || '').trim();

    if (!name || name.length < 1) {
      errors.push('El nombre de la materia es requerido');
    } else if (name.length > 60) {
      errors.push('El nombre no puede superar 60 caracteres');
    }

    const nameLower = name.toLowerCase();
    const isDuplicate = (existingSubjects || []).some(s =>
      s &&
      !s.deleted_at &&
      s.id !== currentId &&
      (s.name || '').trim().toLowerCase() === nameLower
    );

    if (isDuplicate) {
      errors.push(`Ya existe una materia con el nombre "${name}"`);
    }

    const color = (data.color || '').trim();
    if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      errors.push('El color debe tener formato hexadecimal válido (#RRGGBB)');
    }

    if (data.weekly_goal_minutes !== undefined && data.weekly_goal_minutes !== null && data.weekly_goal_minutes !== '') {
      const goal = Number(data.weekly_goal_minutes);
      if (isNaN(goal) || goal < 0) {
        errors.push('La meta semanal en minutos debe ser mayor o igual a 0');
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  function validateTopicForm(data = {}, existingTopics = [], currentId = null) {
    const errors = [];
    const name = (data.name || '').trim();
    const subjectId = data.subject_id;

    if (!subjectId) {
      errors.push('La materia asociada es requerida para el tema');
    }

    if (!name || name.length < 1) {
      errors.push('El nombre del tema es requerido');
    } else if (name.length > 60) {
      errors.push('El nombre no puede superar 60 caracteres');
    }

    const nameLower = name.toLowerCase();
    const isDuplicate = (existingTopics || []).some(t =>
      t &&
      !t.deleted_at &&
      t.subject_id === subjectId &&
      t.id !== currentId &&
      (t.name || '').trim().toLowerCase() === nameLower
    );

    if (isDuplicate) {
      errors.push(`Ya existe un tema con el nombre "${name}" en esta materia`);
    }

    if (data.status) {
      const allowedStatuses = ['pending', 'in_progress', 'mastered'];
      if (!allowedStatuses.includes(data.status)) {
        errors.push(`Estado inválido: ${data.status}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  return {
    SUGGESTED_SEEDS,
    planSeedCreation,
    decideSubjectRemoval,
    summarizeSubject,
    validateSubjectForm,
    validateTopicForm
  };
});
