const test = require('node:test');
const assert = require('node:assert/strict');
const StatsCore = require('./stats-core.js');

test('StatsCore - Suite Completa de Métricas y Estadísticas Puras (Fase D1)', async (t) => {

  await t.test('1. splitIntervalByLocalDate y splitSessionByLocalDate dividen exactamente por medianoche y respetan transiciones DST', () => {
    // 1.1 Sesión cruzando medianoche estándar (23:30 a 00:30 UTC = 1 hora total)
    const sessionMidnight = {
      id: 'foc-midnight-1',
      started_at: '2026-10-10T23:30:00.000Z',
      ended_at: '2026-10-11T00:30:00.000Z',
      effective_seconds: 3600,
      focus_intervals: [
        ['2026-10-10T23:30:00.000Z', '2026-10-11T00:30:00.000Z']
      ],
      iana_timezone: 'UTC'
    };

    const splitsUtc = StatsCore.splitSessionByLocalDate(sessionMidnight, 'UTC');
    assert.equal(splitsUtc.length, 2);
    assert.equal(splitsUtc[0].date, '2026-10-10');
    assert.equal(splitsUtc[0].effective_seconds, 1800); // 30 min
    assert.equal(splitsUtc[1].date, '2026-10-11');
    assert.equal(splitsUtc[1].effective_seconds, 1800); // 30 min

    // 1.2 Transición DST Estados Unidos: Fall Back (2026-11-01, día de 25 horas) en America/New_York
    // En NY, 2026-11-01 01:30 EDT -> 01:30 EST (UTC 05:30Z a 06:30Z)
    const sessionDstFall = {
      id: 'foc-dst-fall',
      started_at: '2026-11-01T04:00:00.000Z', // 00:00 EDT (2026-11-01)
      ended_at: '2026-11-01T07:00:00.000Z',   // 02:00 EST (2026-11-01)
      effective_seconds: 10800,
      focus_intervals: [
        ['2026-11-01T04:00:00.000Z', '2026-11-01T07:00:00.000Z']
      ]
    };
    const splitsDstFall = StatsCore.splitSessionByLocalDate(sessionDstFall, 'America/New_York');
    assert.equal(splitsDstFall.length, 1);
    assert.equal(splitsDstFall[0].date, '2026-11-01');
    assert.equal(splitsDstFall[0].effective_seconds, 10800);

    // 1.3 Transición DST Estados Unidos: Spring Forward (2026-03-08, día de 23 horas) en America/New_York
    const sessionDstSpring = {
      id: 'foc-dst-spring',
      started_at: '2026-03-08T04:30:00.000Z', // 23:30 EST del 2026-03-07 en NY
      ended_at: '2026-03-08T07:30:00.000Z',   // 03:30 EDT del 2026-03-08 en NY (salto de 02:00 a 03:00)
      effective_seconds: 10800,
      focus_intervals: [
        ['2026-03-08T04:30:00.000Z', '2026-03-08T07:30:00.000Z']
      ]
    };
    const splitsDstSpring = StatsCore.splitSessionByLocalDate(sessionDstSpring, 'America/New_York');
    assert.equal(splitsDstSpring.length, 2);
    assert.equal(splitsDstSpring[0].date, '2026-03-07');
    assert.equal(splitsDstSpring[0].effective_seconds, 1800); // 23:30 a medianoche (30m)
    assert.equal(splitsDstSpring[1].date, '2026-03-08');
    assert.equal(splitsDstSpring[1].effective_seconds, 9000); // medianoche a 03:30 EDT (2.5h reales)
  });

  await t.test('2. getStudyCycleRange calcula exactamente el ciclo 15->14 para cualquier fecha', () => {
    // 2.1 Día después del 15 (2026-10-20 -> ciclo 2026-10-15 a 2026-11-14)
    const c1 = StatsCore.getStudyCycleRange('2026-10-20');
    assert.equal(c1.startDate, '2026-10-15');
    assert.equal(c1.endDate, '2026-11-14');

    // 2.2 Día antes del 15 (2026-10-10 -> ciclo 2026-09-15 a 2026-10-14)
    const c2 = StatsCore.getStudyCycleRange('2026-10-10');
    assert.equal(c2.startDate, '2026-09-15');
    assert.equal(c2.endDate, '2026-10-14');

    // 2.3 Cruce de año en enero (2026-01-05 -> ciclo 2025-12-15 a 2026-01-14)
    const c3 = StatsCore.getStudyCycleRange('2026-01-05');
    assert.equal(c3.startDate, '2025-12-15');
    assert.equal(c3.endDate, '2026-01-14');

    // 2.4 Cruce de año en diciembre (2026-12-25 -> ciclo 2026-12-15 a 2027-01-14)
    const c4 = StatsCore.getStudyCycleRange('2026-12-25');
    assert.equal(c4.startDate, '2026-12-15');
    assert.equal(c4.endDate, '2027-01-14');
  });

  await t.test('3. calculatePeriodTotals agrega correctamente hoy, semana en curso (L-D) y ciclo 15->14', () => {
    // 2026-10-14 es Miércoles
    // Semana L-D: 2026-10-12 (Lun) a 2026-10-18 (Dom)
    // Ciclo 15->14: 2026-09-15 a 2026-10-14
    const dailyMap = {
      '2026-09-20': { effective_seconds: 3600 }, // Dentro del ciclo
      '2026-10-11': { effective_seconds: 1800 }, // En ciclo, fuera de la semana
      '2026-10-12': { effective_seconds: 3600 }, // En ciclo y en semana
      '2026-10-13': { effective_seconds: 7200 }, // En ciclo y en semana
      '2026-10-14': { effective_seconds: 5400 }  // Hoy: en ciclo y en semana
    };

    const totals = StatsCore.calculatePeriodTotals(dailyMap, '2026-10-14');
    assert.equal(totals.today_seconds, 5400);
    assert.equal(totals.today_minutes, 90);
    assert.equal(totals.today_hours, 1.5);

    // Semana: 12 (3600) + 13 (7200) + 14 (5400) = 16200s (270 min = 4.5h)
    assert.equal(totals.week_seconds, 16200);
    assert.equal(totals.week_minutes, 270);
    assert.equal(totals.week_hours, 4.5);

    // Ciclo: 3600 + 1800 + 3600 + 7200 + 5400 = 21600s (360 min = 6h)
    assert.equal(totals.cycle_seconds, 21600);
    assert.equal(totals.cycle_minutes, 360);
    assert.equal(totals.cycle_hours, 6.0);
  });

  await t.test('4. calculateDailyAverages calcula ambas variantes (todos los días vs días con estudio)', () => {
    // Periodo de 4 días: D1=3600s, D2=0s, D3=7200s, D4=0s
    // Total = 10800s. Todos los días (4) = 2700s. Días activos (2) = 5400s.
    const dailyMap = {
      '2026-10-01': { effective_seconds: 3600 },
      '2026-10-03': { effective_seconds: 7200 }
    };

    const avgs = StatsCore.calculateDailyAverages(dailyMap, '2026-10-01', '2026-10-04');
    assert.equal(avgs.total_seconds, 10800);
    assert.equal(avgs.total_days, 4);
    assert.equal(avgs.active_days, 2);
    assert.equal(avgs.avg_all_days_seconds, 2700);   // 45 min
    assert.equal(avgs.avg_all_days_minutes, 45);
    assert.equal(avgs.avg_active_days_seconds, 5400); // 90 min
    assert.equal(avgs.avg_active_days_minutes, 90);
  });

  await t.test('5. calculateTodayVs7DayAvg compara hoy frente a los 7 días precedentes', () => {
    // Hoy es 2026-10-08 con 7200s (120 min)
    // Días t-7 a t-1 (01 al 07): 3600s cada uno -> total 25200s -> promedio 3600s (60 min)
    // Delta = +3600s (+100%)
    const dailyMap = {
      '2026-10-01': { effective_seconds: 3600 },
      '2026-10-02': { effective_seconds: 3600 },
      '2026-10-03': { effective_seconds: 3600 },
      '2026-10-04': { effective_seconds: 3600 },
      '2026-10-05': { effective_seconds: 3600 },
      '2026-10-06': { effective_seconds: 3600 },
      '2026-10-07': { effective_seconds: 3600 },
      '2026-10-08': { effective_seconds: 7200 }
    };

    const comp = StatsCore.calculateTodayVs7DayAvg(dailyMap, '2026-10-08');
    assert.equal(comp.today_seconds, 7200);
    assert.equal(comp.avg_7d_preceding_seconds, 3600);
    assert.equal(comp.delta_seconds, 3600);
    assert.equal(comp.delta_percent, 100);
  });

  await t.test('6. calculateStreak calcula racha actual y mejor racha con umbral configurable y estado de hoy', () => {
    // Umbral: 15 minutos = 900s
    // Historial:
    // D1 (01): 1800s (califica)
    // D2 (02): 1800s (califica)
    // D3 (03): 1800s (califica) -> Racha de 3 días
    // D4 (04): 0s (no califica)
    // D5 (05): 1800s (califica)
    // D6 (06): 1800s (califica)
    // D7 (07 - ayer): 1800s (califica)
    // D8 (08 - hoy): 0s (aún no califica) -> Racha actual viva = 3 días (5, 6, 7)
    const dailyMap = {
      '2026-10-01': { effective_seconds: 1800 },
      '2026-10-02': { effective_seconds: 1800 },
      '2026-10-03': { effective_seconds: 1800 },
      '2026-10-05': { effective_seconds: 1800 },
      '2026-10-06': { effective_seconds: 1800 },
      '2026-10-07': { effective_seconds: 1800 }
    };

    const streakPending = StatsCore.calculateStreak(dailyMap, '2026-10-08', 15);
    assert.equal(streakPending.today_qualifies, false);
    assert.equal(streakPending.current_streak, 3);
    assert.equal(streakPending.best_streak, 3);

    // Si hoy suma 1800s, la racha sube a 4 y supera el récord
    dailyMap['2026-10-08'] = { effective_seconds: 1800 };
    const streakDone = StatsCore.calculateStreak(dailyMap, '2026-10-08', 15);
    assert.equal(streakDone.today_qualifies, true);
    assert.equal(streakDone.current_streak, 4);
    assert.equal(streakDone.best_streak, 4);
  });

  await t.test('7. calculateHeatmap y calculateBestTimeSlot determinan matrices 7x24 y franjas pico', () => {
    // Sesión de 10:00 a 12:00 UTC un Lunes (2026-10-12)
    const sessions = [
      {
        id: 'foc-heat-1',
        started_at: '2026-10-12T10:00:00.000Z',
        ended_at: '2026-10-12T12:00:00.000Z',
        effective_seconds: 7200,
        focus_intervals: [
          ['2026-10-12T10:00:00.000Z', '2026-10-12T12:00:00.000Z']
        ]
      }
    ];

    const matrix = StatsCore.calculateHeatmap(sessions, 'UTC');
    assert.equal(matrix.length, 7); // 7 días
    assert.equal(matrix[0].length, 24); // 24 horas
    assert.equal(matrix[0][10], 3600); // Lunes 10:00
    assert.equal(matrix[0][11], 3600); // Lunes 11:00

    const bestSlots = StatsCore.calculateBestTimeSlot(matrix);
    assert.equal(bestSlots.best_1h_seconds, 3600);
    assert.equal(bestSlots.best_2h_seconds, 7200);
    assert.equal(bestSlots.best_2h_slot, '10:00 - 12:00');
  });

  await t.test('8. calculateSubjectDistribution tolera huérfanos, materias borradas y tombstones con cálculo manual de control', () => {
    const subjects = [
      { id: 'sub-mat-1', name: 'Matemáticas', color: '#10B981', deleted_at: null },
      { id: 'sub-del-1', name: 'Materia Borrada', color: '#EF4444', deleted_at: '2026-10-01T00:00:00.000Z' }
    ];

    const sessions = [
      // 1. Sesión normal en Matemáticas (3600s)
      { id: 'foc-s1', subject_id: 'sub-mat-1', effective_seconds: 3600, deleted_at: null },
      // 2. Sesión huérfana (sin materia existente) (1800s)
      { id: 'foc-s2', subject_id: 'sub-inexistente', effective_seconds: 1800, deleted_at: null },
      // 3. Sesión con subject_id null (1800s)
      { id: 'foc-s3', subject_id: null, effective_seconds: 1800, deleted_at: null },
      // 4. Sesión borrada con tombstone (no debe sumarse) (7200s)
      { id: 'foc-s4', subject_id: 'sub-mat-1', effective_seconds: 7200, deleted_at: '2026-10-10T12:00:00.000Z' }
    ];

    // Total activo esperado = 3600 + 1800 + 1800 = 7200s (120 min = 2h)
    // Matemáticas = 3600s (50%)
    // Desconocida/Sin materia = 3600s (50%)
    const dist = StatsCore.calculateSubjectDistribution(sessions, subjects, []);
    assert.equal(dist.total_seconds, 7200);
    assert.equal(dist.total_minutes, 120);
    assert.equal(dist.total_hours, 2.0);
    assert.equal(dist.subjects.length, 3); // sub-mat-1, sub-inexistente, unassigned

    const mat = dist.subjects.find(s => s.subject_id === 'sub-mat-1');
    assert.ok(mat);
    assert.equal(mat.name, 'Matemáticas');
    assert.equal(mat.effective_seconds, 3600);
    assert.equal(mat.percentage, 50);
  });

  await t.test('9. calculateSessionStatusBreakdown y calculateDailyGoalProgress calculan ratios y metas', () => {
    const sessions = [
      { id: 's1', status: 'completed' },
      { id: 's2', status: 'completed' },
      { id: 's3', status: 'abandoned' },
      { id: 's4', status: 'completed', deleted_at: '2026-10-10T00:00:00.000Z' } // Ignorar tombstone
    ];

    const breakdown = StatsCore.calculateSessionStatusBreakdown(sessions);
    assert.equal(breakdown.total_sessions, 3);
    assert.equal(breakdown.completed_count, 2);
    assert.equal(breakdown.abandoned_count, 1);
    assert.equal(breakdown.completed_percent, 67);
    assert.equal(breakdown.abandoned_percent, 33);

    // Meta diaria: 60 minutos (3600s) -> Hoy tiene 2700s (45 min) = 75%
    const goal = StatsCore.calculateDailyGoalProgress(2700, 60);
    assert.equal(goal.current_minutes, 45);
    assert.equal(goal.goal_minutes, 60);
    assert.equal(goal.progress_percent, 75);
    assert.equal(goal.is_completed, false);
  });

  await t.test('10. generateFullStatsReport emite el reporte consolidado 100% estructurado y determinista', () => {
    const sessions = [
      {
        id: 'foc-rep-1',
        started_at: '2026-10-14T10:00:00.000Z',
        ended_at: '2026-10-14T11:00:00.000Z',
        effective_seconds: 3600,
        status: 'completed',
        subject_id: 'sub-mat-1',
        focus_intervals: [['2026-10-14T10:00:00.000Z', '2026-10-14T11:00:00.000Z']]
      }
    ];
    const subjects = [{ id: 'sub-mat-1', name: 'Matemáticas', color: '#10B981' }];

    const report = StatsCore.generateFullStatsReport(sessions, subjects, [], {
      todayStr: '2026-10-14',
      ianaTimezone: 'UTC',
      minStreakMinutes: 15,
      dailyGoalMinutes: 60
    });

    assert.equal(report.today_str, '2026-10-14');
    assert.equal(report.periods.today_seconds, 3600);
    assert.equal(report.daily_goal.is_completed, true);
    assert.equal(report.streak.current_streak, 1);
    assert.equal(report.session_status.completed_percent, 100);
    assert.equal(report.subjects_distribution.subjects[0].name, 'Matemáticas');
  });

});
