/**
 * workout-core.js
 * Lógica pura del módulo de ejercicio (calistenia + cardio): rutinas, registro, historial, récords,
 * progreso, plan semanal y entreno guiado por pasos (series y descansos cronometrados).
 * Fechas como 'AAAA-MM-DD'; semanas de lunes a domingo; días de rutina 0 = lunes … 6 = domingo.
 * El modo guiado se calcula con marcas de tiempo (ms), nunca con contadores, para que siga siendo
 * correcto si el teléfono bloquea la pantalla o se recarga la página. Sin DOM ni almacenamiento.
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
  const EXERCISE_KEYWORDS = ['calistenia', 'ejercicio', 'entreno', 'entrenamiento', 'gym', 'pesas', 'cardio', 'correr', 'caminar', 'yoga'];
  const CARDIO_KEYWORDS = ['correr', 'caminar', 'cardio', 'trotar', 'bici', 'running'];
  const DAY_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const DAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const DEFAULT_REST_SECONDS = 60;

  const SUGGESTED_EXERCISES = [
    { name: 'Dominadas', measure: 'reps' },
    { name: 'Flexiones', measure: 'reps' },
    { name: 'Fondos', measure: 'reps' },
    { name: 'Fondos en silla', measure: 'reps' },
    { name: 'Sentadillas', measure: 'reps' },
    { name: 'Sentadilla con mochila', measure: 'reps' },
    { name: 'Sentadilla búlgara', measure: 'reps' },
    { name: 'Zancadas', measure: 'reps' },
    { name: 'Remo con mochila', measure: 'reps' },
    { name: 'Remo invertido', measure: 'reps' },
    { name: 'Puente de glúteo', measure: 'reps' },
    { name: 'Elevación de talones', measure: 'reps' },
    { name: 'Burpees', measure: 'reps' },
    { name: 'Dead bug', measure: 'reps' },
    { name: 'Superman', measure: 'reps' },
    { name: 'Pistol squat', measure: 'reps' },
    { name: 'Elevaciones de piernas', measure: 'reps' },
    { name: 'Muscle-up', measure: 'reps' },
    { name: 'Plancha', measure: 'time' },
    { name: 'Plancha lateral', measure: 'time' },
    { name: 'Jumping jacks', measure: 'time' },
    { name: 'Mountain climbers', measure: 'time' },
    { name: 'Calentamiento', measure: 'time' },
    { name: 'Estiramientos', measure: 'time' },
    { name: 'L-sit', measure: 'time' },
    { name: 'Hollow hold', measure: 'time' },
    { name: 'Pino (handstand)', measure: 'time' },
    { name: 'Caminar', measure: 'cardio' },
    { name: 'Correr suave', measure: 'cardio' }
  ];

  // Plan sugerido (principiante, sin barra, mochila como lastre; salud y resistencia). Ids fijos:
  // cargarlo en varios dispositivos no duplica rutinas.
  const r = (name, sets, min, max, rest) => ({ name, measure: 'reps', target_sets: sets, target_reps_min: min, target_reps_max: max, target_seconds: 0, rest_seconds: rest });
  const t = (name, sets, seconds, rest) => ({ name, measure: 'time', target_sets: sets, target_reps_min: 0, target_reps_max: 0, target_seconds: seconds, rest_seconds: rest });
  const c = (name, minutes) => ({ name, measure: 'cardio', target_sets: 1, target_reps_min: 0, target_reps_max: 0, target_seconds: minutes * 60, rest_seconds: 0 });
  const SUGGESTED_PLAN = [
    { id: 'plan-a', name: 'A · Full body', days: [0], notes: 'Técnica antes que velocidad. Si completas el rango alto dos sesiones seguidas, sube 2 reps o mete peso en la mochila.', exercises: [
      t('Calentamiento', 1, 300, 30), r('Sentadillas', 3, 12, 15, 60), r('Flexiones', 3, 8, 12, 60), r('Remo con mochila', 3, 10, 12, 60),
      r('Zancadas', 3, 8, 10, 60), r('Puente de glúteo', 3, 12, 15, 45), t('Plancha', 3, 30, 45), t('Estiramientos', 1, 300, 0)
    ] },
    { id: 'plan-caminar', name: 'Caminar', days: [1], notes: 'Paso ligero, que puedas hablar pero no cantar.', exercises: [c('Caminar', 45)] },
    { id: 'plan-b', name: 'B · Circuito resistencia', days: [2], notes: 'Descansos cortos: el objetivo es mantener el ritmo.', exercises: [
      t('Calentamiento', 1, 300, 30), t('Jumping jacks', 3, 45, 30), r('Sentadilla con mochila', 3, 10, 12, 45), r('Flexiones', 3, 8, 12, 45),
      t('Mountain climbers', 3, 30, 30), r('Remo con mochila', 3, 10, 12, 45), r('Burpees', 3, 5, 8, 60), r('Dead bug', 3, 8, 10, 30), t('Estiramientos', 1, 300, 0)
    ] },
    { id: 'plan-correr', name: 'Correr suave', days: [3], notes: 'Alterna 2 min corriendo suave y 1 min caminando. Si te ahogas, camina más.', exercises: [c('Correr suave', 30)] },
    { id: 'plan-c', name: 'C · Pierna, core y movilidad', days: [4], notes: 'Controla la bajada en cada repetición.', exercises: [
      t('Calentamiento', 1, 300, 30), r('Sentadilla búlgara', 3, 8, 10, 60), r('Puente de glúteo a una pierna', 3, 8, 10, 45), r('Elevación de talones', 3, 15, 20, 30),
      r('Fondos en silla', 3, 6, 10, 60), r('Superman', 3, 10, 12, 30), t('Plancha lateral', 3, 20, 30), t('Estiramientos', 1, 300, 0)
    ] }
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
  function weekdayIndex(dateStr) {
    return (parseDate(dateStr).getUTCDay() + 6) % 7; // 0 = lunes
  }
  function weekStart(dateStr) {
    return addDays(dateStr, -weekdayIndex(dateStr));
  }

  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }

  // ── Series y entrenos ──
  /** 1RM estimado (Epley) del lastre: solo con peso añadido y repeticiones. */
  function estimate1RM(weightKg, reps) {
    const w = toNum(weightKg), rp = toNum(reps);
    if (!w || !rp) return 0;
    return Math.round(w * (1 + rp / 30) * 10) / 10;
  }

  function summarizeWorkout(workout) {
    const res = { exercises: 0, sets: 0, reps: 0, seconds: 0, weightedVolume: 0, cardioSeconds: 0, distanceKm: 0 };
    (workout && Array.isArray(workout.exercises) ? workout.exercises : []).forEach(ex => {
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      if (sets.length) res.exercises += 1;
      sets.forEach(st => {
        res.sets += 1;
        if (ex.measure === 'cardio') {
          res.cardioSeconds += toNum(st.seconds);
          res.distanceKm += toNum(st.distance_km);
        } else if (ex.measure === 'time') res.seconds += toNum(st.seconds);
        else {
          res.reps += toNum(st.reps);
          res.weightedVolume += toNum(st.reps) * toNum(st.weight_kg);
        }
      });
    });
    res.weightedVolume = Math.round(res.weightedVolume * 10) / 10;
    res.distanceKm = Math.round(res.distanceKm * 100) / 100;
    return res;
  }

  function setHasData(st, measure) {
    if (measure === 'cardio') return toNum(st.seconds) > 0 || toNum(st.distance_km) > 0;
    return toNum(st.reps) > 0 || toNum(st.seconds) > 0;
  }

  /** Texto corto de unas series: "10 · 8 · 8 reps (+5 kg)", "60 · 45 s" o "45 min · 4.2 km". */
  function formatSets(sets, measure) {
    const list = Array.isArray(sets) ? sets.filter(st => setHasData(st, measure) && (measure === 'time' ? toNum(st.seconds) : measure === 'cardio' ? true : toNum(st.reps)) > 0) : [];
    if (!list.length) return '';
    if (measure === 'cardio') {
      return list.map(st => {
        const parts = [];
        if (toNum(st.seconds)) parts.push(`${Math.round(toNum(st.seconds) / 60)} min`);
        if (toNum(st.distance_km)) parts.push(`${toNum(st.distance_km)} km`);
        return parts.join(' · ');
      }).join(' + ');
    }
    if (measure === 'time') return `${list.map(st => toNum(st.seconds)).join(' · ')} s`;
    const weights = [...new Set(list.map(st => toNum(st.weight_kg)))];
    const reps = list.map(st => toNum(st.reps)).join(' · ');
    if (weights.length === 1 && weights[0] > 0) return `${reps} reps (+${weights[0]} kg)`;
    if (weights.some(w => w > 0)) return list.map(st => toNum(st.weight_kg) ? `${toNum(st.reps)}@+${toNum(st.weight_kg)}kg` : `${toNum(st.reps)}`).join(' · ') + ' reps';
    return `${reps} reps`;
  }

  /** Objetivo de un ejercicio de rutina: "10–15 reps", "12 reps", "30 s" o "45 min". */
  function formatTarget(ex) {
    if (!ex) return '';
    if (ex.measure === 'cardio') return `${Math.round(toNum(ex.target_seconds) / 60)} min`;
    if (ex.measure === 'time') return `${toNum(ex.target_seconds)} s`;
    const min = toNum(ex.target_reps_min || ex.target_reps), max = toNum(ex.target_reps_max || ex.target_reps);
    if (!min && !max) return 'reps libres';
    return min && max && max > min ? `${min}–${max} reps` : `${max || min} reps`;
  }

  /** Cada vez que se hizo un ejercicio, del más reciente al más antiguo. */
  function exerciseHistory(workouts, name, excludeWorkoutId = null) {
    const key = normalizeName(name);
    const rows = [];
    (Array.isArray(workouts) ? workouts : []).filter(isActive).forEach(w => {
      if (excludeWorkoutId && w.id === excludeWorkoutId) return;
      (w.exercises || []).forEach(ex => {
        if (normalizeName(ex.name) !== key) return;
        const sets = (ex.sets || []).filter(st => setHasData(st, ex.measure));
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
          maxWeight: Math.max(...sets.map(st => toNum(st.weight_kg))),
          distanceKm: Math.round(sets.reduce((a, st) => a + toNum(st.distance_km), 0) * 100) / 100
        });
      });
    });
    return rows.sort((a, b) => (b.date + b.started_at).localeCompare(a.date + a.started_at));
  }

  function lastPerformance(workouts, name, excludeWorkoutId = null) {
    return exerciseHistory(workouts, name, excludeWorkoutId)[0] || null;
  }

  /** Récords por ejercicio: reps en una serie, isométrico, lastre, 1RM estimado y, en cardio, km y duración. */
  function personalRecords(workouts) {
    const byKey = {};
    (Array.isArray(workouts) ? workouts : []).filter(isActive).forEach(w => {
      (w.exercises || []).forEach(ex => {
        const key = normalizeName(ex.name);
        if (!key) return;
        const rec = byKey[key] || (byKey[key] = {
          name: ex.name, measure: ex.measure || 'reps', sessions: 0,
          maxReps: 0, maxRepsDate: null, maxSeconds: 0, maxSecondsDate: null,
          maxWeight: 0, maxWeightDate: null, best1RM: 0, best1RMDate: null,
          maxDistanceKm: 0, maxDistanceDate: null
        });
        let counted = false;
        (ex.sets || []).forEach(st => {
          const reps = toNum(st.reps), secs = toNum(st.seconds), kg = toNum(st.weight_kg), km = toNum(st.distance_km);
          if (setHasData(st, ex.measure)) counted = true;
          if (reps > rec.maxReps) { rec.maxReps = reps; rec.maxRepsDate = w.date; }
          if (secs > rec.maxSeconds) { rec.maxSeconds = secs; rec.maxSecondsDate = w.date; }
          if (kg > rec.maxWeight) { rec.maxWeight = kg; rec.maxWeightDate = w.date; }
          if (km > rec.maxDistanceKm) { rec.maxDistanceKm = km; rec.maxDistanceDate = w.date; }
          const orm = estimate1RM(kg, reps);
          if (orm > rec.best1RM) { rec.best1RM = orm; rec.best1RMDate = w.date; }
        });
        if (counted) rec.sessions += 1;
      });
    });
    return Object.values(byKey).filter(x => x.sessions > 0).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  }

  /** Serie semanal (últimas `weeks` semanas hasta la de `today`) para la gráfica de evolución. */
  function weeklySeries(workouts, { today, weeks = 8, exerciseName = null } = {}) {
    const lastWeek = weekStart(today);
    const series = [];
    for (let i = weeks - 1; i >= 0; i--) {
      series.push({ weekStart: addDays(lastWeek, -7 * i), workouts: 0, reps: 0, seconds: 0, best1RM: 0, bestReps: 0, cardioSeconds: 0, distanceKm: 0 });
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
          if (!setHasData(st, ex.measure)) return;
          touched = true;
          const reps = toNum(st.reps), secs = toNum(st.seconds);
          if (ex.measure === 'cardio') {
            bucket.cardioSeconds += secs;
            bucket.distanceKm = Math.round((bucket.distanceKm + toNum(st.distance_km)) * 100) / 100;
          } else if (ex.measure === 'time') bucket.seconds += secs;
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
    const res = { workouts: 0, sets: 0, reps: 0, seconds: 0, minutes: 0, cardioMinutes: 0, distanceKm: 0, previousWeekWorkouts: 0, weekStreak: 0 };
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
      res.cardioMinutes += Math.round(s.cardioSeconds / 60);
      res.distanceKm = Math.round((res.distanceKm + s.distanceKm) * 100) / 100;
      res.minutes += toNum(w.duration_minutes);
    });
    let cursor = weeksWithWorkout.has(thisWeek) ? thisWeek : prevWeek;
    while (weeksWithWorkout.has(cursor)) {
      res.weekStreak += 1;
      cursor = addDays(cursor, -7);
    }
    return res;
  }

  // ── Rutinas y plan ──
  function isCardioRoutine(routine) {
    const exs = routine && Array.isArray(routine.exercises) ? routine.exercises : [];
    return exs.length > 0 && exs.every(ex => ex.measure === 'cardio');
  }

  function plannedRoutinesFor(routines, dateStr) {
    const day = weekdayIndex(dateStr);
    return (Array.isArray(routines) ? routines : []).filter(rt => isActive(rt) && Array.isArray(rt.days) && rt.days.includes(day));
  }

  function formatDays(days) {
    return (Array.isArray(days) ? [...days].sort((a, b) => a - b) : []).map(d => DAY_LABELS[d]).filter(Boolean).join(' · ');
  }

  /** Rutinas del plan sugerido que aún no existen (por id, incluidas las borradas para no resucitarlas). */
  function planSeed(existingRoutines) {
    const ids = new Set((Array.isArray(existingRoutines) ? existingRoutines : []).map(rt => rt && rt.id));
    return SUGGESTED_PLAN.filter(p => !ids.has(p.id)).map(p => JSON.parse(JSON.stringify(p)));
  }

  /** Borrador de entreno a partir de una rutina: series objetivo, descanso, "la última vez" y lastre usado. */
  function buildDraftFromRoutine(routine, workouts) {
    const exercises = (routine && Array.isArray(routine.exercises) ? routine.exercises : []).map(ex => {
      const measure = ex.measure || 'reps';
      const last = lastPerformance(workouts, ex.name);
      const lastWeight = last ? last.maxWeight : 0;
      const count = measure === 'cardio' ? 1 : Math.max(1, toNum(ex.target_sets) || 1);
      const repsTarget = toNum(ex.target_reps_max) || toNum(ex.target_reps) || toNum(ex.target_reps_min);
      const sets = Array.from({ length: count }, () => ({
        reps: measure === 'reps' ? repsTarget : 0,
        seconds: measure !== 'reps' ? toNum(ex.target_seconds) : 0,
        weight_kg: measure === 'reps' ? lastWeight : 0,
        distance_km: 0
      }));
      return {
        name: ex.name,
        measure,
        sets,
        last: last ? `${last.date}: ${last.text}` : '',
        target_reps_min: toNum(ex.target_reps_min || ex.target_reps),
        target_reps_max: toNum(ex.target_reps_max || ex.target_reps),
        target_seconds: toNum(ex.target_seconds),
        rest_seconds: ex.rest_seconds == null ? DEFAULT_REST_SECONDS : toNum(ex.rest_seconds)
      };
    });
    return { routine_id: routine ? routine.id : null, exercises };
  }

  // ── Entreno guiado ──
  /** Secuencia de pasos: cada serie es un paso "work" y le sigue su descanso, salvo tras la última serie del entreno. */
  function buildSessionSteps(draft) {
    const steps = [];
    const exs = draft && Array.isArray(draft.exercises) ? draft.exercises : [];
    exs.forEach((ex, ei) => {
      const sets = Array.isArray(ex.sets) && ex.sets.length ? ex.sets : [{}];
      sets.forEach((_, si) => {
        steps.push({ type: 'work', ex: ei, set: si });
        const isLast = ei === exs.length - 1 && si === sets.length - 1;
        const rest = ex.rest_seconds == null ? DEFAULT_REST_SECONDS : toNum(ex.rest_seconds);
        if (!isLast && rest > 0) steps.push({ type: 'rest', ex: ei, set: si, seconds: rest });
      });
    });
    return steps;
  }

  function guidedStart(now) {
    return { index: 0, startedAt: now, stepStartedAt: now, pausedAt: null, pausedMs: 0, stepPausedMs: 0, extraSeconds: 0, finished: false };
  }

  function stepElapsedMs(state, now) {
    const pausedNow = state.pausedAt ? now - state.pausedAt : 0;
    return Math.max(0, now - state.stepStartedAt - state.stepPausedMs - pausedNow);
  }

  /** Vista del paso actual: qué toca, cuánto queda (descanso / isométrico), si ya terminó y qué viene después. */
  function guidedView(draft, state, now) {
    const steps = buildSessionSteps(draft);
    const total = steps.length;
    const pausedNow = state.pausedAt ? now - state.pausedAt : 0;
    const totalElapsed = Math.max(0, Math.round((now - state.startedAt - state.pausedMs - pausedNow) / 1000));
    if (state.finished || state.index >= total) {
      return { finished: true, total, position: total, totalElapsed, steps };
    }
    const step = steps[state.index];
    const ex = draft.exercises[step.ex] || {};
    const elapsed = stepElapsedMs(state, now) / 1000;
    let duration = 0;
    if (step.type === 'rest') duration = step.seconds + state.extraSeconds;
    else if (ex.measure === 'time') duration = toNum(ex.target_seconds) || toNum((ex.sets[step.set] || {}).seconds);
    const remaining = duration ? Math.max(0, Math.ceil(duration - elapsed)) : 0;
    const nextWork = steps.slice(state.index + 1).find(s => s.type === 'work');
    const nextEx = nextWork ? draft.exercises[nextWork.ex] : null;
    return {
      finished: false,
      total,
      position: state.index + 1,
      totalElapsed,
      paused: !!state.pausedAt,
      step,
      exercise: ex,
      setNumber: step.set + 1,
      setCount: (ex.sets || []).length || 1,
      target: formatTarget(ex),
      duration,
      elapsed: Math.floor(elapsed),
      remaining,
      timeUp: duration > 0 && elapsed >= duration,
      next: nextWork ? { name: nextEx.name, setNumber: nextWork.set + 1, setCount: (nextEx.sets || []).length || 1, target: formatTarget(nextEx) } : null,
      steps
    };
  }

  function guidedAdvance(state, draft, now) {
    const total = buildSessionSteps(draft).length;
    const index = state.index + 1;
    return { ...state, index, stepStartedAt: now, stepPausedMs: 0, extraSeconds: 0, pausedAt: state.pausedAt ? now : null, finished: index >= total };
  }

  function guidedBack(state, now) {
    return { ...state, index: Math.max(0, state.index - 1), stepStartedAt: now, stepPausedMs: 0, extraSeconds: 0, finished: false };
  }

  function guidedAddRest(state, seconds = 15) {
    return { ...state, extraSeconds: state.extraSeconds + seconds };
  }

  function guidedPause(state, now) {
    return state.pausedAt ? state : { ...state, pausedAt: now };
  }

  function guidedResume(state, now) {
    if (!state.pausedAt) return state;
    const d = now - state.pausedAt;
    return { ...state, pausedAt: null, pausedMs: state.pausedMs + d, stepPausedMs: state.stepPausedMs + d };
  }

  function isExerciseActivity(activity) {
    if (!activity) return false;
    const words = [activity.title || '', ...(Array.isArray(activity.tags) ? activity.tags : [])].map(normalizeName).join(' ');
    return EXERCISE_KEYWORDS.some(k => words.includes(k));
  }

  function isCardioActivity(activity) {
    if (!activity) return false;
    const words = [activity.title || '', ...(Array.isArray(activity.tags) ? activity.tags : [])].map(normalizeName).join(' ');
    return CARDIO_KEYWORDS.some(k => words.includes(k));
  }

  /** Rutina que corresponde a una actividad de la agenda en una fecha: la planificada de su tipo, si hay. */
  function routineForActivity(routines, activity, dateStr) {
    const planned = plannedRoutinesFor(routines, dateStr);
    const wantCardio = isCardioActivity(activity);
    const title = normalizeName(activity && activity.title);
    const sameType = planned.filter(rt => isCardioRoutine(rt) === wantCardio);
    if (wantCardio) {
      const byName = (Array.isArray(routines) ? routines : []).filter(isActive)
        .find(rt => isCardioRoutine(rt) && title && normalizeName(rt.name).split(' ').some(w => w.length > 3 && title.includes(w)));
      if (byName) return byName;
    }
    return sameType[0] || null;
  }

  function validateRoutine(routine) {
    const errors = [];
    if (!routine || !String(routine.name || '').trim()) errors.push('Ponle un nombre a la rutina.');
    if (routine && String(routine.name || '').length > 80) errors.push('El nombre no puede pasar de 80 caracteres.');
    const exs = routine && Array.isArray(routine.exercises) ? routine.exercises : [];
    if (!exs.length) errors.push('Agrega al menos un ejercicio.');
    if (exs.some(ex => !String(ex.name || '').trim())) errors.push('Todos los ejercicios necesitan nombre.');
    if (exs.length > 40) errors.push('Máximo 40 ejercicios por rutina.');
    if (exs.some(ex => toNum(ex.rest_seconds) > 600)) errors.push('El descanso máximo es de 600 s.');
    return { valid: errors.length === 0, errors };
  }

  function validateWorkout(workout) {
    const errors = [];
    const exs = workout && Array.isArray(workout.exercises) ? workout.exercises : [];
    if (!workout || !/^\d{4}-\d{2}-\d{2}$/.test(String(workout.date || ''))) errors.push('La fecha del entreno no es válida.');
    if (exs.some(ex => !String(ex.name || '').trim())) errors.push('Todos los ejercicios necesitan nombre.');
    if (!exs.some(ex => (ex.sets || []).some(st => setHasData(st, ex.measure)))) {
      errors.push('Registra al menos una serie con repeticiones, segundos o distancia.');
    }
    return { valid: errors.length === 0, errors };
  }

  return {
    EXERCISE_KEYWORDS,
    SUGGESTED_EXERCISES,
    SUGGESTED_PLAN,
    DAY_LABELS,
    DAY_NAMES,
    DEFAULT_REST_SECONDS,
    normalizeName,
    weekStart,
    weekdayIndex,
    addDays,
    formatDuration,
    estimate1RM,
    summarizeWorkout,
    formatSets,
    formatTarget,
    exerciseHistory,
    lastPerformance,
    personalRecords,
    weeklySeries,
    weeklySummary,
    isCardioRoutine,
    plannedRoutinesFor,
    formatDays,
    planSeed,
    buildDraftFromRoutine,
    buildSessionSteps,
    guidedStart,
    guidedView,
    guidedAdvance,
    guidedBack,
    guidedAddRest,
    guidedPause,
    guidedResume,
    isExerciseActivity,
    isCardioActivity,
    routineForActivity,
    validateRoutine,
    validateWorkout
  };
});
