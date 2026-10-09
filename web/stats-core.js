(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StatsCore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function defaultNow() {
    return Date.now();
  }

  function getSystemTimezone() {
    try {
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      }
    } catch (e) {}
    return 'UTC';
  }

  /**
   * Obtiene la fecha 'YYYY-MM-DD' de un timestamp UTC en una zona horaria IANA.
   */
  function getLocalDateStr(timestampMs, ianaTimezone) {
    const tz = ianaTimezone || 'UTC';
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      return formatter.format(new Date(timestampMs));
    } catch (e) {
      // Fallback a UTC
      return new Date(timestampMs).toISOString().slice(0, 10);
    }
  }

  /**
   * Obtiene la hora local (0-23) y el día de la semana (0=Lunes, 6=Domingo) de un timestamp.
   */
  function getLocalHourAndDayOfWeek(timestampMs, ianaTimezone) {
    const tz = ianaTimezone || 'UTC';
    try {
      const date = new Date(timestampMs);
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
        weekday: 'short'
      });
      const parts = formatter.formatToParts(date);
      let hour = 0;
      let weekdayStr = '';
      for (const p of parts) {
        if (p.type === 'hour') hour = parseInt(p.value, 10) % 24;
        if (p.type === 'weekday') weekdayStr = p.value;
      }
      // Mapear días a 0=Lunes ... 6=Domingo
      const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
      const dayOfWeek = dayMap[weekdayStr] !== undefined ? dayMap[weekdayStr] : 0;
      return { hour, dayOfWeek };
    } catch (e) {
      const d = new Date(timestampMs);
      const utcDay = (d.getUTCDay() + 6) % 7;
      return { hour: d.getUTCHours(), dayOfWeek: utcDay };
    }
  }

  /**
   * Divide un intervalo [inicio_ms, fin_ms] en segmentos por día local (YYYY-MM-DD).
   * Robusto ante cruces de medianoche y transiciones DST (23h, 24h, 25h).
   */
  function splitIntervalByLocalDate(startMs, endMs, ianaTimezone) {
    if (endMs <= startMs) return [];
    const segments = [];
    let currentStart = startMs;

    while (currentStart < endMs) {
      const startDateStr = getLocalDateStr(currentStart, ianaTimezone);
      
      // Encontrar el final del día local o endMs
      // Búsqueda binaria/aproximación del cruce de medianoche dentro del tramo
      let stepMs = 3600000; // 1 hora
      let candidate = currentStart;
      
      while (candidate + stepMs < endMs && getLocalDateStr(candidate + stepMs, ianaTimezone) === startDateStr) {
        candidate += stepMs;
      }

      // Refinamiento a nivel de segundo/minuto
      let low = candidate;
      let high = Math.min(candidate + stepMs, endMs);
      while (high - low > 1000) {
        const mid = Math.floor((low + high) / 2);
        if (getLocalDateStr(mid, ianaTimezone) === startDateStr) {
          low = mid;
        } else {
          high = mid;
        }
      }

      const segmentEnd = high >= endMs ? endMs : high;
      const durationSeconds = Math.max(0, Math.floor((segmentEnd - currentStart) / 1000));
      
      if (durationSeconds > 0) {
        segments.push({
          date: startDateStr,
          startMs: currentStart,
          endMs: segmentEnd,
          seconds: durationSeconds
        });
      }

      currentStart = segmentEnd;
    }

    return segments;
  }

  /**
   * Divide una sesión de enfoque completa en fragmentos por fecha local.
   */
  function splitSessionByLocalDate(session, ianaTimezone) {
    if (!session || session.deleted_at) return [];
    const tz = ianaTimezone || session.iana_timezone || 'UTC';
    const intervals = session.focus_intervals;

    const dateSecondsMap = {};

    if (Array.isArray(intervals) && intervals.length > 0) {
      for (const [startIso, endIso] of intervals) {
        const sMs = new Date(startIso).getTime();
        const eMs = new Date(endIso).getTime();
        if (!isNaN(sMs) && !isNaN(eMs) && eMs > sMs) {
          const segs = splitIntervalByLocalDate(sMs, eMs, tz);
          for (const seg of segs) {
            dateSecondsMap[seg.date] = (dateSecondsMap[seg.date] || 0) + seg.seconds;
          }
        }
      }
    } else if (session.started_at && (session.effective_seconds || 0) > 0) {
      // Fallback si no hay intervals: estimar a partir de started_at y effective_seconds
      const sMs = new Date(session.started_at).getTime();
      const eMs = sMs + (session.effective_seconds * 1000);
      if (!isNaN(sMs)) {
        const segs = splitIntervalByLocalDate(sMs, eMs, tz);
        for (const seg of segs) {
          dateSecondsMap[seg.date] = (dateSecondsMap[seg.date] || 0) + seg.seconds;
        }
      }
    }

    return Object.entries(dateSecondsMap).map(([date, seconds]) => ({
      date,
      effective_seconds: seconds
    }));
  }

  /**
   * Agrega el total de segundos efectivos de una lista de sesiones por fecha local.
   */
  function aggregateDailyTotals(sessions, ianaTimezone) {
    const tz = ianaTimezone || getSystemTimezone();
    const dailyMap = {};

    if (!Array.isArray(sessions)) return dailyMap;

    for (const session of sessions) {
      if (!session || session.deleted_at) continue;
      const splits = splitSessionByLocalDate(session, tz);
      for (const split of splits) {
        if (!dailyMap[split.date]) {
          dailyMap[split.date] = {
            date: split.date,
            effective_seconds: 0,
            sessions_count: 0
          };
        }
        dailyMap[split.date].effective_seconds += split.effective_seconds;
        dailyMap[split.date].sessions_count += 1;
      }
    }

    return dailyMap;
  }

  /**
   * Calcula el rango [inicio, fin] del ciclo de estudio (día 15 a día 14 del siguiente mes).
   */
  function getStudyCycleRange(referenceDateStr) {
    const parts = referenceDateStr.split('-').map(Number);
    const year = parts[0];
    const month = parts[1]; // 1-12
    const day = parts[2];

    let startYear, startMonth, endYear, endMonth;

    if (day >= 15) {
      startYear = year;
      startMonth = month;
      if (month === 12) {
        endYear = year + 1;
        endMonth = 1;
      } else {
        endYear = year;
        endMonth = month + 1;
      }
    } else {
      if (month === 1) {
        startYear = year - 1;
        startMonth = 12;
      } else {
        startYear = year;
        startMonth = month - 1;
      }
      endYear = year;
      endMonth = month;
    }

    const startStr = `${startYear}-${String(startMonth).padStart(2, '0')}-15`;
    const endStr = `${endYear}-${String(endMonth).padStart(2, '0')}-14`;
    return { startDate: startStr, endDate: endStr };
  }

  /**
   * Genera lista de fechas ISO 'YYYY-MM-DD' en un rango inclusivo [startDateStr, endDateStr].
   */
  function getDatesInRange(startDateStr, endDateStr) {
    const dates = [];
    const current = new Date(startDateStr + 'T12:00:00Z');
    const end = new Date(endDateStr + 'T12:00:00Z');

    while (current <= end) {
      dates.push(current.toISOString().slice(0, 10));
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }

  /**
   * Calcula totales de hoy, semana en curso (L-D) y ciclo 15->14.
   */
  function calculatePeriodTotals(dailyMap, todayStr) {
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const todaySeconds = (dailyMap[today] && dailyMap[today].effective_seconds) || 0;

    // 1. Semana en curso (Lunes a Domingo)
    const d = new Date(today + 'T12:00:00Z');
    const dayOfWeek = (d.getUTCDay() + 6) % 7; // 0=Mon ... 6=Sun
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - dayOfWeek);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);

    const weekDates = getDatesInRange(monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10));
    let weekSeconds = 0;
    for (const dt of weekDates) {
      if (dailyMap[dt]) weekSeconds += dailyMap[dt].effective_seconds;
    }

    // 2. Ciclo de estudio (15 al 14)
    const cycleRange = getStudyCycleRange(today);
    const cycleDates = getDatesInRange(cycleRange.startDate, cycleRange.endDate);
    let cycleSeconds = 0;
    for (const dt of cycleDates) {
      if (dailyMap[dt]) cycleSeconds += dailyMap[dt].effective_seconds;
    }

    return {
      today_seconds: todaySeconds,
      today_minutes: Math.round(todaySeconds / 60),
      today_hours: +(todaySeconds / 3600).toFixed(2),
      week_seconds: weekSeconds,
      week_minutes: Math.round(weekSeconds / 60),
      week_hours: +(weekSeconds / 3600).toFixed(2),
      cycle_seconds: cycleSeconds,
      cycle_minutes: Math.round(cycleSeconds / 60),
      cycle_hours: +(cycleSeconds / 3600).toFixed(2),
      cycle_start: cycleRange.startDate,
      cycle_end: cycleRange.endDate
    };
  }

  /**
   * Calcula medias diarias en un rango de fechas en 2 variantes:
   * (a) Todos los días del periodo
   * (b) Solamente días con estudio (> 0 seg)
   */
  function calculateDailyAverages(dailyMap, startDateStr, endDateStr) {
    const dates = getDatesInRange(startDateStr, endDateStr);
    const totalDays = dates.length;
    if (totalDays === 0) {
      return { total_seconds: 0, total_days: 0, active_days: 0, avg_all_days_seconds: 0, avg_active_days_seconds: 0 };
    }

    let totalSeconds = 0;
    let activeDays = 0;

    for (const dt of dates) {
      const sec = (dailyMap[dt] && dailyMap[dt].effective_seconds) || 0;
      totalSeconds += sec;
      if (sec > 0) activeDays += 1;
    }

    const avgAll = Math.round(totalSeconds / totalDays);
    const avgActive = activeDays > 0 ? Math.round(totalSeconds / activeDays) : 0;

    return {
      total_seconds: totalSeconds,
      total_days: totalDays,
      active_days: activeDays,
      avg_all_days_seconds: avgAll,
      avg_all_days_minutes: Math.round(avgAll / 60),
      avg_active_days_seconds: avgActive,
      avg_active_days_minutes: Math.round(avgActive / 60)
    };
  }

  /**
   * Comparativa: Hoy vs promedio de los 7 días inmediatamente anteriores (t-7 a t-1).
   */
  function calculateTodayVs7DayAvg(dailyMap, todayStr) {
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const todaySeconds = (dailyMap[today] && dailyMap[today].effective_seconds) || 0;

    const d = new Date(today + 'T12:00:00Z');
    const start7 = new Date(d);
    start7.setUTCDate(d.getUTCDate() - 7);
    const end7 = new Date(d);
    end7.setUTCDate(d.getUTCDate() - 1);

    const prev7Dates = getDatesInRange(start7.toISOString().slice(0, 10), end7.toISOString().slice(0, 10));
    let prev7TotalSec = 0;
    for (const dt of prev7Dates) {
      if (dailyMap[dt]) prev7TotalSec += dailyMap[dt].effective_seconds;
    }
    const avg7dSec = Math.round(prev7TotalSec / 7);

    const deltaSec = todaySeconds - avg7dSec;
    let deltaPercent = 0;
    if (avg7dSec > 0) {
      deltaPercent = Math.round((deltaSec / avg7dSec) * 100);
    } else if (todaySeconds > 0) {
      deltaPercent = 100;
    }

    return {
      today_seconds: todaySeconds,
      avg_7d_preceding_seconds: avg7dSec,
      delta_seconds: deltaSec,
      delta_percent: deltaPercent
    };
  }

  /**
   * Calcula racha actual y mejor racha histórica dado un umbral mínimo de minutos diario.
   * Regla de racha activa: Si hoy no se ha cumplido aún pero ayer sí, la racha sigue viva (pendiente de hoy).
   */
  function calculateStreak(dailyMap, todayStr, minDailyMinutes = 15) {
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const minDailySeconds = minDailyMinutes * 60;

    const dates = Object.keys(dailyMap).sort();
    if (dates.length === 0) {
      return { current_streak: 0, best_streak: 0, today_qualifies: false, status: 'none' };
    }

    // Calcular mejor racha histórica en todo el historial
    let bestStreak = 0;
    let tempStreak = 0;
    let prevDate = null;

    // Crear mapa de fechas calificadas ordenadas
    const minDateStr = dates[0];
    const allHistoryDates = getDatesInRange(minDateStr, today);

    for (const dt of allHistoryDates) {
      const sec = (dailyMap[dt] && dailyMap[dt].effective_seconds) || 0;
      if (sec >= minDailySeconds) {
        tempStreak += 1;
        if (tempStreak > bestStreak) bestStreak = tempStreak;
      } else {
        tempStreak = 0;
      }
    }

    // Calcular racha actual hacia atrás desde hoy/ayer
    const todaySec = (dailyMap[today] && dailyMap[today].effective_seconds) || 0;
    const todayQualifies = todaySec >= minDailySeconds;

    let currentStreak = 0;
    const refDate = new Date(today + 'T12:00:00Z');

    if (todayQualifies) {
      currentStreak = 1;
      let checkDay = new Date(refDate);
      checkDay.setUTCDate(checkDay.getUTCDate() - 1);
      while (true) {
        const dtStr = checkDay.toISOString().slice(0, 10);
        const sec = (dailyMap[dtStr] && dailyMap[dtStr].effective_seconds) || 0;
        if (sec >= minDailySeconds) {
          currentStreak += 1;
          checkDay.setUTCDate(checkDay.getUTCDate() - 1);
        } else {
          break;
        }
      }
    } else {
      // Verificar si ayer calificó (racha viva en espera de hoy)
      let checkDay = new Date(refDate);
      checkDay.setUTCDate(checkDay.getUTCDate() - 1);
      const yesterdayStr = checkDay.toISOString().slice(0, 10);
      const yestSec = (dailyMap[yesterdayStr] && dailyMap[yesterdayStr].effective_seconds) || 0;
      if (yestSec >= minDailySeconds) {
        while (true) {
          const dtStr = checkDay.toISOString().slice(0, 10);
          const sec = (dailyMap[dtStr] && dailyMap[dtStr].effective_seconds) || 0;
          if (sec >= minDailySeconds) {
            currentStreak += 1;
            checkDay.setUTCDate(checkDay.getUTCDate() - 1);
          } else {
            break;
          }
        }
      } else {
        currentStreak = 0;
      }
    }

    if (currentStreak > bestStreak) bestStreak = currentStreak;

    return {
      current_streak: currentStreak,
      best_streak: bestStreak,
      today_qualifies: todayQualifies,
      threshold_minutes: minDailyMinutes
    };
  }

  /**
   * Matriz Heatmap: 7 días de la semana (0=Lun ... 6=Dom) x 24 horas (0..23).
   */
  function calculateHeatmap(sessions, ianaTimezone) {
    const tz = ianaTimezone || getSystemTimezone();
    // Matriz 7x24 inicializada en 0
    const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));

    if (!Array.isArray(sessions)) return matrix;

    for (const session of sessions) {
      if (!session || session.deleted_at) continue;
      const intervals = session.focus_intervals;
      if (Array.isArray(intervals) && intervals.length > 0) {
        for (const [startIso, endIso] of intervals) {
          const sMs = new Date(startIso).getTime();
          const eMs = new Date(endIso).getTime();
          if (isNaN(sMs) || isNaN(eMs) || eMs <= sMs) continue;

          // Repartir en bloques de 1 hora
          let cur = sMs;
          while (cur < eMs) {
            const nextHourMs = cur + 3600000;
            const chunkEnd = Math.min(nextHourMs, eMs);
            const durationSec = Math.floor((chunkEnd - cur) / 1000);
            const { hour, dayOfWeek } = getLocalHourAndDayOfWeek(cur, tz);
            if (dayOfWeek >= 0 && dayOfWeek < 7 && hour >= 0 && hour < 24) {
              matrix[dayOfWeek][hour] += durationSec;
            }
            cur = chunkEnd;
          }
        }
      } else if (session.started_at && (session.effective_seconds || 0) > 0) {
        const sMs = new Date(session.started_at).getTime();
        if (!isNaN(sMs)) {
          const { hour, dayOfWeek } = getLocalHourAndDayOfWeek(sMs, tz);
          if (dayOfWeek >= 0 && dayOfWeek < 7 && hour >= 0 && hour < 24) {
            matrix[dayOfWeek][hour] += session.effective_seconds;
          }
        }
      }
    }

    return matrix;
  }

  /**
   * Calcula la mejor franja horaria (1 hora y bloque de 2 horas) con mayor tiempo acumulado.
   */
  function calculateBestTimeSlot(heatmapMatrix) {
    const hourlyTotals = Array(24).fill(0);
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        hourlyTotals[h] += heatmapMatrix[d][h] || 0;
      }
    }

    // Mejor 1h
    let best1h = 0;
    let best1hSec = -1;
    for (let h = 0; h < 24; h++) {
      if (hourlyTotals[h] > best1hSec) {
        best1hSec = hourlyTotals[h];
        best1h = h;
      }
    }

    // Mejor bloque 2h
    let best2hStart = 0;
    let best2hSec = -1;
    for (let h = 0; h < 23; h++) {
      const blockSec = hourlyTotals[h] + hourlyTotals[h + 1];
      if (blockSec > best2hSec) {
        best2hSec = blockSec;
        best2hStart = h;
      }
    }

    return {
      best_1h_slot: `${String(best1h).padStart(2, '0')}:00 - ${String((best1h + 1) % 24).padStart(2, '0')}:00`,
      best_1h_seconds: best1hSec,
      best_2h_slot: `${String(best2hStart).padStart(2, '0')}:00 - ${String(best2hStart + 2).padStart(2, '0')}:00`,
      best_2h_seconds: best2hSec,
      hourly_totals: hourlyTotals
    };
  }

  /**
   * Calcula la distribución de tiempo por materia y porcentaje relativo.
   * Reparte equitativamente entre subtemas si la sesión asocia varios.
   * Tolerante a huérfanos (sesión sin materia asignada o materia borrada).
   */
  function calculateSubjectDistribution(sessions, subjects, topics) {
    const subjectMap = {};
    const subjectNames = {};
    const subjectColors = {};

    if (Array.isArray(subjects)) {
      for (const s of subjects) {
        if (!s || s.deleted_at) continue;
        subjectNames[s.id] = s.name;
        subjectColors[s.id] = s.color || '#5B6FA0';
      }
    }

    let totalTimeSec = 0;

    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        if (!session || session.deleted_at) continue;
        const sec = session.effective_seconds || 0;
        if (sec <= 0) continue;

        totalTimeSec += sec;
        const subId = session.subject_id || 'unassigned';

        if (!subjectMap[subId]) {
          subjectMap[subId] = {
            subject_id: subId,
            name: subId === 'unassigned' ? 'Sin Materia' : (subjectNames[subId] || 'Materia Desconocida'),
            color: subId === 'unassigned' ? '#8A99AD' : (subjectColors[subId] || '#5B6FA0'),
            effective_seconds: 0,
            sessions_count: 0
          };
        }
        subjectMap[subId].effective_seconds += sec;
        subjectMap[subId].sessions_count += 1;
      }
    }

    const items = Object.values(subjectMap).map(item => {
      const pct = totalTimeSec > 0 ? Math.round((item.effective_seconds / totalTimeSec) * 100) : 0;
      return {
        ...item,
        minutes: Math.round(item.effective_seconds / 60),
        hours: +(item.effective_seconds / 3600).toFixed(2),
        percentage: pct
      };
    });

    items.sort((a, b) => b.effective_seconds - a.effective_seconds);

    return {
      total_seconds: totalTimeSec,
      total_minutes: Math.round(totalTimeSec / 60),
      total_hours: +(totalTimeSec / 3600).toFixed(2),
      subjects: items
    };
  }

  /**
   * Desglose de estado de sesiones: completadas vs abandonadas.
   */
  function calculateSessionStatusBreakdown(sessions) {
    let completed = 0;
    let abandoned = 0;
    let total = 0;

    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        if (!s || s.deleted_at) continue;
        total += 1;
        if (s.status === 'abandoned') {
          abandoned += 1;
        } else {
          completed += 1;
        }
      }
    }

    const completedPct = total > 0 ? Math.round((completed / total) * 100) : 100;
    const abandonedPct = total > 0 ? Math.round((abandoned / total) * 100) : 0;

    return {
      total_sessions: total,
      completed_count: completed,
      completed_percent: completedPct,
      abandoned_count: abandoned,
      abandoned_percent: abandonedPct
    };
  }

  /**
   * Progreso de meta diaria.
   */
  function calculateDailyGoalProgress(todaySeconds, goalMinutes = 60) {
    const goalSeconds = (goalMinutes || 60) * 60;
    const currentMinutes = Math.round(todaySeconds / 60);
    const pct = goalSeconds > 0 ? Math.min(100, Math.round((todaySeconds / goalSeconds) * 100)) : 100;

    return {
      current_seconds: todaySeconds,
      current_minutes: currentMinutes,
      goal_minutes: goalMinutes,
      progress_percent: pct,
      is_completed: todaySeconds >= goalSeconds
    };
  }

  /**
   * Genera el informe completo de estadísticas estructurado.
   */
  function generateFullStatsReport(sessions, subjects, topics, options = {}) {
    const tz = options.ianaTimezone || getSystemTimezone();
    const today = options.todayStr || getLocalDateStr(options.nowMs || defaultNow(), tz);
    const minStreakMinutes = options.minStreakMinutes !== undefined ? options.minStreakMinutes : 15;
    const dailyGoalMinutes = options.dailyGoalMinutes !== undefined ? options.dailyGoalMinutes : 60;

    // 1. Agregación diaria
    const dailyMap = aggregateDailyTotals(sessions, tz);

    // 2. Totales por periodo
    const periodTotals = calculatePeriodTotals(dailyMap, today);

    // 3. Medias 7d, 30d, Global
    const nowDt = new Date(today + 'T12:00:00Z');
    
    // 7d
    const d7Start = new Date(nowDt);
    d7Start.setUTCDate(nowDt.getUTCDate() - 6);
    const avg7d = calculateDailyAverages(dailyMap, d7Start.toISOString().slice(0, 10), today);

    // 30d
    const d30Start = new Date(nowDt);
    d30Start.setUTCDate(nowDt.getUTCDate() - 29);
    const avg30d = calculateDailyAverages(dailyMap, d30Start.toISOString().slice(0, 10), today);

    // Global
    const allDates = Object.keys(dailyMap).sort();
    const globalStart = allDates.length > 0 ? allDates[0] : today;
    const avgGlobal = calculateDailyAverages(dailyMap, globalStart, today);

    // 4. Hoy vs 7d anteriores
    const comparison7d = calculateTodayVs7DayAvg(dailyMap, today);

    // 5. Racha
    const streak = calculateStreak(dailyMap, today, minStreakMinutes);

    // 6. Heatmap y mejor horario
    const heatmap = calculateHeatmap(sessions, tz);
    const bestSlots = calculateBestTimeSlot(heatmap);

    // 7. Distribución por materias
    const subjectDist = calculateSubjectDistribution(sessions, subjects, topics);

    // 8. Completadas vs abandonadas
    const statusBreakdown = calculateSessionStatusBreakdown(sessions);

    // 9. Meta diaria
    const goalProgress = calculateDailyGoalProgress(periodTotals.today_seconds, dailyGoalMinutes);

    return {
      timezone: tz,
      today_str: today,
      periods: periodTotals,
      averages: {
        last_7_days: avg7d,
        last_30_days: avg30d,
        global: avgGlobal
      },
      comparison: comparison7d,
      streak: streak,
      heatmap: heatmap,
      best_time_slots: bestSlots,
      subjects_distribution: subjectDist,
      session_status: statusBreakdown,
      daily_goal: goalProgress
    };
  }

  return {
    getLocalDateStr: getLocalDateStr,
    getLocalHourAndDayOfWeek: getLocalHourAndDayOfWeek,
    splitIntervalByLocalDate: splitIntervalByLocalDate,
    splitSessionByLocalDate: splitSessionByLocalDate,
    aggregateDailyTotals: aggregateDailyTotals,
    getStudyCycleRange: getStudyCycleRange,
    getDatesInRange: getDatesInRange,
    calculatePeriodTotals: calculatePeriodTotals,
    calculateDailyAverages: calculateDailyAverages,
    calculateTodayVs7DayAvg: calculateTodayVs7DayAvg,
    calculateStreak: calculateStreak,
    calculateHeatmap: calculateHeatmap,
    calculateBestTimeSlot: calculateBestTimeSlot,
    calculateSubjectDistribution: calculateSubjectDistribution,
    calculateSessionStatusBreakdown: calculateSessionStatusBreakdown,
    calculateDailyGoalProgress: calculateDailyGoalProgress,
    generateFullStatsReport: generateFullStatsReport
  };
}));
