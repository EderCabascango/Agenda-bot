/**
 * meditation-core.js
 * Lógica pura del temporizador de meditación: duraciones, pausa/reanudación basada en
 * marcas de tiempo (sobrevive a que el teléfono congele la app), guía de respiración
 * y resumen del historial (minutos de hoy, racha de días, sesiones).
 * Compatible con Node.js (CommonJS) y navegadores web (UMD / Global).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MeditationCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const DURATIONS = [5, 10, 15, 20];
  // Respiración 4-6: inhalar 4 s y exhalar 6 s (≈6 respiraciones por minuto, ritmo relajante).
  const BREATH = { inhale: 4, exhale: 6 };
  const MAX_LOG = 400;

  function create(minutes, now = Date.now()) {
    const mins = DURATIONS.includes(Number(minutes)) ? Number(minutes) : DURATIONS[0];
    return { status: 'running', durationMs: mins * 60000, startedAt: now, pausedAt: null, pausedMs: 0 };
  }

  function elapsedMs(s, now = Date.now()) {
    if (!s) return 0;
    const until = s.status === 'paused' && s.pausedAt ? s.pausedAt : now;
    return Math.min(s.durationMs, Math.max(0, until - s.startedAt - s.pausedMs));
  }

  function remainingMs(s, now = Date.now()) {
    return s ? Math.max(0, s.durationMs - elapsedMs(s, now)) : 0;
  }

  function pause(s, now = Date.now()) {
    if (!s || s.status !== 'running') return s;
    return { ...s, status: 'paused', pausedAt: now };
  }

  function resume(s, now = Date.now()) {
    if (!s || s.status !== 'paused') return s;
    return { ...s, status: 'running', pausedMs: s.pausedMs + Math.max(0, now - s.pausedAt), pausedAt: null };
  }

  /** Marca la sesión como terminada si se agotó el tiempo. Devuelve { state, finished }. */
  function tick(s, now = Date.now()) {
    if (!s || s.status !== 'running') return { state: s, finished: false };
    if (remainingMs(s, now) > 0) return { state: s, finished: false };
    return { state: { ...s, status: 'done' }, finished: true };
  }

  /** Hora (ms) a la que terminará la sesión si sigue corriendo; null si está en pausa. */
  function endsAt(s, now = Date.now()) {
    return s && s.status === 'running' ? now + remainingMs(s, now) : null;
  }

  /** Fase de la guía de respiración para un tiempo transcurrido: { phase, progress 0..1 }. */
  function breathPhase(ms) {
    const cycle = (BREATH.inhale + BREATH.exhale) * 1000;
    const t = ((ms % cycle) + cycle) % cycle;
    if (t < BREATH.inhale * 1000) return { phase: 'inhale', progress: t / (BREATH.inhale * 1000) };
    return { phase: 'exhale', progress: (t - BREATH.inhale * 1000) / (BREATH.exhale * 1000) };
  }

  function formatClock(ms) {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  /** Añade una sesión al historial (solo minutos realmente meditados, mínimo 1). */
  function addToLog(log, dateStr, minutes) {
    const list = Array.isArray(log) ? log.slice() : [];
    const mins = Math.round(Number(minutes) || 0);
    if (mins < 1) return list;
    list.push({ date: dateStr, minutes: mins });
    return list.slice(-MAX_LOG);
  }

  function shiftDate(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return dt.toISOString().slice(0, 10);
  }

  /** Minutos de hoy, días seguidos meditando (hasta hoy o ayer) y total de sesiones. */
  function summarize(log, todayStr) {
    const list = Array.isArray(log) ? log : [];
    const days = new Set(list.map(e => e.date));
    const todayMinutes = list.filter(e => e.date === todayStr).reduce((a, e) => a + e.minutes, 0);
    let streak = 0;
    let cursor = days.has(todayStr) ? todayStr : shiftDate(todayStr, -1);
    while (days.has(cursor)) {
      streak++;
      cursor = shiftDate(cursor, -1);
    }
    return { todayMinutes, streak, sessions: list.length };
  }

  return { DURATIONS, BREATH, create, elapsedMs, remainingMs, pause, resume, tick, endsAt, breathPhase, formatClock, addToLog, summarize };
});
