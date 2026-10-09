/**
 * timer-core.js
 * Módulo de lógica pura para temporizadores de estudio, métodos de productividad
 * y generación de registros de sesión de enfoque (Fase C1).
 * Compatible con Node.js (CommonJS) y navegadores web (UMD / Global).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TimerCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================================================================
  // 1. CONFIGURACIONES DE MÉTODOS DE ENFOQUE
  // ============================================================================

  const METHODS_CONFIG = {
    pomodoro: {
      name: 'Pomodoro Clásico',
      focusDurationSec: 25 * 60,
      breakDurationSec: 5 * 60,
      longBreakDurationSec: 15 * 60,
      cyclesBeforeLongBreak: 4,
      isCountdown: true
    },
    pomodoro_50: {
      name: 'Pomodoro Extendido (50/10)',
      focusDurationSec: 50 * 60,
      breakDurationSec: 10 * 60,
      longBreakDurationSec: 20 * 60,
      cyclesBeforeLongBreak: 3,
      isCountdown: true
    },
    '52_17': {
      name: 'Regla 52/17 (DeskTime)',
      focusDurationSec: 52 * 60,
      breakDurationSec: 17 * 60,
      longBreakDurationSec: 17 * 60,
      cyclesBeforeLongBreak: 3,
      isCountdown: true
    },
    ultradian: {
      name: 'Ritmo Ultradiano (90/20)',
      focusDurationSec: 90 * 60,
      breakDurationSec: 20 * 60,
      longBreakDurationSec: 30 * 60,
      cyclesBeforeLongBreak: 2,
      isCountdown: true
    },
    flowtime: {
      name: 'Flowtime (Flujo Libre)',
      focusDurationSec: 0, // Abierto
      breakDurationSec: 0,
      longBreakDurationSec: 0,
      cyclesBeforeLongBreak: 1,
      isCountdown: false
    },
    deep_work: {
      name: 'Deep Work (Bloque Profundo)',
      focusDurationSec: 120 * 60, // 2 horas sugeridas por defecto
      breakDurationSec: 0,
      longBreakDurationSec: 0,
      cyclesBeforeLongBreak: 1,
      isCountdown: true
    },
    custom: {
      name: 'Cuenta Regresiva Personalizada',
      focusDurationSec: 30 * 60,
      breakDurationSec: 5 * 60,
      longBreakDurationSec: 15 * 60,
      cyclesBeforeLongBreak: 4,
      isCountdown: true
    },
    stopwatch: {
      name: 'Cronómetro Libre',
      focusDurationSec: 0,
      breakDurationSec: 0,
      longBreakDurationSec: 0,
      cyclesBeforeLongBreak: 1,
      isCountdown: false
    }
  };

  function defaultNow() {
    return Date.now();
  }

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'foc-' + Math.random().toString(36).substring(2, 11) + '-' + Date.now().toString(36);
  }

  // ============================================================================
  // 2. CREACIÓN Y REINICIO DE ESTADO DEL TEMPORIZADOR
  // ============================================================================

  function createTimer(options = {}, nowFn = defaultNow) {
    const methodKey = options.method || 'pomodoro';
    const baseConfig = METHODS_CONFIG[methodKey] || METHODS_CONFIG.pomodoro;

    let focusSec = baseConfig.focusDurationSec;
    if (options.customFocusMinutes && Number(options.customFocusMinutes) > 0) {
      focusSec = Math.round(Number(options.customFocusMinutes) * 60);
    }

    return {
      id: options.id || generateUUID(),
      method: methodKey,
      status: 'idle', // 'idle' | 'running' | 'paused' | 'break' | 'waiting' | 'completed' | 'abandoned'
      phase: 'focus', // 'focus' | 'break' | 'long_break'
      goal: (options.goal || '').trim(),
      subject_id: options.subject_id || null,
      activity_id: options.activity_id || null,
      topic_ids: Array.isArray(options.topic_ids) ? [...options.topic_ids] : [],
      config: {
        focusDurationSec: focusSec,
        breakDurationSec: baseConfig.breakDurationSec,
        longBreakDurationSec: baseConfig.longBreakDurationSec,
        cyclesBeforeLongBreak: baseConfig.cyclesBeforeLongBreak,
        isCountdown: baseConfig.isCountdown
      },
      cycles_completed: 0,
      current_interval_start: null, // timestamp ms
      current_break_start: null,    // timestamp ms
      focus_intervals: [],          // array de [startIso, endIso]
      effective_seconds: 0,
      break_seconds: 0,
      distractions: [],             // array de { timestamp: iso, note: string }
      last_heartbeat: null,         // timestamp ms
      started_at: null,             // ISO string del inicio inicial
      ended_at: null,               // ISO string del final
      waiting_reason: null,         // 'fixed_gap' | 'flowtime_gap'
      gap_detected_ms: 0
    };
  }

  // ============================================================================
  // 3. TRANSICIONES DE ESTADO Y CONTROL DE TIEMPO
  // ============================================================================

  function start(timer, nowFn = defaultNow) {
    if (!timer || timer.status === 'completed' || timer.status === 'abandoned') return timer;
    const now = nowFn();
    const nowIso = new Date(now).toISOString();

    if (!timer.started_at) {
      timer.started_at = nowIso;
    }

    timer.status = 'running';
    timer.phase = 'focus';
    timer.current_interval_start = now;
    timer.current_break_start = null;
    timer.last_heartbeat = now;
    timer.waiting_reason = null;
    timer.gap_detected_ms = 0;
    return timer;
  }

  function pause(timer, nowFn = defaultNow) {
    if (!timer) return timer;
    const now = nowFn();

    if (timer.status === 'running' && timer.current_interval_start) {
      const startMs = timer.current_interval_start;
      const endMs = Math.max(startMs, now);
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();

      timer.focus_intervals.push([startIso, endIso]);
      const addedSec = Math.floor((endMs - startMs) / 1000);
      timer.effective_seconds += addedSec;
      timer.current_interval_start = null;
    } else if (timer.status === 'break' && timer.current_break_start) {
      const bStartMs = timer.current_break_start;
      const bEndMs = Math.max(bStartMs, now);
      const addedBreak = Math.floor((bEndMs - bStartMs) / 1000);
      timer.break_seconds += addedBreak;
      timer.current_break_start = null;
    }

    timer.status = 'paused';
    timer.last_heartbeat = now;
    return timer;
  }

  function resume(timer, nowFn = defaultNow) {
    if (!timer || timer.status === 'completed' || timer.status === 'abandoned') return timer;
    const now = nowFn();

    if (timer.phase === 'focus') {
      timer.status = 'running';
      timer.current_interval_start = now;
    } else {
      timer.status = 'break';
      timer.current_break_start = now;
    }

    timer.last_heartbeat = now;
    timer.waiting_reason = null;
    timer.gap_detected_ms = 0;
    return timer;
  }

  function calculateFlowtimeBreak(effectiveSec) {
    const mins = effectiveSec / 60;
    if (mins < 25) return 5 * 60;
    if (mins < 50) return 8 * 60;
    if (mins < 90) return 10 * 60;
    return 15 * 60;
  }

  function startBreak(timer, forceLongBreak = false, nowFn = defaultNow) {
    if (!timer) return timer;
    const now = nowFn();

    // Si estaba corriendo un intervalo de enfoque, cerrarlo
    if (timer.status === 'running' && timer.current_interval_start) {
      const startMs = timer.current_interval_start;
      const endMs = Math.max(startMs, now);
      timer.focus_intervals.push([new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
      timer.effective_seconds += Math.floor((endMs - startMs) / 1000);
      timer.current_interval_start = null;
      timer.cycles_completed += 1;
    }

    let isLong = forceLongBreak;
    if (!isLong && timer.config.cyclesBeforeLongBreak > 0) {
      if (timer.cycles_completed > 0 && timer.cycles_completed % timer.config.cyclesBeforeLongBreak === 0) {
        isLong = true;
      }
    }

    timer.phase = isLong ? 'long_break' : 'break';
    timer.status = 'break';
    timer.current_break_start = now;
    timer.last_heartbeat = now;

    if (timer.method === 'flowtime') {
      timer.config.breakDurationSec = calculateFlowtimeBreak(timer.effective_seconds);
    }

    return timer;
  }

  function endBreak(timer, nowFn = defaultNow) {
    if (!timer) return timer;
    const now = nowFn();

    if (timer.current_break_start) {
      const bStartMs = timer.current_break_start;
      const bEndMs = Math.max(bStartMs, now);
      timer.break_seconds += Math.floor((bEndMs - bStartMs) / 1000);
      timer.current_break_start = null;
    }

    timer.phase = 'focus';
    timer.status = 'paused'; // Listo para reanudar el siguiente ciclo
    timer.last_heartbeat = now;
    return timer;
  }

  function logDistraction(timer, note = '', nowFn = defaultNow) {
    if (!timer) return timer;
    const now = nowFn();
    const item = {
      timestamp: new Date(now).toISOString(),
      note: (note || '').trim().slice(0, 200)
    };
    timer.distractions.push(item);
    return timer;
  }

  // ============================================================================
  // 4. HEARTBEAT Y POLÍTICA DE GAPS (AUSENCIAS)
  // ============================================================================

  const GAP_THRESHOLD_FIXED_MS = 2 * 60 * 1000;    // >2 min de ausencia en fases fijas
  const GAP_THRESHOLD_FLOWTIME_MS = 30 * 60 * 1000; // >30 min de ausencia en Flowtime

  function tick(timer, nowFn = defaultNow) {
    if (!timer) return timer;
    const now = nowFn();

    if (timer.status !== 'running' && timer.status !== 'break') {
      timer.last_heartbeat = now;
      return timer;
    }

    const last = timer.last_heartbeat || now;
    const diff = now - last;

    // Detección de ausencia / suspensión
    if (timer.method === 'flowtime' || timer.method === 'stopwatch') {
      if (diff > GAP_THRESHOLD_FLOWTIME_MS) {
        timer.status = 'waiting';
        timer.waiting_reason = 'flowtime_gap';
        timer.gap_detected_ms = diff;
        return timer;
      }
    } else {
      if (diff > GAP_THRESHOLD_FIXED_MS) {
        timer.status = 'waiting';
        timer.waiting_reason = 'fixed_gap';
        timer.gap_detected_ms = diff;
        return timer;
      }
    }

    timer.last_heartbeat = now;
    return timer;
  }

  function resolveGap(timer, keepElapsedTime = true, customEndIso = null, nowFn = defaultNow) {
    if (!timer || timer.status !== 'waiting') return timer;
    const now = nowFn();

    if (keepElapsedTime) {
      // Usuario continuó estudiando: actualiza heartbeat a ahora
      timer.last_heartbeat = now;
      timer.status = timer.phase === 'focus' ? 'running' : 'break';
      timer.waiting_reason = null;
      timer.gap_detected_ms = 0;
    } else {
      // Usuario se detuvo en el último heartbeat o en hora manual
      let cutoffMs = timer.last_heartbeat || (now - timer.gap_detected_ms);
      if (customEndIso) {
        const parsed = new Date(customEndIso).getTime();
        if (!isNaN(parsed) && parsed >= (timer.current_interval_start || 0) && parsed <= now) {
          cutoffMs = parsed;
        }
      }

      if (timer.phase === 'focus' && timer.current_interval_start) {
        const startMs = timer.current_interval_start;
        const endMs = Math.max(startMs, cutoffMs);
        timer.focus_intervals.push([new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
        timer.effective_seconds += Math.floor((endMs - startMs) / 1000);
        timer.current_interval_start = null;
      }

      timer.status = 'paused';
      timer.waiting_reason = null;
      timer.gap_detected_ms = 0;
      timer.last_heartbeat = now;
    }

    return timer;
  }

  // ============================================================================
  // 5. CÁLCULO DE TIEMPO TRANSCURRIDO Y RESTANTE
  // ============================================================================

  function getElapsedAndRemaining(timer, nowFn = defaultNow) {
    if (!timer) {
      return { elapsedSeconds: 0, remainingSeconds: 0, progressPercent: 0 };
    }

    const now = nowFn();
    let currentPhaseSec = 0;

    if (timer.status === 'running' && timer.current_interval_start) {
      currentPhaseSec = Math.max(0, Math.floor((now - timer.current_interval_start) / 1000));
    } else if (timer.status === 'break' && timer.current_break_start) {
      currentPhaseSec = Math.max(0, Math.floor((now - timer.current_break_start) / 1000));
    }

    let targetDurationSec = 0;
    if (timer.phase === 'focus') {
      targetDurationSec = timer.config.focusDurationSec;
    } else if (timer.phase === 'long_break') {
      targetDurationSec = timer.config.longBreakDurationSec;
    } else {
      targetDurationSec = timer.config.breakDurationSec;
    }

    let remainingSec = 0;
    let progress = 0;

    if (timer.config.isCountdown && targetDurationSec > 0) {
      remainingSec = Math.max(0, targetDurationSec - currentPhaseSec);
      progress = Math.min(100, Math.round((currentPhaseSec / targetDurationSec) * 100));
    } else {
      remainingSec = 0;
      progress = 100;
    }

    const totalEffectiveSec = timer.effective_seconds + (timer.phase === 'focus' ? currentPhaseSec : 0);
    const totalBreakSec = timer.break_seconds + (timer.phase !== 'focus' ? currentPhaseSec : 0);

    return {
      currentPhaseElapsedSeconds: currentPhaseSec,
      targetDurationSec: targetDurationSec,
      remainingSeconds: remainingSec,
      progressPercent: progress,
      totalEffectiveSeconds: totalEffectiveSec,
      totalBreakSeconds: totalBreakSec
    };
  }

  // ============================================================================
  // 6. GENERACIÓN DEL REGISTRO DE SESIÓN PARA SINCRONIZACIÓN (focus_sessions)
  // ============================================================================

  function buildSessionRecord(timer, meta = {}, nowFn = defaultNow) {
    if (!timer) return null;
    const now = nowFn();
    const nowIso = new Date(now).toISOString();

    // Finalizar intervalo en curso si existe
    let finalIntervals = [...(timer.focus_intervals || [])];
    let totalEffective = timer.effective_seconds || 0;
    let totalBreak = timer.break_seconds || 0;

    if (timer.status === 'running' && timer.current_interval_start) {
      const startMs = timer.current_interval_start;
      const endMs = Math.max(startMs, now);
      finalIntervals.push([new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
      totalEffective += Math.floor((endMs - startMs) / 1000);
    } else if (timer.status === 'break' && timer.current_break_start) {
      const bStartMs = timer.current_break_start;
      const bEndMs = Math.max(bStartMs, now);
      totalBreak += Math.floor((bEndMs - bStartMs) / 1000);
    }

    // Invariantes: Intervalos ordenados cronológicamente
    finalIntervals.sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());

    const startedAt = timer.started_at || (finalIntervals.length > 0 ? finalIntervals[0][0] : nowIso);
    const endedAt = timer.ended_at || nowIso;

    let timeZone = 'UTC';
    try {
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      }
    } catch (e) {}

    const subjectId = meta.subject_id !== undefined ? meta.subject_id : (timer.subject_id || null);
    const activityId = meta.activity_id !== undefined ? meta.activity_id : (timer.activity_id || null);
    const topicIds = meta.topic_ids !== undefined ? meta.topic_ids : (timer.topic_ids || []);
    const goal = meta.goal !== undefined ? meta.goal : (timer.goal || '');

    const record = {
      id: timer.id || generateUUID(),
      subject_id: subjectId,
      activity_id: activityId,
      topic_ids: Array.isArray(topicIds) ? topicIds : [],
      method: timer.method || 'pomodoro',
      goal: (goal || '').slice(0, 500),
      started_at: startedAt,
      ended_at: endedAt,
      focus_intervals: finalIntervals,
      effective_seconds: Math.max(0, Math.round(totalEffective)),
      break_seconds: Math.max(0, Math.round(totalBreak)),
      cycles_completed: timer.cycles_completed || (finalIntervals.length > 0 ? 1 : 0),
      distractions_count: timer.distractions ? timer.distractions.length : 0,
      status: (meta.status === 'abandoned' || timer.status === 'abandoned') ? 'abandoned' : 'completed',
      source: meta.source || 'timer',
      iana_timezone: timeZone,
      version: 1,
      op: meta.op || 'create_if_absent',
      created_at: startedAt,
      updated_at: nowIso,
      deleted_at: null
    };

    return record;
  }

  return {
    METHODS_CONFIG,
    createTimer,
    start,
    pause,
    resume,
    startBreak,
    endBreak,
    logDistraction,
    tick,
    resolveGap,
    getElapsedAndRemaining,
    calculateFlowtimeBreak,
    buildSessionRecord
  };
});
