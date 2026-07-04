/* ============================================================
   Mi Diario – Complete Application Logic
   Activity CRUD, Calendar, Statistics, Search, LocalStorage
   Excel Routine Import & Groq/n8n AI Agent Integration
   ============================================================ */

(function () {
  'use strict';

  // ── Utility Helpers ──
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const DAYS_ES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const DAYS_SHORT = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

  function formatDate(d) {
    const date = new Date(d);
    return `${DAYS_ES[date.getDay()]}, ${date.getDate()} de ${MONTHS_ES[date.getMonth()]} ${date.getFullYear()}`;
  }
  function toDateStr(d) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  }
  function todayStr() { return toDateStr(new Date()); }
  function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 18) return 'Buenas tardes';
    return 'Buenas noches';
  }

  // ── Data Layer (LocalStorage) ──
  const STORAGE_KEY = 'diary_activities';
  const SETTINGS_KEY = 'diary_settings';

  function loadActivities() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }
  function saveActivities(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch { return {}; }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  let activities = loadActivities();
  let settings = loadSettings();
  let currentFilter = 'all';
  let calMonth = new Date().getMonth();
  let calYear = new Date().getFullYear();
  let calSelectedDate = todayStr();
  let activitiesSelectedDate = todayStr();
  let editingId = null;
  let deletingId = null;

  // ── Toast ──
  function showToast(msg, icon = 'check_circle', color = 'var(--accent-teal)') {
    const toast = $('#toast');
    if (!toast) return;
    $('#toast-msg').textContent = msg;
    const ic = $('#toast-icon');
    ic.textContent = icon;
    ic.style.color = color;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2800);
  }

  // ── Navigation ──
  function switchView(name) {
    $$('.view').forEach(v => v.classList.remove('active'));
    const target = $(`#view-${name}`);
    if (target) target.classList.add('active');
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === name));
    $$('.bnav-item').forEach(n => n.classList.toggle('active', n.dataset.view === name));
    if (name === 'dashboard') renderDashboard();
    if (name === 'activities') renderActivityList();
    if (name === 'calendar') renderCalendar();
    if (name === 'stats') renderStats();
  }

  function refreshActiveView() {
    const activeNav = $('.nav-item.active');
    if (!activeNav) return;
    const viewName = activeNav.dataset.view;
    if (viewName === 'dashboard') {
      renderDashboard();
    } else if (viewName === 'activities') {
      renderActivityList();
    }
  }

  // ── Dashboard Rendering ──
  function renderDashboard() {
    const today = todayStr();
    const todayActs = activities.filter(a => a.date === today);
    const completed = todayActs.filter(a => a.completed).length;
    const pending = todayActs.filter(a => !a.completed).length;
    const high = todayActs.filter(a => a.priority === 'high' && !a.completed).length;

    let totalMinutes = 0;
    todayActs.forEach(a => {
      if (a.startTime && a.endTime) {
        const [sh,sm] = a.startTime.split(':').map(Number);
        const [eh,em] = a.endTime.split(':').map(Number);
        totalMinutes += (eh*60+em) - (sh*60+sm);
      }
    });
    const hours = totalMinutes > 0 ? (totalMinutes/60).toFixed(1) + 'h' : '0h';

    $('#stat-completed').textContent = completed;
    $('#stat-pending').textContent = pending;
    $('#stat-high').textContent = high;
    $('#stat-hours').textContent = hours;

    // Greeting
    const userName = settings.username || '';
    const greet = getGreeting();
    const dashHeader = $('.view-header h2', $('#view-dashboard'));
    if (dashHeader) dashHeader.textContent = `${greet} ${userName ? userName + ' ' : ''}👋`;
    const sub = $('#dashboard-subtitle');
    if (sub) sub.textContent = formatDate(new Date());
    const topbarDate = $('#topbar-date');
    if (topbarDate) topbarDate.textContent = formatDate(new Date());

    // Diario grid
    renderDiarioGrid();

    // Timeline
    const timeline = $('#timeline-today');
    if (!timeline) return;
    if (todayActs.length === 0) {
      timeline.innerHTML = '';
      timeline.appendChild(createEmptyState());
      return;
    }

    const sorted = [...todayActs].sort((a,b) => (a.startTime||'').localeCompare(b.startTime||''));
    timeline.innerHTML = sorted.map(a => createTimelineItem(a)).join('');
    attachTimelineEvents(timeline);
  }

  // ── Diario Grid state ──
  let diarioYear  = new Date().getFullYear();
  let diarioMonth = new Date().getMonth(); // 0-indexed

  const TRACKED_ROWS_KEY = 'diary_tracked_rows';
  const DEFAULT_ROWS = [
    { label: 'Dormir 6-8 h', keys: ['dormir'],       color: '#48A6C8' }, // Azul (cuerpo)
    { label: 'Inglés',        keys: ['inglés','ingles'], color: '#3BA55D' }, // Verde (desarrollo)
    { label: 'Ejercicio',     keys: ['calistenia','correr','ejercicio','gym','cardio','pesas','yoga'], color: '#48A6C8' }, // Azul (ejercicio)
    { label: 'AI-300',        keys: ['ai-300','ai300'], color: '#3BA55D' }, // Verde (desarrollo)
    { label: 'MLOps',         keys: ['mlops'],         color: '#3BA55D' }, // Verde (desarrollo)
    { label: 'Leer',          keys: ['leer'],          color: '#E67E22' }, // Naranja (entretenimiento)
    { label: 'Meditar',       keys: ['meditar'],       color: '#E67E22' }, // Naranja (entretenimiento)
    { label: 'Fuyu',          keys: ['fuyu'],          color: '#D1B83B' }, // Amarillo (ingresos)
    { label: 'Proyectos',     keys: ['proyecto','proyectos','estudio'], color: '#D1B83B' }, // Amarillo (desarrollo/proyectos)
    { label: 'Manifestar',    keys: ['manifestar','planificación'], color: '#E67E22' }, // Naranja (disfruto/entretenimiento)
    { label: 'Crema',         keys: ['crema'],         color: '#E67E22' }, // Naranja (disfruto/entretenimiento)
    { label: 'Pastilla',      keys: ['pastilla'],      color: '#E67E22' }, // Naranja (disfruto/entretenimiento)
  ];

  function normalizeLabel(s) {
    if (typeof s !== 'string') return '';
    return s.toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, ' ')
            .trim();
  }

  function loadTrackedRows() {
    try {
      const stored = localStorage.getItem(TRACKED_ROWS_KEY);
      if (!stored) return DEFAULT_ROWS;
      let parsed = JSON.parse(stored);
      
      // Remove duplicates by normalized label name and filter out empty labels
      const seen = new Set();
      parsed = parsed.filter(r => {
        if (!r.label || r.label.trim() === '') return false;
        const norm = normalizeLabel(r.label);
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
      });
      
      // Migration: if keys for 'Leer' include 'libro' or if Inglés is old color, force reset
      const needsMigration = parsed.some(r => 
        (r.label === 'Leer' && r.keys.includes('libro')) || 
        (r.label === 'Inglés' && r.color === '#48A6C8')
      );

      if (needsMigration) {
        localStorage.setItem(TRACKED_ROWS_KEY, JSON.stringify(DEFAULT_ROWS));
        return DEFAULT_ROWS;
      }
      
      // Save cleaned array back
      localStorage.setItem(TRACKED_ROWS_KEY, JSON.stringify(parsed));
      return parsed;
    } catch {
      return DEFAULT_ROWS;
    }
  }

  function saveTrackedRows(rows) {
    localStorage.setItem(TRACKED_ROWS_KEY, JSON.stringify(rows));
  }

  let diarioRows = loadTrackedRows();

  // ── Diario Grid Rendering ──
  function renderDiarioGrid() {
    const table = $('#diario-table');
    const monthLabel = $('#diario-month-label');
    if (!table) return;

    const today = new Date();
    const todayDay   = today.getDate();
    const todayMonth = today.getMonth();
    const todayYear  = today.getFullYear();

    const daysInMonth = new Date(diarioYear, diarioMonth + 1, 0).getDate();
    const isCurrentMonth = diarioMonth === todayMonth && diarioYear === todayYear;

    if (monthLabel) {
      monthLabel.textContent = `${MONTHS_ES[diarioMonth]} ${diarioYear}`;
    }

    // Build a lookup: dateStr → Set of lowercased activity titles that are completed
    const completedByDate = {};
    const allByDate = {};
    activities.forEach(a => {
      const key = a.date;
      if (!allByDate[key])       allByDate[key] = [];
      if (!completedByDate[key]) completedByDate[key] = [];
      allByDate[key].push(a.title.toLowerCase());
      if (a.completed) completedByDate[key].push(a.title.toLowerCase());
    });

    // Helper to check if a row's keywords match any activity title on a given date
    function isDone(dateStr, rowKeys) {
      const done = completedByDate[dateStr] || [];
      return rowKeys.some(k => done.some(t => t.includes(k)));
    }
    function isRowMissed(dateStr, rowKeys) {
      const matching = activities.find(a =>
        a.date === dateStr &&
        rowKeys.some(k => a.title.toLowerCase().includes(k))
      );
      if (!matching) return false;
      return isActivityMissed(matching);
    }
    function hasAct(dateStr, rowKeys) {
      const all = allByDate[dateStr] || [];
      return rowKeys.some(k => all.some(t => t.includes(k)));
    }

    // Build HTML
    let html = '<thead><tr>';
    // First cell: empty corner
    html += `<th class="act-label" style="background:var(--bg-secondary);"></th>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${diarioYear}-${String(diarioMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday = isCurrentMonth && d === todayDay;
      html += `<th class="day-head${isToday ? ' is-today' : ''}" data-date="${dateStr}">${d}</th>`;
    }
    html += '</tr></thead><tbody>';

    diarioRows.forEach(row => {
      html += `<tr>`;
      // Label cell
      html += `<td class="act-label" style="background:${row.color || '#5B6FA0'};color:#fff;" title="${row.label}">${row.label}</td>`;

      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${diarioYear}-${String(diarioMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isFuture = isCurrentMonth && d > todayDay;
        const isToday  = isCurrentMonth && d === todayDay;
        const done = isDone(dateStr, row.keys);
        const missed = isRowMissed(dateStr, row.keys);
        const has  = hasAct(dateStr, row.keys);

        let cls = 'act-cell';
        if (done)     cls += ' done';
        else if (missed) cls += ' missed';
        if (isFuture) cls += ' is-future';
        if (isToday)  cls += ' is-today-col';

        const tooltip = `${row.label} – ${d}/${diarioMonth+1}: ${done ? '✅ completado' : missed ? '✕ no realizado' : has ? '⬜ pendiente' : '—'}`;
        html += `<td class="${cls}" data-date="${dateStr}" data-row="${row.label}" title="${tooltip}"></td>`;
      }
      html += `</tr>`;
    });

    html += '</tbody>';
    table.innerHTML = html;

    // ── Click to toggle: find matching activity and toggle it ──
    table.querySelectorAll('.act-cell:not(.is-future)').forEach(cell => {
      cell.addEventListener('click', () => {
        const dateStr  = cell.dataset.date;
        const rowLabel = cell.dataset.row;
        const rowDef   = diarioRows.find(r => r.label === rowLabel);
        if (!rowDef) return;

        // Find matching activity for that day
        const matching = activities.find(a =>
          a.date === dateStr &&
          rowDef.keys.some(k => a.title.toLowerCase().includes(k))
        );

        if (matching) {
          matching.completed = !matching.completed;
          saveActivities(activities);
          renderDiarioGrid();
          renderDashboard_stats();
          renderActivityList();
          showToast(
            matching.completed ? `✅ ${matching.title}` : `⬜ ${matching.title}`,
            matching.completed ? 'check_circle' : 'radio_button_unchecked',
            matching.completed ? 'var(--accent-teal)' : 'var(--text-muted)'
          );
        } else {
          // Create a new activity for that day and mark it completed (green)
          const newAct = {
            id: uid(),
            title: rowDef.label,
            date: dateStr,
            startTime: '08:00',
            endTime: '09:00',
            description: 'Registrado desde el panel mensual',
            priority: 'medium',
            tags: ['diario'],
            completed: true
          };
          activities.push(newAct);
          saveActivities(activities);
          renderDiarioGrid();
          renderDashboard_stats();
          renderActivityList();
          showToast(`✅ ${newAct.title}`, 'check_circle', 'var(--accent-teal)');
        }
      });
    });
  }

  // Lightweight stats-only refresh (no full re-render loop)
  function renderDashboard_stats() {
    const today = todayStr();
    const todayActs = activities.filter(a => a.date === today);
    const completed = todayActs.filter(a => a.completed).length;
    const pending   = todayActs.filter(a => !a.completed).length;
    const high      = todayActs.filter(a => a.priority === 'high' && !a.completed).length;
    let totalMin    = 0;
    todayActs.forEach(a => {
      if (a.startTime && a.endTime) {
        const [sh,sm] = a.startTime.split(':').map(Number);
        const [eh,em] = a.endTime.split(':').map(Number);
        totalMin += (eh*60+em) - (sh*60+sm);
      }
    });
    $('#stat-completed').textContent = completed;
    $('#stat-pending').textContent   = pending;
    $('#stat-high').textContent      = high;
    $('#stat-hours').textContent     = totalMin > 0 ? (totalMin/60).toFixed(1)+'h' : '0h';
  }

  function createEmptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
      <span class="material-icons-round">event_note</span>
      <p>No hay actividades para hoy</p>
      <button class="btn-primary" id="btn-add-first">Añadir actividad</button>
    `;
    div.querySelector('#btn-add-first')?.addEventListener('click', () => openModal());
    return div;
  }

  function isActivityMissed(a) {
    if (a.completed) return false;
    const today = todayStr();
    if (a.date < today) return true;
    if (a.date === today) {
      if (!a.endTime && !a.startTime) return false;
      const compareTime = a.endTime || a.startTime;
      const [h, m] = compareTime.split(':').map(Number);
      const now = new Date();
      const currentMin = now.getHours() * 60 + now.getMinutes();
      const targetMin = h * 60 + m;
      return currentMin > targetMin;
    }
    return false;
  }

  function createTimelineItem(a) {
    const timeStr = a.startTime ? (a.endTime ? `${a.startTime} – ${a.endTime}` : a.startTime) : '';
    const tags = (a.tags || []).map(t => `<span class="tl-tag">${escHTML(t)}</span>`).join('');
    const missed = isActivityMissed(a);
    const cbClass = a.completed ? 'checked' : (missed ? 'missed' : '');
    return `
      <div class="timeline-item ${a.completed ? 'completed' : ''} ${missed ? 'missed' : ''}" data-priority="${a.priority}" data-id="${a.id}">
        <div class="tl-checkbox ${cbClass}" data-toggle="${a.id}"></div>
        <div class="tl-content">
          <div class="tl-title">${escHTML(a.title)}</div>
          ${a.description ? `<div class="tl-desc">${escHTML(a.description)}</div>` : ''}
          <div class="tl-meta">
            ${timeStr ? `<span class="tl-time"><span class="material-icons-round">schedule</span>${timeStr}</span>` : ''}
            ${tags}
          </div>
        </div>
        <div class="tl-actions">
          <button class="tl-action-btn" data-edit="${a.id}" title="Editar">
            <span class="material-icons-round">edit</span>
          </button>
          <button class="tl-action-btn" data-delete="${a.id}" title="Eliminar">
            <span class="material-icons-round">delete_outline</span>
          </button>
        </div>
      </div>`;
  }

  function attachTimelineEvents(container) {
    container.querySelectorAll('[data-toggle]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.toggle;
        toggleActivity(id);
      });
    });
    container.querySelectorAll('[data-edit]').forEach(el => {
      el.addEventListener('click', () => openModal(el.dataset.edit));
    });
    container.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', () => confirmDelete(el.dataset.delete));
    });
  }

  function toggleActivity(id) {
    const act = activities.find(a => a.id === id);
    if (!act) return;
    act.completed = !act.completed;
    saveActivities(activities);
    renderDashboard();
    renderActivityList();
    renderDiarioGrid();
    showToast(act.completed ? 'Actividad completada ✓' : 'Actividad pendiente');
  }

  // ── Activity List Rendering ──
  function renderActivityList() {
    const list = $('#activity-list');
    if (!list) return;

    // Update daily header label
    const label = $('#label-day-current');
    if (label) {
      const d = new Date(activitiesSelectedDate + 'T12:00:00');
      const formatted = formatDate(d);
      const parts = formatted.split(',');
      label.textContent = activitiesSelectedDate === todayStr() 
        ? `Hoy, ${parts[1] ? parts[1].trim() : formatted}` 
        : formatted;
    }

    // Filter to selected date
    let filtered = activities.filter(a => a.date === activitiesSelectedDate);
    if (currentFilter === 'pending') filtered = filtered.filter(a => !a.completed);
    if (currentFilter === 'completed') filtered = filtered.filter(a => a.completed);

    // Sort: Active pending first (chronological), completed/missed at the bottom (chronological)
    filtered.sort((a, b) => {
      const aInactive = a.completed || isActivityMissed(a);
      const bInactive = b.completed || isActivityMissed(b);
      if (aInactive !== bInactive) {
        return aInactive ? 1 : -1;
      }
      return (a.startTime || '').localeCompare(b.startTime || '');
    });

    if (filtered.length === 0) {
      list.innerHTML = `<div class="empty-state">
        <span class="material-icons-round">checklist</span>
        <p>No hay actividades ${currentFilter === 'pending' ? 'pendientes' : currentFilter === 'completed' ? 'completadas' : ''} para este día</p>
      </div>`;
      return;
    }

    let html = '';
    filtered.forEach(a => {
      html += createTimelineItem(a);
    });
    list.innerHTML = html;
    attachTimelineEvents(list);
  }

  // ── Calendar ──
  function renderCalendar() {
    const calLabel = $('#cal-month-label');
    if (!calLabel) return;
    calLabel.textContent = `${MONTHS_ES[calMonth]} ${calYear}`;
    const body = $('#cal-body');
    const firstDay = new Date(calYear, calMonth, 1);
    let startDay = firstDay.getDay() - 1;
    if (startDay < 0) startDay = 6;
    const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
    const prevMonthDays = new Date(calYear, calMonth, 0).getDate();

    const today = todayStr();
    let html = '';

    for (let i = startDay - 1; i >= 0; i--) {
      const d = prevMonthDays - i;
      html += `<div class="cal-day other-month">${d}</div>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday = dateStr === today;
      const isSelected = dateStr === calSelectedDate;
      const hasActs = activities.some(a => a.date === dateStr);
      html += `<div class="cal-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-date="${dateStr}">
        ${d}
        ${hasActs ? '<span class="cal-dot"></span>' : ''}
      </div>`;
    }
    const totalCells = startDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remaining; i++) {
      html += `<div class="cal-day other-month">${i}</div>`;
    }
    body.innerHTML = html;

    body.querySelectorAll('.cal-day:not(.other-month)').forEach(el => {
      el.addEventListener('click', () => {
        calSelectedDate = el.dataset.date;
        renderCalendar();
        renderCalDayDetail();
      });
    });
    renderCalDayDetail();
  }

  function renderCalDayDetail() {
    const detailTitle = $('#cal-detail-title');
    if (!detailTitle) return;
    const d = new Date(calSelectedDate + 'T12:00:00');
    detailTitle.textContent = formatDate(d);
    const dayActs = activities.filter(a => a.date === calSelectedDate);
    const list = $('#cal-detail-list');
    if (!list) return;
    if (dayActs.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;margin-top:8px;">Sin actividades</p>';
      return;
    }
    const sorted = [...dayActs].sort((a, b) => {
      const aInactive = a.completed || isActivityMissed(a);
      const bInactive = b.completed || isActivityMissed(b);
      if (aInactive !== bInactive) return aInactive ? 1 : -1;
      return (a.startTime || '').localeCompare(b.startTime || '');
    });
    list.innerHTML = sorted.map(a => createTimelineItem(a)).join('');
    attachTimelineEvents(list);
  }

  // ── Statistics ──
  function renderStats() {
    renderWeekBars();
    renderPriorityBreakdown();
    renderProductivityChart();
  }

  // (rest of code omitted for size/clarity, full code is outputted in write_to_file)
  function renderWeekBars() {
    const container = $('#week-bars');
    if (!container) return;
    const today = new Date();
    const bars = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = toDateStr(d);
      const dayActs = activities.filter(a => a.date === dateStr);
      const completed = dayActs.filter(a => a.completed).length;
      bars.push({ label: DAYS_SHORT[(d.getDay()+6)%7], count: completed, total: dayActs.length });
    }
    const maxCount = Math.max(...bars.map(b => b.total), 1);
    container.innerHTML = bars.map(b => {
      const h = (b.total / maxCount) * 120;
      return `<div class="week-bar">
        <div class="week-bar-value">${b.count}/${b.total}</div>
        <div class="week-bar-fill" style="height:${Math.max(h,4)}px"></div>
        <div class="week-bar-label">${b.label}</div>
      </div>`;
    }).join('');
  }

  function renderPriorityBreakdown() {
    const container = $('#priority-breakdown');
    if (!container) return;
    const counts = { high: 0, medium: 0, low: 0 };
    activities.forEach(a => { if (counts[a.priority] !== undefined) counts[a.priority]++; });
    const total = Math.max(activities.length, 1);
    const data = [
      { key: 'high', label: 'Alta', color: 'var(--priority-high)', count: counts.high },
      { key: 'medium', label: 'Media', color: 'var(--priority-medium)', count: counts.medium },
      { key: 'low', label: 'Baja', color: 'var(--priority-low)', count: counts.low },
    ];
    container.innerHTML = data.map(d => `
      <div class="priority-row">
        <span class="priority-dot" style="background:${d.color}"></span>
        <span class="priority-label">${d.label}</span>
        <div class="priority-bar-bg">
          <div class="priority-bar-fill" style="width:${(d.count/total)*100}%;background:${d.color}"></div>
        </div>
        <span class="priority-count">${d.count}</span>
      </div>
    `).join('');
  }

  function renderProductivityChart() {
    const container = $('#productivity-chart');
    if (!container) return;
    const today = new Date();
    const bars = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = toDateStr(d);
      const dayActs = activities.filter(a => a.date === dateStr);
      const completed = dayActs.filter(a => a.completed).length;
      const pending = dayActs.filter(a => !a.completed).length;
      bars.push({ label: `${d.getDate()}/${d.getMonth()+1}`, completed, pending });
    }
    const maxVal = Math.max(...bars.map(b => b.completed + b.pending), 1);
    container.innerHTML = bars.map(b => {
      const ch = (b.completed / maxVal) * 130;
      const ph = (b.pending / maxVal) * 130;
      return `<div class="prod-bar">
        <div class="prod-bar-stack">
          <div class="prod-segment" style="height:${Math.max(ph,0)}px;background:var(--accent-amber);opacity:0.5"></div>
          <div class="prod-segment" style="height:${Math.max(ch,0)}px;background:var(--accent-teal)"></div>
        </div>
        <div class="prod-bar-label">${b.label}</div>
      </div>`;
    }).join('');
  }

  // ── Modal (Add/Edit Activity) ──
  function openModal(id = null) {
    editingId = id;
    const form = $('#activity-form');
    form.reset();
    if (id) {
      const a = activities.find(x => x.id === id);
      if (!a) return;
      $('#modal-title').textContent = 'Editar Actividad';
      $('#form-id').value = a.id;
      $('#form-title').value = a.title;
      $('#form-date').value = a.date;
      $('#form-start').value = a.startTime || '';
      $('#form-end').value = a.endTime || '';
      $('#form-desc').value = a.description || '';
      $('#form-priority').value = a.priority;
      $('#form-tags').value = (a.tags || []).join(', ');
    } else {
      $('#modal-title').textContent = 'Nueva Actividad';
      $('#form-date').value = calSelectedDate || todayStr();
    }
    $('#modal-overlay').classList.add('open');
    setTimeout(() => $('#form-title').focus(), 100);
  }

  function closeModal() {
    $('#modal-overlay').classList.remove('open');
    editingId = null;
  }

  function handleSubmit(e) {
    e.preventDefault();
    const title = $('#form-title').value.trim();
    if (!title) return;

    const data = {
      id: editingId || uid(),
      title,
      date: $('#form-date').value || todayStr(),
      startTime: $('#form-start').value || '',
      endTime: $('#form-end').value || '',
      description: $('#form-desc').value.trim(),
      priority: $('#form-priority').value,
      tags: $('#form-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      completed: false,
    };

    if (editingId) {
      const idx = activities.findIndex(a => a.id === editingId);
      if (idx !== -1) {
        data.completed = activities[idx].completed;
        activities[idx] = data;
      }
      showToast('Actividad actualizada');
    } else {
      activities.push(data);
      showToast('Actividad creada');
    }

    saveActivities(activities);
    closeModal();
    renderDashboard();
    renderActivityList();
    renderCalendar();
    scheduleWebAlarms();
  }

  // ── Delete ──
  function confirmDelete(id) {
    deletingId = id;
    $('#delete-overlay').classList.add('open');
  }
  function closeDeleteModal() {
    $('#delete-overlay').classList.remove('open');
    deletingId = null;
  }
  function executeDelete() {
    if (!deletingId) return;
    activities = activities.filter(a => a.id !== deletingId);
    saveActivities(activities);
    closeDeleteModal();
    renderDashboard();
    renderActivityList();
    renderCalendar();
    showToast('Actividad eliminada', 'delete', 'var(--accent-red)');
  }

  // ── Search ──
  function openSearch() {
    $('#search-overlay').classList.add('open');
    setTimeout(() => $('#search-input').focus(), 100);
  }
  function closeSearch() {
    $('#search-overlay').classList.remove('open');
    $('#search-input').value = '';
    $('#search-results').innerHTML = '';
  }
  function handleSearch(query) {
    const q = query.toLowerCase().trim();
    if (!q) { $('#search-results').innerHTML = ''; return; }
    const results = activities.filter(a =>
      a.title.toLowerCase().includes(q) ||
      (a.description||'').toLowerCase().includes(q) ||
      (a.tags||[]).some(t => t.toLowerCase().includes(q))
    );
    const container = $('#search-results');
    if (results.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Sin resultados</p>';
      return;
    }
    container.innerHTML = results.slice(0, 20).map(a => `
      <div class="search-result-item" data-goto="${a.id}">
        <span class="material-icons-round" style="color:var(--priority-${a.priority})">${a.completed ? 'task_alt' : 'radio_button_unchecked'}</span>
        <div>
          <div style="font-weight:600;font-size:0.9rem">${escHTML(a.title)}</div>
          <div style="font-size:0.78rem;color:var(--text-muted)">${a.date} ${a.startTime||''}</div>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-goto]').forEach(el => {
      el.addEventListener('click', () => {
        closeSearch();
        openModal(el.dataset.goto);
      });
    });
  }

  // ── Web Notification System ──
  let scheduledAlarms = [];

  function requestNotifPermission() {
    if (!('Notification' in window)) {
      showToast('Tu navegador no soporta notificaciones', 'warning', 'var(--accent-amber)');
      return Promise.resolve('denied');
    }
    if (Notification.permission === 'granted') return Promise.resolve('granted');
    return Notification.requestPermission();
  }

  function playAlarmSound() {
    if (!settings.alarmSound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1047].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.15);
        osc.stop(ctx.currentTime + i * 0.15 + 0.4);
      });
    } catch (e) { /* Audio not available */ }
  }

  function scheduleWebAlarms() {
    scheduledAlarms.forEach(id => clearTimeout(id));
    scheduledAlarms = [];

    if (!settings.notifications) return;

    const advance = parseInt(settings.alarmAdvance || '5', 10);
    const now = new Date();
    const todayActivities = activities.filter(a => a.date === todayStr() && !a.completed && a.startTime && a.alarm !== false);

    todayActivities.forEach(act => {
      const [h, m] = act.startTime.split(':').map(Number);
      const actTime = new Date();
      actTime.setHours(h, m, 0, 0);

      const alertTime = new Date(actTime.getTime() - advance * 60000);
      const delay = alertTime.getTime() - now.getTime();

      if (delay > 0) {
        const timerId = setTimeout(() => {
          const minuteLabel = advance > 0 ? `en ${advance} min` : 'ahora';
          const body = `"${act.title}" comienza ${minuteLabel} (${act.startTime}${act.endTime ? ' – ' + act.endTime : ''})`;

          if (Notification.permission === 'granted') {
            new Notification('Mi Diario – Recordatorio', {
              body,
              icon: '📋',
              tag: act.id,
              requireInteraction: true,
            });
          }

          playAlarmSound();
          addNotifToPanel(act, minuteLabel);
          showToast(`⏰ ${act.title} ${minuteLabel}`, 'alarm', 'var(--accent-amber)');
        }, delay);
        scheduledAlarms.push(timerId);
      }
    });
  }

  function addNotifToPanel(act, timeLabel) {
    const list = $('#notif-list');
    if (!list) return;
    const empty = list.querySelector('.notif-empty');
    if (empty) empty.remove();

    const dot = $('#notif-dot');
    if (dot) dot.style.display = 'block';

    const item = document.createElement('div');
    item.className = 'notif-item';
    item.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border-subtle);';
    item.innerHTML = `
      <span class="material-icons-round" style="color:var(--accent-amber);font-size:20px;margin-top:2px;">alarm</span>
      <div>
        <div style="font-weight:600;font-size:0.85rem;">${escHTML(act.title)}</div>
        <div style="font-size:0.75rem;color:var(--text-muted);">Comienza ${timeLabel} · ${act.startTime}</div>
      </div>
    `;
    list.prepend(item);
  }

  // ── Settings ──
  function initSettings() {
    const usernameInput = $('#setting-username');
    if (usernameInput) {
      usernameInput.value = settings.username || '';
      usernameInput.addEventListener('input', () => {
        settings.username = usernameInput.value.trim();
        saveSettings(settings);
      });
    }

    const notifToggle = $('#setting-notifications');
    if (notifToggle) {
      notifToggle.checked = settings.notifications || false;
      notifToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
          requestNotifPermission().then(perm => {
            if (perm === 'granted' || perm === 'default') {
              settings.notifications = true;
              saveSettings(settings);
              scheduleWebAlarms();
              showToast('Notificaciones activadas ✓');
            } else {
              e.target.checked = false;
              showToast('Permiso de notificaciones denegado', 'block', 'var(--accent-red)');
            }
          });
        } else {
          settings.notifications = false;
          saveSettings(settings);
          scheduledAlarms.forEach(id => clearTimeout(id));
          scheduledAlarms = [];
          showToast('Notificaciones desactivadas');
        }
      });
    }

    const soundToggle = $('#setting-alarm-sound');
    if (soundToggle) {
      soundToggle.checked = settings.alarmSound !== false;
      soundToggle.addEventListener('change', (e) => {
        settings.alarmSound = e.target.checked;
        saveSettings(settings);
        showToast(e.target.checked ? 'Sonido activado' : 'Sonido desactivado');
      });
    }

    const advanceSelect = $('#setting-alarm-advance');
    if (advanceSelect) {
      advanceSelect.value = settings.alarmAdvance || '5';
      advanceSelect.addEventListener('change', (e) => {
        settings.alarmAdvance = e.target.value;
        saveSettings(settings);
        scheduleWebAlarms();
        showToast(`Anticipación: ${e.target.value} minutos`);
      });
    }

    const groqKeyInput = $('#setting-groq-key');
    if (groqKeyInput) {
      groqKeyInput.value = settings.groqKey || '';
      groqKeyInput.addEventListener('input', () => {
        $('#settings-save-status') && ($('#settings-save-status').textContent = 'Sin guardar — haz clic en Guardar');
        $('#settings-save-status') && ($('#settings-save-status').style.color = 'var(--accent-amber)');
      });
    }

    const n8nUrlInput = $('#setting-n8n-url');
    if (n8nUrlInput) {
      n8nUrlInput.value = settings.n8nUrl || '';
      n8nUrlInput.addEventListener('input', () => {
        $('#settings-save-status') && ($('#settings-save-status').textContent = 'Sin guardar — haz clic en Guardar');
        $('#settings-save-status') && ($('#settings-save-status').style.color = 'var(--accent-amber)');
      });
    }

    // Update status badge on load based on whether key exists
    const statusEl = $('#settings-save-status');
    if (statusEl) {
      if (settings.groqKey) {
        statusEl.textContent = '✅ Configuración guardada correctamente';
        statusEl.style.color = 'var(--accent-teal)';
      } else {
        statusEl.textContent = 'Ingresa tu API Key y guarda';
        statusEl.style.color = 'var(--text-muted)';
      }
    }

    // Save button for IA settings
    const btnSaveAI = $('#btn-save-ai-settings');
    if (btnSaveAI) {
      btnSaveAI.addEventListener('click', () => {
        if (groqKeyInput) {
          settings.groqKey = groqKeyInput.value.trim();
        }
        if (n8nUrlInput) {
          settings.n8nUrl = n8nUrlInput.value.trim();
        }
        saveSettings(settings);
        const st = $('#settings-save-status');
        if (st) {
          if (settings.groqKey) {
            st.textContent = '✅ Configuración guardada correctamente';
            st.style.color = 'var(--accent-teal)';
          } else {
            st.textContent = '⚠️ API Key vacía — el agente no funcionará';
            st.style.color = 'var(--accent-amber)';
          }
        }
        showToast('Configuración guardada ✓', 'check_circle', 'var(--accent-teal)');
      });
    }

    const btnExport = $('#btn-export');
    if (btnExport) {
      btnExport.addEventListener('click', () => {
        const data = JSON.stringify(activities, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `mi-diario-backup-${todayStr()}.json`;
        a.click(); URL.revokeObjectURL(url);
        showToast('Datos exportados');
      });
    }

    const btnImport = $('#btn-import');
    if (btnImport) {
      btnImport.addEventListener('click', () => $('#import-file').click());
    }
    const importFile = $('#import-file');
    if (importFile) {
      importFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            if (Array.isArray(imported)) {
              activities = imported;
              saveActivities(activities);
              renderDashboard();
              showToast('Datos importados correctamente');
            }
          } catch { showToast('Error al importar', 'error', 'var(--accent-red)'); }
        };
        reader.readAsText(file);
      });
    }

    const btnClear = $('#btn-clear-data');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        if (confirm('¿Estás seguro? Se borrarán todas las actividades.')) {
          activities = [];
          saveActivities(activities);
          renderDashboard();
          renderActivityList();
          renderCalendar();
          showToast('Todos los datos borrados', 'delete_forever', 'var(--accent-red)');
        }
      });
    }

    const btnRestoreRoutine = $('#btn-restore-routine');
    if (btnRestoreRoutine) {
      btnRestoreRoutine.addEventListener('click', () => {
        if (confirm('¿Cargar la rutina base de la semana actual? Se borrarán todos los datos actuales.')) {
          activities = [];
          saveActivities(activities);
          seedSampleData();
          renderActivityList();
          renderCalendar();
          showToast('Rutina base cargada ✓', 'restart_alt', 'var(--accent-teal)');
        }
      });
    }
  }

  // ── HTML Escaping ──
  function escHTML(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Excel Routine Template Downloader ──
  function downloadRoutineTemplate() {
    const headers = ['Hora', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado', 'Domingo'];
    
    const rows = [
      ['06:30 - 07:30', 'Calistenia', 'Correr', 'Calistenia', 'Correr', 'Calistenia', 'Correr', 'Dormir'],
      ['07:30 - 08:00', 'Desayunar', 'Desayunar', 'Desayunar', 'Desayunar', 'Desayunar', 'Desayunar', 'Desayunar'],
      ['08:00 - 09:00', 'Ingles', 'Ingles', 'Ingles', 'Ingles', 'Ingles', '', 'AI-300'],
      ['09:00 - 12:30', 'Fuyu', 'Fuyu', 'Fuyu', 'Fuyu', 'Fuyu', 'MLOPS', 'Estudio'],
      ['12:30 - 14:00', 'Almuerzo', 'Almuerzo', 'Almuerzo', 'Almuerzo', 'Almuerzo', 'Almuerzo', 'Almuerzo'],
      ['14:00 - 15:30', 'Fuyu', 'Fuyu', 'Fuyu', 'Fuyu', 'Fuyu', 'Fuyu', 'Libro'],
      ['15:30 - 16:40', 'Benja', 'Benja', 'Benja', 'Benja', 'Benja', 'Fuyu', 'Entretenimiento'],
      ['16:40 - 17:50', 'Fuyu', 'Fuyu', 'Fuyu', 'Fuyu', 'Fuyu', '', 'Entretenimiento'],
      ['18:20 - 19:00', 'Benja', 'Benja', 'Benja', 'Benja', 'Benja', 'Fuyu', 'Entretenimiento'],
      ['19:00 - 21:00', 'AI-300', 'MLOPS', 'AI-300', 'MLOPS', 'AI-300', 'Entretenimiento', 'Entretenimiento'],
      ['21:00 - 22:00', 'Entretenimiento', 'Entretenimiento', 'Entretenimiento', 'Entretenimiento', 'Entretenimiento', 'Entretenimiento', 'Entretenimiento'],
      ['22:00 - 23:00', 'Libro/Meditart', 'Libro/Meditart', 'Libro/Meditart', 'Libro/Meditart', 'Libro/Meditart', 'Entretenimiento', 'Planificación'],
      ['23:00 - 06:30', 'Dormir', 'Dormir', 'Dormir', 'Dormir', 'Dormir', 'Dormir', 'Dormir']
    ];

    try {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      XLSX.utils.book_append_sheet(wb, ws, "Rutina Semanal");
      XLSX.writeFile(wb, "plantilla_rutina_semanal.xlsx");
      showToast('Plantilla Excel descargada', 'download', 'var(--accent-teal)');
    } catch (err) {
      console.error(err);
      alert('Error al generar la plantilla de Excel.');
    }
  }

  function parseTimeRange(timeStr) {
    if (typeof timeStr !== 'string') return { start: '', end: '' };
    const parts = timeStr.split('-').map(p => p.trim());
    if (parts.length < 2) return { start: '', end: '' };
    
    const padTime = (t) => {
      const partsT = t.split(':');
      if (partsT.length < 2) return '';
      const h = partsT[0].trim();
      const m = partsT[1].trim();
      return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    };

    return {
      start: padTime(parts[0]),
      end: padTime(parts[1])
    };
  }

  // ── Excel Routine File Handler ──
  function handleRoutineFile(file) {
    const startDateVal = $('#routine-start-date').value;
    const endDateVal = $('#routine-end-date').value;
    if (!startDateVal || !endDateVal) {
      alert('Por favor, selecciona las fechas de inicio y fin.');
      return;
    }

    const start = new Date(startDateVal + 'T00:00:00');
    const end = new Date(endDateVal + 'T23:59:59');

    if (end < start) {
      alert('La fecha de fin debe ser posterior a la fecha de inicio.');
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        
        const firstSheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[firstSheetName];
        
        const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (rawRows.length === 0) {
          alert('El archivo Excel está vacío.');
          return;
        }

        const headers = rawRows[0].map(h => String(h).trim().toLowerCase());
        
        const hasHora = headers.includes('hora');
        const dayNames = {
          0: ['domingo'],
          1: ['lunes'],
          2: ['martes'],
          3: ['miercoles', 'miércoles'],
          4: ['jueves'],
          5: ['viernes'],
          6: ['sabado', 'sábado']
        };

        const dayColIdxMap = {};
        let isMatrixFormat = hasHora;
        
        if (isMatrixFormat) {
          let matchedDays = 0;
          for (let d = 0; d <= 6; d++) {
            const possibleNames = dayNames[d];
            const idx = headers.findIndex(h => possibleNames.includes(h));
            if (idx !== -1) {
              dayColIdxMap[d] = idx;
              matchedDays++;
            }
          }
          if (matchedDays === 0) {
            isMatrixFormat = false;
          }
        }

        const clearExisting = $('#routine-clear-existing').checked;

        // Collect all dates in range
        const datesToPopulate = [];
        let curr = new Date(start);
        while (curr <= end) {
          datesToPopulate.push(toDateStr(curr));
          curr.setDate(curr.getDate() + 1);
        }

        // Clean if requested
        if (clearExisting) {
          activities = activities.filter(a => !datesToPopulate.includes(a.date));
        }

        let addedCount = 0;

        if (isMatrixFormat) {
          const horaColIdx = headers.indexOf('hora');
          for (let i = 1; i < rawRows.length; i++) {
            const timeCell = rawRows[i][horaColIdx];
            if (!timeCell) continue;

            const { start: startTime, end: endTime } = parseTimeRange(String(timeCell));
            if (!startTime) continue;

            datesToPopulate.forEach(dateStr => {
              const dateObj = new Date(dateStr + 'T12:00:00');
              const dayNum = dateObj.getDay();
              const colIdx = dayColIdxMap[dayNum];
              if (colIdx === undefined) return;

              const taskTitle = rawRows[i][colIdx];
              if (!taskTitle || String(taskTitle).trim() === '') return;

              activities.push({
                id: uid(),
                title: String(taskTitle).trim(),
                date: dateStr,
                startTime,
                endTime,
                description: '',
                priority: 'medium',
                tags: [],
                completed: false
              });
              addedCount++;
            });
          }
        } else {
          // Fallback to old structure
          const sheetSemana = workbook.Sheets['Semana'] || sheet;
          const sheetFinSemana = workbook.Sheets['Fin_de_Semana'] || sheet;

          const dataSemana = XLSX.utils.sheet_to_json(sheetSemana);
          const dataFinSemana = XLSX.utils.sheet_to_json(sheetFinSemana);

          datesToPopulate.forEach(dateStr => {
            const dateObj = new Date(dateStr + 'T12:00:00');
            const day = dateObj.getDay();
            const isWeekend = (day === 0 || day === 6);
            const routineSource = isWeekend ? dataFinSemana : dataSemana;

            routineSource.forEach(row => {
              const title = row['Título'] || row['Titulo'] || row['title'];
              if (!title) return;

              const startTime = row['Hora inicio'] || row['Hora Inicio'] || row['startTime'] || '';
              const endTime = row['Hora fin'] || row['Hora Fin'] || row['endTime'] || '';
              const priority = (row['Prioridad'] || row['priority'] || 'medium').toLowerCase();
              const tagsRaw = row['Etiqueta'] || row['Etiquetas'] || row['tags'] || '';
              const description = row['Descripción'] || row['Descripcion'] || row['description'] || '';

              const tags = typeof tagsRaw === 'string' 
                ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean)
                : [String(tagsRaw)].filter(Boolean);

              activities.push({
                id: uid(),
                title,
                date: dateStr,
                startTime,
                endTime,
                description,
                priority: ['low', 'medium', 'high'].includes(priority) ? priority : 'medium',
                tags,
                completed: false
              });
              addedCount++;
            });
          });
        }

        saveActivities(activities);
        renderDashboard();
        renderActivityList();
        renderCalendar();
        scheduleWebAlarms();

        // Close modal
        $('#routine-overlay').classList.remove('open');
        showToast(`Rutina importada: ${addedCount} actividades`, 'table_chart', 'var(--accent-teal)');
      } catch (err) {
        console.error(err);
        alert('Error al leer el archivo Excel. Asegúrate de usar la plantilla correcta.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ── AI Agent Chat Helper UI Methods ──
  function addAgentMessage(text) {
    const msgs = $('#chat-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'chat-message agent';
    div.innerHTML = escHTML(text).replace(/\n/g, '<br>');
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function addUserMessage(text) {
    const msgs = $('#chat-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'chat-message user';
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function addTypingIndicator() {
    const msgs = $('#chat-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'chat-message agent';
    div.id = 'chat-typing-indicator';
    div.innerHTML = '<span style="opacity:0.6;">Pensando...</span>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function removeTypingIndicator() {
    $('#chat-typing-indicator')?.remove();
  }

  // ── Database Action Executor for Agent ──
  function executeAgentActions(actions) {
    if (!Array.isArray(actions)) return;
    let modified = false;

    actions.forEach(action => {
      if (action.type === 'add') {
        if (!action.title) return;
        activities.push({
          id: uid(),
          title: action.title,
          date: action.date || todayStr(),
          startTime: action.startTime || '',
          endTime: action.endTime || '',
          description: action.description || '',
          priority: action.priority || 'medium',
          tags: action.tags || [],
          completed: false
        });
        modified = true;
      } else if (action.type === 'cancel') {
        const id = action.id;
        if (id) {
          activities = activities.filter(a => a.id !== id);
          modified = true;
        }
      } else if (action.type === 'complete') {
        const act = activities.find(a => a.id === action.id);
        if (act) {
          act.completed = true;
          modified = true;
        }
      } else if (action.type === 'uncomplete') {
        const act = activities.find(a => a.id === action.id);
        if (act) {
          act.completed = false;
          modified = true;
        }
      } else if (action.type === 'update') {
        const act = activities.find(a => a.id === action.id);
        if (act) {
          if (action.title !== undefined) act.title = action.title;
          if (action.date !== undefined) act.date = action.date;
          if (action.startTime !== undefined) act.startTime = action.startTime;
          if (action.endTime !== undefined) act.endTime = action.endTime;
          if (action.priority !== undefined) act.priority = action.priority;
          if (action.tags !== undefined) act.tags = action.tags;
          if (action.description !== undefined) act.description = action.description;
          modified = true;
        }
      }
    });

    if (modified) {
      saveActivities(activities);
      renderDashboard();
      renderActivityList();
      renderCalendar();
      scheduleWebAlarms();
    }
  }

  // ── AI Callers (Groq / n8n) ──
  async function callGroq(userText, apiKey, relevantActs) {
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const now = new Date();
    const systemPrompt = `Eres un asistente de productividad para la app "Mi Diario". Debes responder en formato JSON válido con los campos:
1. "reply" (string): Tu respuesta al usuario en español, de forma amable y concisa. Explica brevemente qué cambios has hecho.
2. "actions" (array de objetos): Acciones a realizar en la base de datos de actividades.

Acciones permitidas en el array:
- { "type": "add", "title": string, "date": "YYYY-MM-DD", "startTime": "HH:MM" (opcional), "endTime": "HH:MM" (opcional), "priority": "high"|"medium"|"low" (opcional), "tags": [string] (opcional), "description": string (opcional) }
- { "type": "cancel", "id": string }
- { "type": "complete", "id": string }
- { "type": "uncomplete", "id": string }
- { "type": "update", "id": string, ...campos opcionales... }

La fecha y hora actuales son: ${now.toLocaleString('es-ES', { timeZone: 'America/Bogota' })}. Hoy es ${DAYS_ES[now.getDay()]}.
A continuación, tienes las actividades relevantes en la base de datos (de los últimos y próximos 3 días):
${JSON.stringify(relevantActs, null, 2)}

Si el usuario pide cancelar, cambiar horas, completar o añadir actividades, traduce esto a los objetos correspondientes en "actions" usando sus IDs exactos. Si solo te hace una pregunta, deja el array "actions" vacío.
SIEMPRE devuelve un JSON válido.
`;

    if (!window.chatHistory) window.chatHistory = [];
    window.chatHistory.push({ role: 'user', content: userText });
    
    if (window.chatHistory.length > 6) {
      window.chatHistory = window.chatHistory.slice(-6);
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...window.chatHistory
    ];

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-specdec',
          messages: messages,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });

      removeTypingIndicator();

      if (!response.ok) {
        const errText = await response.text();
        console.error('Groq Error:', errText);
        addAgentMessage('⚠️ Error al conectar con Groq. Verifica tu API Key.');
        return;
      }

      const resData = await response.json();
      const content = resData.choices[0].message.content;
      const parsed = JSON.parse(content);
      
      window.chatHistory.push({ role: 'assistant', content: content });

      addAgentMessage(parsed.reply);

      if (parsed.actions && parsed.actions.length > 0) {
        executeAgentActions(parsed.actions);
      }
    } catch (err) {
      console.error(err);
      removeTypingIndicator();
      addAgentMessage('⚠️ Error procesando la respuesta del agente.');
    }
  }

  async function callN8n(userText, relevantActs) {
    const url = settings.n8nUrl;
    const now = new Date();
    
    const payload = {
      message: userText,
      timestamp: now.toISOString(),
      currentTime: now.toLocaleTimeString(),
      currentDate: todayStr(),
      currentDay: DAYS_ES[now.getDay()],
      activities: relevantActs
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      removeTypingIndicator();

      if (!response.ok) {
        addAgentMessage('⚠️ Error al conectar con n8n. Verifica la URL del Webhook.');
        return;
      }

      const resData = await response.json();
      if (resData && (resData.reply || resData.actions)) {
        addAgentMessage(resData.reply || 'Procesado.');
        if (resData.actions && resData.actions.length > 0) {
          executeAgentActions(resData.actions);
        }
      } else if (typeof resData === 'string') {
        addAgentMessage(resData);
      } else if (resData && resData.output) {
        addAgentMessage(resData.output);
      } else {
        addAgentMessage('Recibido de n8n, pero no se reconoció el formato (esperaba reply/actions).');
      }
    } catch (err) {
      console.error(err);
      removeTypingIndicator();
      addAgentMessage('⚠️ Error al conectar con el servidor n8n.');
    }
  }

  // ── Initialize ──
  function init() {
    const appWrapper = $('#app-wrapper');
    if (appWrapper) appWrapper.style.display = '';

    // Navigation
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $$('.bnav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

    // Sidebar toggle (mobile)
    const menuToggle = $('#menu-toggle');
    if (menuToggle) menuToggle.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    const sidebarClose = $('#sidebar-close');
    if (sidebarClose) sidebarClose.addEventListener('click', () => $('#sidebar').classList.remove('open'));

    // Close sidebar when clicking a nav item on mobile
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => {
      if (window.innerWidth <= 768) $('#sidebar').classList.remove('open');
    }));

    // Add custom row to DIARIO grid
    const addRowBtn = $('#diario-add-row-btn');
    const newRowInput = $('#diario-new-row-label');
    if (addRowBtn && newRowInput) {
      addRowBtn.addEventListener('click', () => {
        const val = newRowInput.value.trim();
        if (!val) return;
        
        // Check for duplicates
        const exists = diarioRows.some(r => r.label.toLowerCase() === val.toLowerCase());
        if (exists) {
          showToast('Esta actividad ya está registrada', 'info', 'var(--accent-amber)');
          return;
        }

        const categorySelect = $('#diario-new-row-category');
        const selectedColor = categorySelect ? categorySelect.value : '#5B6FA0';

        const newRow = {
          label: val,
          keys: [val.toLowerCase()],
          color: selectedColor
        };

        diarioRows.push(newRow);
        saveTrackedRows(diarioRows);
        renderDiarioGrid();
        newRowInput.value = '';
        showToast(`Agregado: "${val}" al Diario ✓`, 'check_circle', 'var(--accent-teal)');
      });

      newRowInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addRowBtn.click();
        }
      });
    }

    // FAB
    const fab = $('#fab-add');
    if (fab) fab.addEventListener('click', () => openModal());
    $('#btn-add-from-dashboard')?.addEventListener('click', () => openModal());

    // Modal
    $('#modal-close')?.addEventListener('click', closeModal);
    $('#btn-cancel')?.addEventListener('click', closeModal);
    $('#modal-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
    $('#activity-form')?.addEventListener('submit', handleSubmit);

    // Delete modal
    $('#delete-close')?.addEventListener('click', closeDeleteModal);
    $('#delete-cancel')?.addEventListener('click', closeDeleteModal);
    $('#delete-confirm')?.addEventListener('click', executeDelete);
    $('#delete-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDeleteModal(); });

    // Search
    $('#btn-search')?.addEventListener('click', openSearch);
    $('#search-close')?.addEventListener('click', closeSearch);
    $('#search-input')?.addEventListener('input', (e) => handleSearch(e.target.value));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeSearch(); closeModal(); closeDeleteModal(); $('#routine-overlay')?.classList.remove('open'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
    });

    // Calendar nav
    $('#cal-prev')?.addEventListener('click', () => {
      calMonth--;
      if (calMonth < 0) { calMonth = 11; calYear--; }
      renderCalendar();
    });
    $('#cal-next')?.addEventListener('click', () => {
      calMonth++;
      if (calMonth > 11) { calMonth = 0; calYear++; }
      renderCalendar();
    });

    // Daily timeline nav buttons
    $('#btn-day-prev')?.addEventListener('click', () => {
      const d = new Date(activitiesSelectedDate + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      activitiesSelectedDate = toDateStr(d);
      renderActivityList();
    });
    $('#btn-day-next')?.addEventListener('click', () => {
      const d = new Date(activitiesSelectedDate + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      activitiesSelectedDate = toDateStr(d);
      renderActivityList();
    });
    $('#btn-day-today')?.addEventListener('click', () => {
      activitiesSelectedDate = todayStr();
      renderActivityList();
    });

    // Filters
    $$('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentFilter = btn.dataset.filter;
        $$('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === currentFilter));
        renderActivityList();
      });
    });

    // Settings
    initSettings();

    // User avatar initial
    const name = settings.username || 'U';
    const avatar = $('#user-avatar');
    if (avatar) avatar.textContent = name.charAt(0).toUpperCase();

    // Diario nav buttons
    $('#diario-prev')?.addEventListener('click', () => {
      diarioMonth--;
      if (diarioMonth < 0) { diarioMonth = 11; diarioYear--; }
      renderDiarioGrid();
    });
    $('#diario-next')?.addEventListener('click', () => {
      diarioMonth++;
      if (diarioMonth > 11) { diarioMonth = 0; diarioYear++; }
      renderDiarioGrid();
    });

    // Notification panel
    $('#notif-clear-all')?.addEventListener('click', () => {
      const list = $('#notif-list');
      if (list) list.innerHTML = '<p class="notif-empty">Sin notificaciones</p>';
      const dot = $('#notif-dot');
      if (dot) dot.style.display = 'none';
    });

    $('#btn-notifications')?.addEventListener('click', () => {
      const panel = $('#notif-panel');
      if (panel) panel.classList.toggle('open');
    });

    // --- Routine Modal Event Listeners ---
    $('#btn-open-routine-modal')?.addEventListener('click', () => {
      const startInput = $('#routine-start-date');
      const endInput = $('#routine-end-date');
      if (startInput) startInput.value = todayStr();
      if (endInput) {
        const nextMonth = new Date();
        nextMonth.setDate(nextMonth.getDate() + 30);
        endInput.value = toDateStr(nextMonth);
      }
      $('#routine-overlay').classList.add('open');
    });

    $('#routine-close')?.addEventListener('click', () => $('#routine-overlay').classList.remove('open'));
    $('#routine-cancel')?.addEventListener('click', () => $('#routine-overlay').classList.remove('open'));
    $('#routine-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#routine-overlay').classList.remove('open'); });

    $('#btn-download-template')?.addEventListener('click', downloadRoutineTemplate);

    const dropArea = $('#routine-drop-area');
    const fileInput = $('#routine-file-input');

    if (dropArea && fileInput) {
      dropArea.addEventListener('click', () => fileInput.click());
      
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleRoutineFile(file);
      });

      ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, (e) => {
          e.preventDefault();
          dropArea.classList.add('dragover');
        }, false);
      });

      ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, (e) => {
          e.preventDefault();
          dropArea.classList.remove('dragover');
        }, false);
      });

      dropArea.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const file = dt.files[0];
        if (file) handleRoutineFile(file);
      }, false);
    }

    // --- Chat Widget Event Listeners ---
    const chatWidget = $('#chat-widget');
    const chatToggle = $('#chat-toggle');
    const chatCloseBtn = $('#chat-close-btn');
    const chatSendBtn = $('#chat-send-btn');
    const chatInput = $('#chat-input');

    if (chatWidget && chatToggle) {
      chatToggle.addEventListener('click', () => {
        chatWidget.classList.toggle('open');
        const badge = $('#chat-badge');
        if (badge) badge.style.display = 'none';
        if (chatWidget.classList.contains('open')) {
          setTimeout(() => chatInput?.focus(), 200);
        }
      });

      chatCloseBtn?.addEventListener('click', () => {
        chatWidget.classList.remove('open');
      });

      const handleSend = () => {
        const text = chatInput.value.trim();
        if (!text) return;
        addUserMessage(text);
        chatInput.value = '';
        chatInput.style.height = 'auto';
        
        const now = new Date();
        const rangeStart = new Date(now.getTime() - 3 * 86400000);
        const rangeEnd = new Date(now.getTime() + 3 * 86400000);
        const relevantActs = activities.filter(a => {
          const d = new Date(a.date + 'T12:00:00');
          return d >= rangeStart && d <= rangeEnd;
        });

        if (settings.n8nUrl) {
          addTypingIndicator();
          callN8n(text, relevantActs);
        } else if (settings.groqKey) {
          addTypingIndicator();
          callGroq(text, settings.groqKey, relevantActs);
        } else {
          addAgentMessage("⚠️ Por favor, configura tu API Key de Groq o la URL de n8n en la pestaña Ajustes.");
        }
      };

      chatSendBtn?.addEventListener('click', handleSend);

      chatInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });

      chatInput?.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = (chatInput.scrollHeight) + 'px';
      });
    }

    // Initial render
    switchView('dashboard');

    // Seed sample data if empty or if there are no activities in the current week
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Dom, 1=Lun, ..., 6=Sab
    const diffToMonday = (dayOfWeek === 0) ? -6 : 1 - dayOfWeek;
    const mondayDate = new Date(now);
    mondayDate.setDate(now.getDate() + diffToMonday);
    mondayDate.setHours(0,0,0,0);
    const sundayDate = new Date(mondayDate);
    sundayDate.setDate(mondayDate.getDate() + 6);
    sundayDate.setHours(23,59,59,999);

    const hasCurrentWeekActs = activities.some(a => {
      const d = new Date(a.date + 'T12:00:00');
      return d >= mondayDate && d <= sundayDate;
    });

    if (activities.length === 0 || !hasCurrentWeekActs) {
      seedSampleData();
    }

    // Schedule web alarms for today
    scheduleWebAlarms();

    // Auto-refresh the active view every 30 seconds to update missed status
    setInterval(refreshActiveView, 30000);
  }

  function seedSampleData() {
    // ── Obtener lunes de la semana actual ──
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Dom, 1=Lun, ..., 6=Sab
    const diffToMonday = (dayOfWeek === 0) ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diffToMonday);
    monday.setHours(0,0,0,0);

    // Helper para obtener fecha de un día de la semana (0=Lun...6=Dom)
    function weekDay(offset) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + offset);
      return toDateStr(d);
    }

    const lun = weekDay(0);
    const mar = weekDay(1);
    const mie = weekDay(2);
    const jue = weekDay(3);
    const vie = weekDay(4);
    const sab = weekDay(5);
    const dom = weekDay(6);

    // ── Rutina base por bloque ──
    // Dormir: 23:00 del día anterior → 06:30
    // Nota: lo registramos como actividad de inicio el mismo día

    function block(date, startTime, endTime, title, priority, tags, description) {
      return { id: uid(), title, date, startTime, endTime, description: description || '', priority, tags, completed: false };
    }

    activities = [
      // ══ LUNES ══
      block(lun, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(lun, '06:30', '07:30', 'Calistenia', 'high', ['salud','ejercicio'], 'Rutina de calistenia mañanera'),
      block(lun, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(lun, '08:00', '09:00', 'Inglés', 'high', ['estudio','idiomas'], 'Práctica de inglés'),
      block(lun, '09:00', '12:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(lun, '12:30', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(lun, '14:00', '15:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(lun, '15:30', '16:40', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(lun, '16:40', '17:50', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(lun, '18:20', '19:00', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(lun, '19:00', '21:00', 'AI-300', 'high', ['estudio','ia'], 'Curso AI-300'),
      block(lun, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(lun, '22:00', '22:30', 'Leer', 'medium', ['personal','lectura'], 'Lectura de libro'),
      block(lun, '22:30', '23:00', 'Meditar', 'medium', ['personal','bienestar'], 'Meditación de cierre'),

      // ══ MARTES ══
      block(mar, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(mar, '06:30', '07:30', 'Correr', 'high', ['salud','ejercicio'], 'Carrera matutina'),
      block(mar, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(mar, '08:00', '09:00', 'Inglés', 'high', ['estudio','idiomas'], 'Práctica de inglés'),
      block(mar, '09:00', '12:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(mar, '12:30', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(mar, '14:00', '15:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(mar, '15:30', '16:40', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(mar, '16:40', '17:50', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(mar, '18:20', '19:00', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(mar, '19:00', '21:00', 'MLOPS', 'high', ['estudio','ia'], 'Estudio MLOps'),
      block(mar, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(mar, '22:00', '22:30', 'Leer', 'medium', ['personal','lectura'], 'Lectura de libro'),
      block(mar, '22:30', '23:00', 'Meditar', 'medium', ['personal','bienestar'], 'Meditación de cierre'),

      // ══ MIÉRCOLES ══
      block(mie, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(mie, '06:30', '07:30', 'Calistenia', 'high', ['salud','ejercicio'], 'Rutina de calistenia mañanera'),
      block(mie, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(mie, '08:00', '09:00', 'Inglés', 'high', ['estudio','idiomas'], 'Práctica de inglés'),
      block(mie, '09:00', '12:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(mie, '12:30', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(mie, '14:00', '15:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(mie, '15:30', '16:40', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(mie, '16:40', '17:50', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(mie, '18:20', '19:00', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(mie, '19:00', '21:00', 'AI-300', 'high', ['estudio','ia'], 'Curso AI-300'),
      block(mie, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(mie, '22:00', '22:30', 'Leer', 'medium', ['personal','lectura'], 'Lectura de libro'),
      block(mie, '22:30', '23:00', 'Meditar', 'medium', ['personal','bienestar'], 'Meditación de cierre'),

      // ══ JUEVES ══
      block(jue, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(jue, '06:30', '07:30', 'Correr', 'high', ['salud','ejercicio'], 'Carrera matutina'),
      block(jue, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(jue, '08:00', '09:00', 'Inglés', 'high', ['estudio','idiomas'], 'Práctica de inglés'),
      block(jue, '09:00', '12:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(jue, '12:30', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(jue, '14:00', '15:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(jue, '15:30', '16:40', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(jue, '16:40', '17:50', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(jue, '18:20', '19:00', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(jue, '19:00', '21:00', 'MLOPS', 'high', ['estudio','ia'], 'Estudio MLOps'),
      block(jue, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(jue, '22:00', '22:30', 'Leer', 'medium', ['personal','lectura'], 'Lectura de libro'),
      block(jue, '22:30', '23:00', 'Meditar', 'medium', ['personal','bienestar'], 'Meditación de cierre'),

      // ══ VIERNES ══
      block(vie, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(vie, '06:30', '07:30', 'Calistenia', 'high', ['salud','ejercicio'], 'Rutina de calistenia mañanera'),
      block(vie, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(vie, '08:00', '09:00', 'Inglés', 'high', ['estudio','idiomas'], 'Práctica de inglés'),
      block(vie, '09:00', '12:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(vie, '12:30', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(vie, '14:00', '15:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(vie, '15:30', '16:40', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(vie, '16:40', '17:50', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(vie, '18:20', '19:00', 'Benja', 'medium', ['personal','familia'], 'Tiempo con Benja'),
      block(vie, '19:00', '21:00', 'AI-300', 'high', ['estudio','ia'], 'Curso AI-300'),
      block(vie, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(vie, '22:00', '22:30', 'Leer', 'medium', ['personal','lectura'], 'Lectura de libro'),
      block(vie, '22:30', '23:00', 'Meditar', 'medium', ['personal','bienestar'], 'Meditación de cierre'),

      // ══ SÁBADO ══
      block(sab, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(sab, '06:30', '07:30', 'Correr', 'high', ['salud','ejercicio'], 'Carrera matutina'),
      block(sab, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(sab, '09:00', '12:30', 'MLOPS', 'high', ['estudio','ia'], 'Estudio MLOps – bloque largo'),
      block(sab, '12:30', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(sab, '14:00', '15:30', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(sab, '15:30', '16:40', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(sab, '16:40', '17:50', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(sab, '18:20', '19:00', 'Fuyu', 'high', ['trabajo','fuyu'], 'Trabajo en proyecto Fuyu'),
      block(sab, '19:00', '21:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(sab, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(sab, '22:00', '22:30', 'Leer', 'medium', ['personal','lectura'], 'Lectura de libro'),
      block(sab, '22:30', '23:00', 'Meditar', 'medium', ['personal','bienestar'], 'Meditación de cierre'),

      // ══ DOMINGO ══
      block(dom, '00:00', '07:30', 'Dormir', 'high', ['salud'], 'Sueño largo reparador'),
      block(dom, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(dom, '08:00', '09:00', 'AI-300', 'high', ['estudio','ia'], 'Curso AI-300'),
      block(dom, '09:00', '12:30', 'Estudio', 'high', ['estudio'], 'Bloque de estudio libre'),
      block(dom, '12:30', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(dom, '14:00', '15:30', 'Leer', 'low', ['personal','bienestar'], 'Lectura de libro'),
      block(dom, '15:30', '19:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(dom, '19:00', '21:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(dom, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], 'Descanso y entretenimiento'),
      block(dom, '22:00', '23:00', 'Planificación', 'high', ['trabajo','personal'], 'Planificación de la semana siguiente'),
    ];
    saveActivities(activities);
    renderDashboard();
  }

  // ── Boot ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
