/**
 * workout-core.js
 * Lógica pura del módulo de ejercicio (calistenia): rutinas, registro, historial, récords y progreso.
 * Fechas como 'AAAA-MM-DD'; semanas de lunes a domingo. Sin DOM ni almacenamiento.
 * Compatible con Node.js (CommonJS) y navegadores web (UMD / Global).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WorkoutCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Palabras que identifican una actividad de la agenda como entreno (mismas que la fila "Ejercicio" de la matriz).
  const EXERCISE_KEYWORDS = ['calistenia', 'ejercicio', 'entreno', 'entrenamiento', 'gym', 'pesas', 'cardio', 'correr', 'yoga'];

  const SUGGESTED_EXERCISES = [
    { name: 'Dominadas', measure: 'reps' },
    { name: 'Flexiones', measure: 'reps' },
    { name: 'Fondos', measure: 'reps' },
    { name: 'Sentadillas', measure: 'reps' },
    { name: 'Remo invertido', measure: 'reps' },
    { name: 'Pistol squat', measure: 'reps' },
    { name: 'Elevaciones de piernas', measure: 'reps' },
    { name: 'Muscle-up', measure: 'reps' },
    { name: 'Plancha', measure: 'time' },
    { name: 'L-sit', measure: 'time' },
    { name: 'Hollow hold', measure: 'time' },
    { name: 'Pino (handstand)', measure: 'time' }
  ];

  function normalizeName(name) {
    return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }

  function isActive(w) {
    return !!w && !w.deleted_at;
  }

  function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // ── Fechas ──
  function parseDate(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  function fmtDate(dt) {
    return dt.toISOString().substring(0, 10);
  }
  function addDays(dateStr, days) {
    const dt = parseDate(dateStr);
    dt.setUTCDate(dt.getUTCDate() + days);
    return fmtDate(dt);
  }
  function weekStart(dateStr) {
    const dt = parseDate(dateStr);
    const dow = (dt.getUTCDay() + 6) % 7; // 0 = lunes
    dt.setUTCDate(dt.getUTCDate() - dow);
    return fmtDate(dt);
  }

  // ── Series y entrenos ──
  /** 1RM estimado (Epley) del lastre: solo con peso añadido y repeticiones. */
  function estimate1RM(weightKg, reps) {
    const w = toNum(weightKg), r = toNum(reps);
    if (!w || !r) return 0;
    return Math.round(w * (1 + r / 30) * 10) / 10;
  }

  function summarizeWorkout(workout) {
    const res = { exercises: 0, sets: 0, reps: 0, seconds: 0, weightedVolume: 0 };
    (workout && Array.isArray(workout.exercises) ? workout.exercises : []).forEach(ex => {
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      if (sets.length) res.exercises += 1;
      sets.forEach(st => {
        res.sets += 1;
        if (ex.measure === 'time') res.seconds += toNum(st.seconds);
        else {
          res.reps += toNum(st.reps);
          res.weightedVolume += toNum(st.reps) * toNum(st.weight_kg);
        }
      });
    });
    res.weightedVolume = Math.round(res.weightedVolume * 10) / 10;
    return res;
  }

  /** Texto corto de unas series: "10 · 8 · 8 reps (+5 kg)" o "60 · 45 s". */
  function formatSets(sets, measure) {
    const list = Array.isArray(sets) ? sets.filter(st => (measure === 'time' ? toNum(st.seconds) : toNum(st.reps)) > 0) : [];
    if (!list.length) return '';
    if (measure === 'time') return `${list.map(st => toNum(st.seconds)).join(' · ')} s`;
    const weights = [...new Set(list.map(st => toNum(st.weight_kg)))];
    const reps = list.map(st => toNum(st.reps)).join(' · ');
    if (weights.length === 1 && weights[0] > 0) return `${reps} reps (+${weights[0]} kg)`;
    if (weights.some(w => w > 0)) return list.map(st => toNum(st.weight_kg) ? `${toNum(st.reps)}@+${toNum(st.weight_kg)}kg` : `${toNum(st.reps)}`).join(' · ') + ' reps';
    return `${reps} reps`;
  }

  /** Cada vez que se hizo un ejercicio, del más reciente al más antiguo. */
  function exerciseHistory(workouts, name, excludeWorkoutId = null) {
    const key = normalizeName(name);
    const rows = [];
    (Array.isArray(workouts) ? workouts : []).filter(isActive).forEach(w => {
      if (excludeWorkoutId && w.id === excludeWorkoutId) return;
      (w.exercises || []).forEach(ex => {
        if (normalizeName(ex.name) !== key) return;
        const sets = (ex.sets || []).filter(st => toNum(st.reps) || toNum(st.seconds));
        if (!sets.length) return;
        rows.push({
          workout_id: w.id,
          date: w.date,
          started_at: w.started_at || '',
          measure: ex.measure || 'reps',
          sets,
          text: formatSets(sets, ex.measure),
          bestReps: Math.max(...sets.map(st => toNum(st.reps))),
          bestSeconds: Math.max(...sets.map(st => toNum(st.seconds))),
          maxWeight: Math.max(...sets.map(st => toNum(st.weight_kg)))
        });
      });
    });
    return rows.sort((a, b) => (b.date + b.started_at).localeCompare(a.date + a.started_at));
  }

  function lastPerformance(workouts, name, excludeWorkoutId = null) {
    return exerciseHistory(workouts, name, excludeWorkoutId)[0] || null;
  }

  /** Récords por ejercicio: más reps en una serie, isométrico más largo, más lastre y mejor 1RM estimado. */
  function personalRecords(workouts) {
    const byKey = {};
    (Array.isArray(workouts) ? workouts : []).filter(isActive).forEach(w => {
      (w.exercises || []).forEach(ex => {
        const key = normalizeName(ex.name);
        if (!key) return;
        const rec = byKey[key] || (byKey[key] = {
          name: ex.name, measure: ex.measure || 'reps', sessions: 0,
          maxReps: 0, maxRepsDate: null, maxSeconds: 0, maxSecondsDate: null,
          maxWeight: 0, maxWeightDate: null, best1RM: 0, best1RMDate: null
        });
        let counted = false;
        (ex.sets || []).forEach(st => {
          const reps = toNum(st.reps), secs = toNum(st.seconds), kg = toNum(st.weight_kg);
          if (reps || secs) counted = true;
          if (reps > rec.maxReps) { rec.maxReps = reps; rec.maxRepsDate = w.date; }
          if (secs > rec.maxSeconds) { rec.maxSeconds = secs; rec.maxSecondsDate = w.date; }
          if (kg > rec.maxWeight) { rec.maxWeight = kg; rec.maxWeightDate = w.date; }
          const orm = estimate1RM(kg, reps);
          if (orm > rec.best1RM) { rec.best1RM = orm; rec.best1RMDate = w.date; }
        });
        if (counted) rec.sessions += 1;
      });
    });
    return Object.values(byKey).filter(r => r.sessions > 0).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  }

  /** Serie semanal (últimas `weeks` semanas hasta la de `today`) para la gráfica de evolución. */
  function weeklySeries(workouts, { today, weeks = 8, exerciseName = null } = {}) {
    const lastWeek = weekStart(today);
    const series = [];
    for (let i = weeks - 1; i >= 0; i--) {
      series.push({ weekStart: addDays(lastWeek, -7 * i), workouts: 0, reps: 0, seconds: 0, best1RM: 0, bestReps: 0 });
    }
    const index = Object.fromEntries(series.map((s, i) => [s.weekStart, i]));
    const key = exerciseName ? normalizeName(exerciseName) : null;
    (Array.isArray(workouts) ? workouts : []).filter(isActive).forEach(w => {
      if (!w.date) return;
      const idx = index[weekStart(w.date)];
      if (idx === undefined) return;
      const bucket = series[idx];
      let touched = false;
      (w.exercises || []).forEach(ex => {
        if (key && normalizeName(ex.name) !== key) return;
        (ex.sets || []).forEach(st => {
          const reps = toNum(st.reps), secs = toNum(st.seconds);
          if (!reps && !secs) return;
          touched = true;
          if (ex.measure === 'time') bucket.seconds += secs;
          else {
            bucket.reps += reps;
            bucket.bestReps = Math.max(bucket.bestReps, reps);
            bucket.best1RM = Math.max(bucket.best1RM, estimate1RM(st.weight_kg, reps));
          }
        });
      });
      if (touched || !key) bucket.workouts += 1;
    });
    return series;
  }

  /** Resumen de la semana actual y racha de semanas seguidas entrenando (hasta la actual o la anterior). */
  function weeklySummary(workouts, today) {
    const active = (Array.isArray(workouts) ? workouts : []).filter(w => isActive(w) && w.date);
    const thisWeek = weekStart(today);
    const prevWeek = addDays(thisWeek, -7);
    const res = { workouts: 0, sets: 0, reps: 0, seconds: 0, minutes: 0, previousWeekWorkouts: 0, weekStreak: 0 };
    const weeksWithWorkout = new Set();
    active.forEach(w => {
      const ws = weekStart(w.date);
      weeksWithWorkout.add(ws);
      if (ws === prevWeek) res.previousWeekWorkouts += 1;
      if (ws !== thisWeek) return;
      const s = summarizeWorkout(w);
      res.workouts += 1;
      res.sets += s.sets;
      res.reps += s.reps;
      res.seconds += s.seconds;
      res.minutes += toNum(w.duration_minutes);
    });
    let cursor = weeksWithWorkout.has(thisWeek) ? thisWeek : prevWeek;
    while (weeksWithWorkout.has(cursor)) {
      res.weekStreak += 1;
      cursor = addDays(cursor, -7);
    }
    return res;
  }

  /** Borrador de entreno a partir de una rutina: series objetivo precargadas y "la última vez" de cada ejercicio. */
  function buildDraftFromRoutine(routine, workouts) {
    const exercises = (routine && Array.isArray(routine.exercises) ? routine.exercises : []).map(ex => {
      const last = lastPerformance(workouts, ex.name);
      const lastWeight = last ? last.maxWeight : 0;
      const count = Math.max(1, toNum(ex.target_sets) || 1);
      const sets = Array.from({ length: count }, () => ({
        reps: ex.measure === 'time' ? 0 : toNum(ex.target_reps),
        seconds: ex.measure === 'time' ? toNum(ex.target_seconds) : 0,
        weight_kg: lastWeight
      }));
      return { name: ex.name, measure: ex.measure || 'reps', sets, last: last ? `${last.date}: ${last.text}` : '' };
    });
    return { routine_id: routine ? routine.id : null, exercises };
  }

  function isExerciseActivity(activity) {
    if (!activity) return false;
    const words = [activity.title || '', ...(Array.isArray(activity.tags) ? activity.tags : [])].map(normalizeName).join(' ');
    return EXERCISE_KEYWORDS.some(k => words.includes(k));
  }

  function validateRoutine(routine) {
    const errors = [];
    if (!routine || !String(routine.name || '').trim()) errors.push('Ponle un nombre a la rutina.');
    if (routine && String(routine.name || '').length > 80) errors.push('El nombre no puede pasar de 80 caracteres.');
    const exs = routine && Array.isArray(routine.exercises) ? routine.exercises : [];
    if (!exs.length) errors.push('Agrega al menos un ejercicio.');
    if (exs.some(ex => !String(ex.name || '').trim())) errors.push('Todos los ejercicios necesitan nombre.');
    if (exs.length > 40) errors.push('Máximo 40 ejercicios por rutina.');
    return { valid: errors.length === 0, errors };
  }

  function validateWorkout(workout) {
    const errors = [];
    const exs = workout && Array.isArray(workout.exercises) ? workout.exercises : [];
    if (!workout || !/^\d{4}-\d{2}-\d{2}$/.test(String(workout.date || ''))) errors.push('La fecha del entreno no es válida.');
    if (exs.some(ex => !String(ex.name || '').trim())) errors.push('Todos los ejercicios necesitan nombre.');
    if (summarizeWorkout(workout).sets === 0 || !exs.some(ex => (ex.sets || []).some(st => toNum(st.reps) || toNum(st.seconds)))) {
      errors.push('Registra al menos una serie con repeticiones o segundos.');
    }
    return { valid: errors.length === 0, errors };
  }

  return {
    EXERCISE_KEYWORDS,
    SUGGESTED_EXERCISES,
    normalizeName,
    weekStart,
    addDays,
    estimate1RM,
    summarizeWorkout,
    formatSets,
    exerciseHistory,
    lastPerformance,
    personalRecords,
    weeklySeries,
    weeklySummary,
    buildDraftFromRoutine,
    isExerciseActivity,
    validateRoutine,
    validateWorkout
  };
});
