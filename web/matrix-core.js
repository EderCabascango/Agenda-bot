/**
 * matrix-core.js
 * Vinculación automática de la matriz del ciclo mensual con lo que se hace en la app:
 * - Sesiones de enfoque terminadas (estudio, Capital Laboral, lectura) marcan la fila vinculada
 *   a su materia/habilidad/libro (o la que coincida por nombre).
 * - Entrenos: solo cuentan los completos (todas las series de la rutina; un entreno libre cuenta al guardarse).
 * Lógica pura, probada en Node. Compatible con Node.js (CommonJS) y navegadores web (UMD / Global).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MatrixCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const MIN_SESSION_SECONDS = 60;

  function normalize(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }

  function findRowByLabel(rows, label) {
    const n = normalize(label);
    return n ? (rows || []).find(r => normalize(r.label) === n) || null : null;
  }

  /**
   * Fila de la matriz para una materia/habilidad/libro: la elegida a mano (matrix_row) si existe;
   * si no, la primera fila cuyo nombre o palabra clave aparezca en el nombre de la materia.
   */
  function rowForSubject(subject, rows) {
    if (!subject) return null;
    if (subject.matrix_row) {
      const chosen = findRowByLabel(rows, subject.matrix_row);
      if (chosen) return chosen;
    }
    const name = normalize(subject.name);
    if (!name) return null;
    return (rows || []).find(r =>
      normalize(r.label) === name || (r.keys || []).some(k => normalize(k).length >= 3 && name.includes(normalize(k)))
    ) || null;
  }

  /** Fila de ejercicio: la que tenga "ejercicio" como etiqueta o palabra clave. */
  function exerciseRow(rows) {
    return (rows || []).find(r => normalize(r.label) === 'ejercicio' || (r.keys || []).some(k => normalize(k) === 'ejercicio')) || null;
  }

  /**
   * Un entreno está completo si cubre todas las series objetivo de su rutina.
   * Sin rutina (entreno libre) o con la rutina borrada, cuenta al guardarse.
   */
  function isWorkoutComplete(workout, routine) {
    if (!workout) return false;
    if (!routine || !Array.isArray(routine.exercises) || !routine.exercises.length) return true;
    const done = {};
    (workout.exercises || []).forEach(ex => {
      const key = normalize(ex.name);
      done[key] = (done[key] || 0) + (Array.isArray(ex.sets) ? ex.sets.length : 0);
    });
    return routine.exercises.every(ex => {
      const target = ex.measure === 'cardio' ? 1 : Math.max(1, Number(ex.target_sets) || 1);
      return (done[normalize(ex.name)] || 0) >= target;
    });
  }

  /**
   * Minutos por día y fila que aportan las sesiones de enfoque y los entrenos.
   * `toDateStr(Date)` convierte a la fecha local "YYYY-MM-DD".
   * Devuelve { "YYYY-MM-DD": { "Etiqueta de fila": minutos } }.
   */
  function linkedMinutes({ rows = [], subjects = [], sessions = [], workouts = [], routines = [] } = {}, toDateStr) {
    const out = {};
    const add = (date, label, minutes) => {
      if (!date || !label) return;
      if (!out[date]) out[date] = {};
      out[date][label] = (out[date][label] || 0) + minutes;
    };

    const subjectById = {};
    subjects.forEach(s => { if (s && !s.deleted_at) subjectById[s.id] = s; });
    sessions.forEach(f => {
      if (!f || f.deleted_at || f.status !== 'completed' || !f.subject_id || !f.started_at) return;
      const secs = Number(f.effective_seconds) || 0;
      if (secs < MIN_SESSION_SECONDS) return;
      const row = rowForSubject(subjectById[f.subject_id], rows);
      if (row) add(toDateStr(new Date(f.started_at)), row.label, Math.round(secs / 60));
    });

    const exRow = exerciseRow(rows);
    if (exRow) {
      const routineById = {};
      routines.forEach(r => { if (r && !r.deleted_at) routineById[r.id] = r; });
      workouts.forEach(w => {
        if (!w || w.deleted_at || !w.date) return;
        if (!isWorkoutComplete(w, w.routine_id ? routineById[w.routine_id] : null)) return;
        add(w.date, exRow.label, Number(w.duration_minutes) || 30);
      });
    }
    return out;
  }

  /** Intensidad de la celda (1-3) a partir de minutos, igual que las actividades. */
  function levelForMinutes(minutes) {
    if (minutes >= 120) return 3;
    if (minutes >= 60) return 2;
    return minutes > 0 ? 1 : 0;
  }

  return { normalize, findRowByLabel, rowForSubject, exerciseRow, isWorkoutComplete, linkedMinutes, levelForMinutes };
});
