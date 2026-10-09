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
  const generateUUID = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> (+c / 4))).toString(16)
    );
  };
  const uid = () => generateUUID();

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

  // ── Data Layer (StorageAdapter, Sync Queue & Conflicts) ──
  const STORAGE_KEY = 'diary_activities';
  const SETTINGS_KEY = 'diary_settings';
  const SYNC_QUEUE_KEY = 'diary_sync_queue';
  const LAST_SYNC_KEY = 'diary_last_sync';
  const CONFLICTS_KEY = 'diary_conflicts';
  const REJECTED_KEY = 'diary_rejected_items';

  const SUBJECTS_KEY = 'diary_subjects';
  const TOPICS_KEY = 'diary_topics';
  const FOCUS_SESSIONS_KEY = 'diary_focus_sessions';
  const LEARNING_NOTES_KEY = 'diary_learning_notes';

  function safeStorageGet(key, defaultVal = null) {
    try {
      const adapter = (typeof SyncCore !== 'undefined' && SyncCore.StorageAdapter) ? SyncCore.StorageAdapter : {
        getItem: (k) => localStorage.getItem(k)
      };
      const raw = adapter.getItem(key);
      if (raw === null || raw === undefined) return defaultVal;
      return JSON.parse(raw);
    } catch {
      return defaultVal;
    }
  }

  function safeStorageSet(key, value) {
    try {
      const adapter = (typeof SyncCore !== 'undefined' && SyncCore.StorageAdapter) ? SyncCore.StorageAdapter : {
        setItem: (k, v) => localStorage.setItem(k, v)
      };
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      adapter.setItem(key, str);
      return true;
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        showToast('Almacenamiento local lleno (QuotaExceededError). Por favor exporta tu diario o limpia datos.', 'warning', 'var(--accent-coral, #e74c3c)');
      }
      return false;
    }
  }

  function loadActivities() {
    return safeStorageGet(STORAGE_KEY, []);
  }
  function saveActivities(list) {
    activities = list;
    safeStorageSet(STORAGE_KEY, list);
  }
  function loadSubjects() {
    return safeStorageGet(SUBJECTS_KEY, []);
  }
  function saveSubjects(list) {
    subjects = list;
    safeStorageSet(SUBJECTS_KEY, list);
  }
  function migrateLegacyTopicStatuses(list) {
    if (!Array.isArray(list)) return [];
    let changed = false;
    const migrated = list.map(t => {
      if (!t || typeof t !== 'object') return t;
      let newStatus = t.status;
      if (t.status === 'not_started') newStatus = 'pending';
      else if (t.status === 'completed' || t.status === 'review_needed') newStatus = 'mastered';
      else if (!['pending', 'in_progress', 'mastered'].includes(t.status)) newStatus = 'pending';

      if (newStatus !== t.status) {
        changed = true;
        return { ...t, status: newStatus };
      }
      return t;
    });
    if (changed) {
      safeStorageSet(TOPICS_KEY, migrated);
    }
    return migrated;
  }

  function loadTopics() {
    const raw = safeStorageGet(TOPICS_KEY, []);
    return migrateLegacyTopicStatuses(raw);
  }
  function saveTopics(list) {
    topics = list;
    safeStorageSet(TOPICS_KEY, list);
  }
  function loadFocusSessions() {
    return safeStorageGet(FOCUS_SESSIONS_KEY, []);
  }
  function saveFocusSessions(list) {
    focusSessions = list;
    safeStorageSet(FOCUS_SESSIONS_KEY, list);
  }
  function loadLearningNotes() {
    return safeStorageGet(LEARNING_NOTES_KEY, []);
  }
  function saveLearningNotes(list) {
    learningNotes = list;
    safeStorageSet(LEARNING_NOTES_KEY, list);
  }

  function loadSettings() {
    return safeStorageGet(SETTINGS_KEY, {});
  }
  function saveSettings(s) {
    safeStorageSet(SETTINGS_KEY, s);
  }

  function getSyncQueue() {
    return safeStorageGet(SYNC_QUEUE_KEY, []);
  }
  function saveSyncQueue(q) {
    safeStorageSet(SYNC_QUEUE_KEY, q);
  }
  function getLastSync() {
    try {
      const adapter = (typeof SyncCore !== 'undefined' && SyncCore.StorageAdapter) ? SyncCore.StorageAdapter : {
        getItem: (k) => localStorage.getItem(k)
      };
      return adapter.getItem(LAST_SYNC_KEY) || null;
    } catch {
      return null;
    }
  }
  function setLastSync(ts) {
    if (!ts) return;
    try {
      const adapter = (typeof SyncCore !== 'undefined' && SyncCore.StorageAdapter) ? SyncCore.StorageAdapter : {
        setItem: (k, v) => localStorage.setItem(k, v)
      };
      adapter.setItem(LAST_SYNC_KEY, ts);
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        showToast('Almacenamiento local lleno (QuotaExceededError).', 'warning', 'var(--accent-coral, #e74c3c)');
      }
    }
  }
  function getConflictsStore() {
    return safeStorageGet(CONFLICTS_KEY, {});
  }
  function saveConflictsStore(store) {
    safeStorageSet(CONFLICTS_KEY, store);
    updateConflictsBadge();
  }
  function getRejectedStore() {
    return safeStorageGet(REJECTED_KEY, {});
  }
  function saveRejectedStore(store) {
    safeStorageSet(REJECTED_KEY, store);
  }

  function enqueueChange(change) {
    const q = getSyncQueue();
    const updatedQ = (typeof SyncCore !== 'undefined' && SyncCore.enqueueChange)
      ? SyncCore.enqueueChange(q, change)
      : (() => {
          const idx = q.findIndex(item => item.id === change.id);
          if (idx !== -1) {
            q[idx] = { ...q[idx], ...change };
          } else {
            q.push(change);
          }
          return q;
        })();
    saveSyncQueue(updatedQ);
  }

  let activities = loadActivities();
  let subjects = loadSubjects();
  let topics = loadTopics();
  let focusSessions = loadFocusSessions();
  let learningNotes = loadLearningNotes();
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
    if (name === 'study') renderStudyView();
  }

  function refreshActiveView() {
    const activeNav = $('.nav-item.active');
    if (!activeNav) return;
    const viewName = activeNav.dataset.view;
    if (viewName === 'dashboard') {
      renderDashboard();
    } else if (viewName === 'activities') {
      renderActivityList();
    } else if (viewName === 'study') {
      renderStudyView();
    }
  }

  // ── Dashboard Rendering ──
  function renderDashboard() {
    const today = todayStr();
    const todayActs = (typeof SyncCore !== 'undefined' && SyncCore.getActiveDashboardActivities)
      ? SyncCore.getActiveDashboardActivities(activities, today)
      : activities.filter(a => a && !a.deleted_at && a.date === today);
    const completed = todayActs.filter(a => a.completed).length;
    const pending   = todayActs.filter(a => !a.completed).length;
    const high      = todayActs.filter(a => a.priority === 'high' && !a.completed).length;
    const total     = todayActs.length;

    let totalMinutes = 0;
    todayActs.forEach(a => {
      if (a.startTime && a.endTime) {
        const [sh, sm] = a.startTime.split(':').map(Number);
        const [eh, em] = a.endTime.split(':').map(Number);
        totalMinutes += (eh * 60 + em) - (sh * 60 + sm);
      }
    });
    const hours = totalMinutes > 0 ? (totalMinutes / 60).toFixed(1) + 'h' : '0h';

    // ── Stat chips ──
    const el = id => document.getElementById(id);
    if (el('stat-completed')) el('stat-completed').textContent = completed;
    if (el('stat-pending'))   el('stat-pending').textContent   = pending;
    if (el('stat-high'))      el('stat-high').textContent      = high;
    if (el('stat-hours'))     el('stat-hours').textContent     = hours;

    // ── Hero: greeting & date ──
    const userName = settings.username || '';
    const greetEl = el('greeting-text');
    if (greetEl) greetEl.textContent = `${getGreeting()} ${userName ? userName + ' ' : ''}👋`;
    const subEl = el('dashboard-subtitle');
    if (subEl) subEl.textContent = formatDate(new Date());
    const topbarDate = el('topbar-date');
    if (topbarDate) topbarDate.textContent = formatDate(new Date());

    // ── Cycle label in hero ──
    const cycleStartDate = new Date(diarioYear, diarioMonth, 15);
    const cycleEndDate   = new Date(diarioYear, diarioMonth + 1, 14);
    const fmt = d => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    const cycleLabelEl = el('db-cycle-label');
    if (cycleLabelEl) cycleLabelEl.textContent = `Ciclo: ${fmt(cycleStartDate)} – ${fmt(cycleEndDate)}`;

    // ── Progress ring ──
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const ringEl = el('db-ring-fg');
    if (ringEl) {
      const circumference = 2 * Math.PI * 34; // 213.6
      ringEl.style.strokeDashoffset = circumference - (pct / 100) * circumference;
    }
    const pctEl = el('db-ring-pct');
    if (pctEl) pctEl.textContent = pct + '%';

    // ── Habits checklist (today's activities as interactive habit items) ──
    const habitsList = el('db-habits-list');
    if (habitsList) {
      const sorted = [...todayActs].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      if (sorted.length === 0) {
        habitsList.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);padding:8px 0;">No hay actividades para hoy.</p>`;
      } else {
        habitsList.innerHTML = sorted.map(a => {
          const dot = (a.tags && a.tags[0]) ? '' : '';
          const tagColor = a.tags && a.tags[0] ? getCategoryColor(a.tags[0]) : '#9CA3AF';
          const timeStr = a.startTime ? (a.endTime ? `${a.startTime} – ${a.endTime}` : a.startTime) : '';
          return `<div class="db-habit-item ${a.completed ? 'done' : ''}" data-habit-toggle="${a.id}">
            <div class="db-habit-check"></div>
            <span class="db-habit-dot" style="background:${tagColor}"></span>
            <span class="db-habit-label">${escHTML(a.title)}</span>
            ${timeStr ? `<span class="db-habit-time">${timeStr}</span>` : ''}
          </div>`;
        }).join('');
        habitsList.querySelectorAll('[data-habit-toggle]').forEach(item => {
          item.addEventListener('click', () => toggleActivity(item.dataset.habitToggle));
        });
      }
    }
    const habitsSubEl = el('db-habits-sub');
    if (habitsSubEl) habitsSubEl.textContent = total > 0 ? `${completed}/${total}` : '';

    // ── Diario grid ──
    renderDiarioGrid();

    // ── Today's schedule timeline ──
    const timeline = el('timeline-today');
    if (!timeline) return;
    if (todayActs.length === 0) {
      timeline.innerHTML = '';
      timeline.appendChild(createEmptyState());
      return;
    }
    const sortedFull = [...todayActs].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    timeline.innerHTML = sortedFull.map(a => createTimelineItem(a)).join('');
    attachTimelineEvents(timeline);
  }

  // Helper: return a colour for a known category tag
  function getCategoryColor(tag) {
    const map = {
      'calistenia': '#3B82F6', 'ejercicio': '#3B82F6',
      'correr':     '#F97316',
      'ai-300':     '#8B5CF6', 'mlops': '#8B5CF6', 'desarrollo': '#8B5CF6',
      'inglés':     '#06B6D4', 'ingles': '#06B6D4',
      'fuyu':       '#EC4899',
      'personal':   '#10B981',
      'estudio':    '#F59E0B', 'proyectos': '#F59E0B',
    };
    return map[tag.toLowerCase()] || '#9CA3AF';
  }


  // ── Diario Grid state (15th of current month to 14th of next month) ──
  const initialDate = new Date();
  if (initialDate.getDate() < 15) {
    initialDate.setMonth(initialDate.getMonth() - 1);
  }
  let diarioYear  = initialDate.getFullYear();
  let diarioMonth = initialDate.getMonth(); // 0-indexed

  function getDiarioCycleDates(year, month) {
    const dates = [];
    const start = new Date(year, month, 15);
    const end = new Date(year, month + 1, 14);
    let curr = new Date(start);
    while (curr <= end) {
      dates.push(new Date(curr));
      curr.setDate(curr.getDate() + 1);
    }
    return dates;
  }

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

  // ── Diario Grid Rendering (15th to 14th) ──
  function renderDiarioGrid() {
    const table = $('#diario-table');
    const monthLabel = $('#diario-month-label');
    if (!table) return;

    const cycleDates = getDiarioCycleDates(diarioYear, diarioMonth);

    if (monthLabel) {
      const nextMonth = (diarioMonth + 1) % 12;
      const displayNextMonthName = MONTHS_ES[nextMonth].substring(0, 3);
      const displayCurrentMonthName = MONTHS_ES[diarioMonth].substring(0, 3);
      monthLabel.textContent = `15 ${displayCurrentMonthName} - 14 ${displayNextMonthName} ${diarioYear}`;
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
    html += `<th class="act-label" style="background:var(--bg-secondary); border-bottom: 2px solid var(--border-medium);"></th>`;
    cycleDates.forEach(dateObj => {
      const dateStr = toDateStr(dateObj);
      const d = dateObj.getDate();
      const isToday = dateStr === todayStr();
      html += `<th class="day-head${isToday ? ' is-today' : ''}" data-date="${dateStr}" style="border-bottom: 2px solid var(--border-medium);">${d}</th>`;
    });
    html += '</tr></thead><tbody>';

    diarioRows.forEach(row => {
      html += `<tr>`;
      // Label cell
      html += `<td class="act-label" style="background:${row.color || '#5B6FA0'};color:#fff;" title="${escHTML(row.label)}">${escHTML(row.label)}</td>`;

      cycleDates.forEach(dateObj => {
        const dateStr = toDateStr(dateObj);
        const d = dateObj.getDate();
        const m = dateObj.getMonth() + 1;
        const isFuture = dateStr > todayStr();
        const isToday  = dateStr === todayStr();
        const done = isDone(dateStr, row.keys);
        const missed = isRowMissed(dateStr, row.keys);
        const has  = hasAct(dateStr, row.keys);

        let cls = 'act-cell';
        if (done)     cls += ' done';
        else if (missed) cls += ' missed';
        if (isFuture) cls += ' is-future';
        if (isToday)  cls += ' is-today-col';

        const tooltip = `${row.label} – ${d}/${m}: ${done ? '✅ completado' : missed ? '✕ no realizado' : has ? '⬜ pendiente' : '—'}`;
        html += `<td class="${cls}" data-date="${escHTML(dateStr)}" data-row="${escHTML(row.label)}" title="${escHTML(tooltip)}"></td>`;
      });
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
    const todayActs = (typeof SyncCore !== 'undefined' && SyncCore.getActiveDashboardActivities)
      ? SyncCore.getActiveDashboardActivities(activities, today)
      : activities.filter(a => a && !a.deleted_at && a.date === today);
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
    act.updated_at = new Date().toISOString();
    act.base_version = act.version || 1;
    act.version = (act.version || 1) + 1;
    saveActivities(activities);
    enqueueChange(act);
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

    // Filter to selected date (excluding tombstones)
    let filtered = (typeof SyncCore !== 'undefined' && SyncCore.getActiveDashboardActivities)
      ? SyncCore.getActiveDashboardActivities(activities, activitiesSelectedDate)
      : activities.filter(a => a && !a.deleted_at && a.date === activitiesSelectedDate);
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
      const hasActs = (typeof SyncCore !== 'undefined' && SyncCore.getCalendarDayActivities)
        ? SyncCore.getCalendarDayActivities(activities, dateStr).length > 0
        : activities.some(a => a && !a.deleted_at && a.date === dateStr);
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
    const dayActs = (typeof SyncCore !== 'undefined' && SyncCore.getCalendarDayActivities)
      ? SyncCore.getCalendarDayActivities(activities, calSelectedDate)
      : activities.filter(a => a && !a.deleted_at && a.date === calSelectedDate);
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
    const priorityStats = (typeof SyncCore !== 'undefined' && SyncCore.getPriorityStats)
      ? SyncCore.getPriorityStats(activities)
      : (() => {
          const c = { high: 0, medium: 0, low: 0 };
          (activities || []).filter(a => a && !a.deleted_at).forEach(a => { if (c[a.priority] !== undefined) c[a.priority]++; });
          return { ...c, total: (activities || []).filter(a => a && !a.deleted_at).length };
        })();
    const total = Math.max(priorityStats.total, 1);
    const data = [
      { key: 'high', label: 'Alta', color: 'var(--priority-high)', count: priorityStats.high },
      { key: 'medium', label: 'Media', color: 'var(--priority-medium)', count: priorityStats.medium },
      { key: 'low', label: 'Baja', color: 'var(--priority-low)', count: priorityStats.low },
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

    const nowIso = new Date().toISOString();
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
      updated_at: nowIso,
      version: 1
    };

    if (editingId) {
      const idx = activities.findIndex(a => a.id === editingId);
      if (idx !== -1) {
        data.completed = activities[idx].completed;
        data.base_version = activities[idx].version || 1;
        data.version = (activities[idx].version || 1) + 1;
        activities[idx] = data;
      }
      enqueueChange(data);
      showToast('Actividad actualizada');
    } else {
      activities.push(data);
      enqueueChange(data);
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
    const target = activities.find(a => a.id === deletingId);
    if (target) {
      const tombstone = {
        ...target,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        base_version: target.version || 1,
        version: (target.version || 1) + 1
      };
      enqueueChange(tombstone);
    }
    activities = activities.filter(a => a.id !== deletingId);
    saveActivities(activities);
    closeDeleteModal();
    renderDashboard();
    renderActivityList();
    renderCalendar();
    scheduleWebAlarms();
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
    const results = (typeof SyncCore !== 'undefined' && SyncCore.searchActivities)
      ? SyncCore.searchActivities(activities, q)
      : activities.filter(a =>
          a && !a.deleted_at && (
            a.title.toLowerCase().includes(q) ||
            (a.description || '').toLowerCase().includes(q) ||
            (a.tags || []).some(t => t.toLowerCase().includes(q))
          )
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
    const todayActivities = (typeof SyncCore !== 'undefined' && SyncCore.getAlarmEligibleActivities)
      ? SyncCore.getAlarmEligibleActivities(activities, todayStr()).filter(a => a.startTime && a.alarm !== false)
      : activities.filter(a => a && !a.deleted_at && a.date === todayStr() && !a.completed && a.startTime && a.alarm !== false);

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

    const bkUrl = $('#setting-backend-url'), bkTok = $('#setting-backend-token');
    if (bkUrl) bkUrl.value = settings.backendUrl || '';
    if (bkTok) bkTok.value = settings.backendToken || '';

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
        const bu = $('#setting-backend-url'), bt = $('#setting-backend-token');
        if (bu) settings.backendUrl = bu.value.trim();
        if (bt) settings.backendToken = bt.value.trim();
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
        let exportObj;
        if (typeof SyncCore !== 'undefined' && SyncCore.exportAllCollections) {
          exportObj = SyncCore.exportAllCollections({
            activities,
            subjects,
            topics,
            focus_sessions: focusSessions,
            learning_notes: learningNotes
          });
        } else {
          exportObj = activities;
        }
        const data = JSON.stringify(exportObj, null, 2);
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
    function savePreImportSnapshot(currentStores) {
      try {
        const keys = Object.keys(localStorage).filter(k => k.startsWith('diary_backup_pre_import_')).sort();
        while (keys.length >= 2) {
          const oldest = keys.shift();
          localStorage.removeItem(oldest);
        }
        const jsonPayload = JSON.stringify(currentStores, null, 2);
        try {
          localStorage.setItem('diary_backup_pre_import_' + Date.now(), jsonPayload);
        } catch (setErr) {
          if (setErr.name === 'QuotaExceededError' || setErr.code === 22) {
            // Si hay un snapshot anterior, purgarlo para garantizar espacio al nuevo
            if (keys.length > 0) {
              localStorage.removeItem(keys.shift());
              localStorage.setItem('diary_backup_pre_import_' + Date.now(), jsonPayload);
            } else {
              showToast('Almacenamiento local lleno: no se pudo guardar el snapshot pre-importación', 'warning', 'var(--accent-amber)');
            }
          } else {
            throw setErr;
          }
        }
      } catch (err) {
        if (err.name === 'QuotaExceededError' || err.code === 22) {
          showToast('Almacenamiento local lleno: no se pudo guardar el snapshot pre-importación', 'warning', 'var(--accent-amber)');
        } else {
          console.warn('Error guardando snapshot pre-import:', err);
        }
      }
    }

    const importFile = $('#import-file');
    if (importFile) {
      importFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            // 1. Validar minuciosamente estructura, tipos y campos
            let val;
            if (typeof SyncCore !== 'undefined' && SyncCore.validateMultiCollectionImportPayload) {
              val = SyncCore.validateMultiCollectionImportPayload(ev.target.result);
            } else if (typeof SyncCore !== 'undefined' && SyncCore.validateImportPayload) {
              const actRes = SyncCore.validateImportPayload(ev.target.result);
              val = actRes.valid ? {
                valid: true,
                schema_version: 1,
                sanitized: { activities: actRes.sanitized, subjects: [], topics: [], focus_sessions: [], learning_notes: [] }
              } : actRes;
            } else {
              const parsed = JSON.parse(ev.target.result);
              val = { valid: true, sanitized: Array.isArray(parsed) ? { activities: parsed, subjects: [], topics: [], focus_sessions: [], learning_notes: [] } : parsed };
            }

            if (!val.valid) {
              showToast(val.error || 'Archivo inválido', 'error', 'var(--accent-red)');
              return;
            }

            const totalItems = Object.values(val.sanitized).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
            const proceed = confirm(
              `¿Deseas restaurar ${totalItems} elementos de datos?\nSe creará un respaldo automático de tu agenda actual antes de importar.`
            );
            if (!proceed) {
              importFile.value = '';
              return;
            }

            // 2. Respaldo automático conservando máx 2 snapshots
            savePreImportSnapshot({ activities, subjects, topics, focusSessions, learningNotes });

            // 3. Preparar cambios no destructivos con SyncCore
            if (typeof SyncCore !== 'undefined' && SyncCore.prepareMultiCollectionImportChanges) {
              const currentStores = {
                activities,
                subjects,
                topics,
                focus_sessions: focusSessions,
                learning_notes: learningNotes
              };
              const { mergedCollections, changesToEnqueue, stats } = SyncCore.prepareMultiCollectionImportChanges(
                val.sanitized,
                currentStores,
                generateUUID
              );

              if (mergedCollections.activities) saveActivities(mergedCollections.activities);
              if (mergedCollections.subjects) saveSubjects(mergedCollections.subjects);
              if (mergedCollections.topics) saveTopics(mergedCollections.topics);
              if (mergedCollections.focus_sessions) saveFocusSessions(mergedCollections.focus_sessions);
              if (mergedCollections.learning_notes) saveLearningNotes(mergedCollections.learning_notes);

              changesToEnqueue.forEach(ch => enqueueChange(ch));

              renderDashboard();
              renderActivityList();
              renderCalendar();
              renderDiarioGrid();
              scheduleWebAlarms();

              const msg = `Importación: ${stats.imported} importados${stats.skipped ? `, ${stats.skipped} omitidos` : ''}${stats.conflicted ? `, ${stats.conflicted} no degradados` : ''} ✓`;
              showToast(msg);
            } else {
              if (val.sanitized.activities) {
                activities = val.sanitized.activities;
                saveActivities(activities);
                activities.forEach(ch => enqueueChange(ch));
              }
              renderDashboard();
              renderActivityList();
              renderCalendar();
              renderDiarioGrid();
              scheduleWebAlarms();
              showToast(`${totalItems} elementos importados ✓`);
            }

            // 4. Sincronizar en segundo plano
            syncWithBackend();
          } catch (err) {
            console.error('Error al importar:', err);
            showToast('Error al procesar archivo JSON', 'error', 'var(--accent-red)');
          } finally {
            importFile.value = '';
          }
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

  // ── HTML Escaping (XSS Prevention) ──
  function escHTML(str) {
    if (typeof window !== 'undefined' && window.SyncCore && typeof window.SyncCore.escHTML === 'function') {
      return window.SyncCore.escHTML(str);
    }
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Study View Logic (Materias, Temas y Métricas - Fase B) ──
  let showArchivedSubjects = false;
  let selectedSubjectIdForDetail = null;

  function renderStudyView() {
    subjects = loadSubjects();
    topics = loadTopics();
    focusSessions = loadFocusSessions();
    learningNotes = loadLearningNotes();

    const activeSubjects = subjects.filter(s => s && !s.deleted_at);
    const visibleSubjects = activeSubjects.filter(s => showArchivedSubjects ? true : !s.archived);

    // Stats calculations
    const activeNonArchivedCount = activeSubjects.filter(s => !s.archived).length;
    let totalStudySeconds = 0;
    focusSessions.forEach(f => {
      if (f && !f.deleted_at) {
        totalStudySeconds += Number(f.effective_seconds) || 0;
      }
    });
    const totalHours = (totalStudySeconds / 3600).toFixed(1) + 'h';

    let totalWeeklyGoalMinutes = 0;
    activeSubjects.filter(s => !s.archived).forEach(s => {
      totalWeeklyGoalMinutes += Number(s.weekly_goal_minutes) || 0;
    });
    const totalGoalHours = (totalWeeklyGoalMinutes / 60).toFixed(1) + 'h';

    const statCountEl = $('#study-stat-active-count');
    if (statCountEl) statCountEl.textContent = activeNonArchivedCount;
    const statHoursEl = $('#study-stat-total-hours');
    if (statHoursEl) statHoursEl.textContent = totalHours;
    const statGoalEl = $('#study-stat-weekly-goal');
    if (statGoalEl) statGoalEl.textContent = totalGoalHours;

    const grid = $('#subjects-grid');
    if (!grid) return;

    if (visibleSubjects.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px 20px; background: var(--bg-card); border-radius: var(--radius-md); border: 1px dashed var(--border-medium);">
          <span class="material-icons-round" style="font-size: 48px; color: var(--text-muted); margin-bottom: 12px;">school</span>
          <h3 style="font-size: 1.1rem; color: var(--text-primary); margin-bottom: 6px;">No tienes materias ${showArchivedSubjects ? '' : 'activas'}</h3>
          <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 20px; max-width: 400px; margin-left: auto; margin-right: auto;">
            Crea tu primera materia o usa las sugerencias preconfiguradas para empezar a organizar tu estudio.
          </p>
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <button class="btn-outline btn-touch-target" id="btn-empty-seed" style="gap: 6px; padding: 0 14px;">
              <span class="material-icons-round">auto_awesome</span>
              <span>Cargar sugeridas</span>
            </button>
            <button class="btn-primary btn-touch-target" id="btn-empty-add" style="gap: 6px; padding: 0 16px;">
              <span class="material-icons-round">add</span>
              <span>Crear Materia</span>
            </button>
          </div>
        </div>
      `;
      $('#btn-empty-seed')?.addEventListener('click', handleSeedSubjects);
      $('#btn-empty-add')?.addEventListener('click', () => openSubjectModal());
      return;
    }

    grid.innerHTML = visibleSubjects.map(sub => {
      const summary = (typeof FocusCore !== 'undefined' && FocusCore.summarizeSubject)
        ? FocusCore.summarizeSubject(sub, topics, focusSessions)
        : {
            total_hours: 0,
            weekly_goal_minutes: sub.weekly_goal_minutes || 0,
            goal_progress_percent: 0,
            session_count: 0,
            topic_count: topics.filter(t => t.subject_id === sub.id && !t.deleted_at).length
          };

      const color = sub.color || '#3B82F6';
      const isArchived = !!sub.archived;
      const weeklyGoalHours = ((sub.weekly_goal_minutes || 0) / 60).toFixed(1);

      return `
        <div class="subject-card ${isArchived ? 'is-archived' : ''}" data-id="${escHTML(sub.id)}" style="border-top: 4px solid ${escHTML(color)};">
          <div class="subject-card-header">
            <div class="subject-card-title-wrap">
              <div class="subject-card-icon" style="background: ${escHTML(color)};">
                <span class="material-icons-round">${escHTML(sub.icon || 'school')}</span>
              </div>
              <div>
                <h4 class="subject-card-title">${escHTML(sub.name || 'Sin título')}</h4>
                ${isArchived ? '<span style="font-size: 0.7rem; color: var(--accent-amber); font-weight: 600;">(Archivada)</span>' : ''}
              </div>
            </div>
          </div>

          <div class="subject-card-metrics">
            <div>
              <div class="subject-metric-label">Tiempo estudiado</div>
              <div class="subject-metric-value">${summary.total_hours}h</div>
            </div>
            <div>
              <div class="subject-metric-label">Temas / Sesiones</div>
              <div class="subject-metric-value">${summary.topic_count} / ${summary.session_count}</div>
            </div>
          </div>

          ${sub.weekly_goal_minutes > 0 ? `
            <div class="subject-progress-wrap">
              <div class="subject-progress-header">
                <span>Meta semanal (${weeklyGoalHours}h)</span>
                <span>${summary.goal_progress_percent}%</span>
              </div>
              <div class="subject-progress-bar">
                <div class="subject-progress-fill" style="width: ${summary.goal_progress_percent}%; background: ${escHTML(color)};"></div>
              </div>
            </div>
          ` : ''}

          <div class="subject-card-actions">
            <button class="btn-outline btn-touch-target" data-action="detail" data-id="${escHTML(sub.id)}" style="gap: 4px; padding: 0 12px; font-size: 0.85rem;">
              <span class="material-icons-round" style="font-size: 18px;">list_alt</span>
              <span>Temas</span>
            </button>
            <div style="display: flex; gap: 4px;">
              <button class="topbar-btn btn-touch-target" data-action="edit" data-id="${escHTML(sub.id)}" title="Editar materia">
                <span class="material-icons-round" style="font-size: 18px;">edit</span>
              </button>
              <button class="topbar-btn btn-touch-target" data-action="delete" data-id="${escHTML(sub.id)}" title="${isArchived ? 'Desarchivar o eliminar' : 'Archivar o eliminar'}" style="color: var(--accent-red);">
                <span class="material-icons-round" style="font-size: 18px;">${isArchived ? 'unarchive' : 'delete'}</span>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach card event listeners
    grid.querySelectorAll('[data-action="detail"]').forEach(btn => {
      btn.addEventListener('click', () => openSubjectDetailModal(btn.dataset.id));
    });
    grid.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => openSubjectModal(btn.dataset.id));
    });
    grid.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => handleDeleteOrArchiveSubject(btn.dataset.id));
    });
  }

  function handleSeedSubjects() {
    subjects = loadSubjects();
    topics = loadTopics();

    const plan = (typeof FocusCore !== 'undefined' && FocusCore.planSeedCreation)
      ? FocusCore.planSeedCreation(subjects, topics)
      : { subjects: [], topics: [] };

    plan.subjects.forEach(seedSub => {
      const existsIdx = subjects.findIndex(s => s.id === seedSub.id);
      if (existsIdx === -1) {
        subjects.push(seedSub);
      }
      enqueueChange({ ...seedSub, collection: 'subjects' });
    });

    plan.topics.forEach(seedTopic => {
      const existsIdx = topics.findIndex(t => t.id === seedTopic.id);
      if (existsIdx === -1) {
        topics.push(seedTopic);
      }
      enqueueChange({ ...seedTopic, collection: 'topics' });
    });

    saveSubjects(subjects);
    saveTopics(topics);
    renderStudyView();
    showToast('✨ Materias sugeridas creadas con éxito', 'check_circle', 'var(--accent-teal)');
    syncWithBackend();
  }

  function openSubjectModal(subjectId = null) {
    const overlay = $('#subject-modal-overlay');
    if (!overlay) return;
    const titleEl = $('#modal-subject-title');
    const idInput = $('#subject-id-input');
    const nameInput = $('#subject-name-input');
    const colorPicker = $('#subject-color-picker');
    const colorInput = $('#subject-color-input');
    const iconInput = $('#subject-icon-input');
    const goalInput = $('#subject-goal-input');
    const errorsDiv = $('#subject-form-errors');

    if (errorsDiv) {
      errorsDiv.textContent = '';
      errorsDiv.style.display = 'none';
    }

    if (subjectId) {
      const sub = subjects.find(s => s.id === subjectId);
      if (sub) {
        if (titleEl) titleEl.textContent = 'Editar Materia';
        if (idInput) idInput.value = sub.id;
        if (nameInput) nameInput.value = sub.name || '';
        if (colorPicker) colorPicker.value = sub.color || '#3B82F6';
        if (colorInput) colorInput.value = sub.color || '#3B82F6';
        if (iconInput) iconInput.value = sub.icon || 'school';
        if (goalInput) goalInput.value = sub.weekly_goal_minutes !== undefined ? sub.weekly_goal_minutes : 180;
      }
    } else {
      if (titleEl) titleEl.textContent = 'Nueva Materia';
      if (idInput) idInput.value = '';
      if (nameInput) nameInput.value = '';
      if (colorPicker) colorPicker.value = '#3B82F6';
      if (colorInput) colorInput.value = '#3B82F6';
      if (iconInput) iconInput.value = 'school';
      if (goalInput) goalInput.value = '180';
    }

    overlay.classList.add('open');
  }

  function closeSubjectModal() {
    const overlay = $('#subject-modal-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function handleSaveSubject() {
    const idInput = $('#subject-id-input');
    const nameInput = $('#subject-name-input');
    const colorInput = $('#subject-color-input');
    const iconInput = $('#subject-icon-input');
    const goalInput = $('#subject-goal-input');
    const errorsDiv = $('#subject-form-errors');

    const subjectId = idInput?.value ? idInput.value : null;
    const name = nameInput ? nameInput.value.trim() : '';
    const color = colorInput ? colorInput.value.trim() : '#3B82F6';
    const icon = iconInput ? iconInput.value : 'school';
    const weeklyGoal = goalInput ? parseInt(goalInput.value, 10) : 0;

    const data = {
      name,
      color,
      icon,
      weekly_goal_minutes: isNaN(weeklyGoal) ? 0 : weeklyGoal
    };

    subjects = loadSubjects();

    if (typeof FocusCore !== 'undefined' && FocusCore.validateSubjectForm) {
      const validation = FocusCore.validateSubjectForm(data, subjects, subjectId);
      if (!validation.valid) {
        if (errorsDiv) {
          errorsDiv.innerHTML = validation.errors.map(e => `<div>• ${escHTML(e)}</div>`).join('');
          errorsDiv.style.display = 'block';
        }
        return;
      }
    }

    const now = new Date().toISOString();

    if (subjectId) {
      const idx = subjects.findIndex(s => s.id === subjectId);
      if (idx !== -1) {
        const existing = subjects[idx];
        const updated = {
          ...existing,
          name: data.name,
          color: data.color,
          icon: data.icon,
          weekly_goal_minutes: data.weekly_goal_minutes,
          updated_at: now,
          base_version: existing.version || 1
        };
        subjects[idx] = updated;
        saveSubjects(subjects);
        enqueueChange({ ...updated, collection: 'subjects' });
        showToast('Materia actualizada ✓');
      }
    } else {
      const newSub = {
        id: uid(),
        name: data.name,
        color: data.color,
        icon: data.icon,
        weekly_goal_minutes: data.weekly_goal_minutes,
        archived: 0,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null
      };
      subjects.push(newSub);
      saveSubjects(subjects);
      enqueueChange({ ...newSub, collection: 'subjects' });
      showToast('Materia creada ✓');
    }

    closeSubjectModal();
    renderStudyView();
    if (selectedSubjectIdForDetail) {
      renderSubjectDetailContent(selectedSubjectIdForDetail);
    }
    syncWithBackend();
  }

  function openSubjectDetailModal(subjectId) {
    selectedSubjectIdForDetail = subjectId;
    const overlay = $('#subject-detail-overlay');
    if (!overlay) return;
    renderSubjectDetailContent(subjectId);
    overlay.classList.add('open');
  }

  function closeSubjectDetailModal() {
    const overlay = $('#subject-detail-overlay');
    if (overlay) overlay.classList.remove('open');
    selectedSubjectIdForDetail = null;
  }

  function renderSubjectDetailContent(subjectId) {
    subjects = loadSubjects();
    topics = loadTopics();
    focusSessions = loadFocusSessions();
    learningNotes = loadLearningNotes();

    const sub = subjects.find(s => s.id === subjectId && !s.deleted_at);
    if (!sub) {
      closeSubjectDetailModal();
      return;
    }

    const titleEl = $('#detail-subject-title');
    const badgeEl = $('#detail-subject-badge');
    const iconEl = $('#detail-subject-icon');
    const iconBoxEl = $('#detail-subject-icon-box');

    if (titleEl) titleEl.textContent = sub.name;
    if (badgeEl) badgeEl.textContent = sub.archived ? 'Archivada' : 'Activa';
    if (iconEl) iconEl.textContent = sub.icon || 'school';
    if (iconBoxEl) iconBoxEl.style.background = sub.color || 'var(--accent-teal)';

    const summary = (typeof FocusCore !== 'undefined' && FocusCore.summarizeSubject)
      ? FocusCore.summarizeSubject(sub, topics, focusSessions)
      : { total_hours: 0, session_count: 0, topic_stats: {} };

    const statHours = $('#detail-stat-hours');
    if (statHours) statHours.textContent = summary.total_hours + 'h';
    const statGoal = $('#detail-stat-goal');
    if (statGoal) statGoal.textContent = ((sub.weekly_goal_minutes || 0) / 60).toFixed(1) + 'h';
    const statSessions = $('#detail-stat-sessions');
    if (statSessions) statSessions.textContent = summary.session_count;

    const childTopics = topics.filter(t => t.subject_id === subjectId && !t.deleted_at);
    const topicsList = $('#detail-topics-list');
    if (topicsList) {
      if (childTopics.length === 0) {
        topicsList.innerHTML = '<p style="font-size:0.85rem; color:var(--text-muted); text-align:center; padding:16px;">No hay temas agregados en esta materia.</p>';
      } else {
        const STATUS_LABELS = {
          pending: 'Pendiente',
          in_progress: 'En progreso',
          mastered: 'Dominado'
        };

        topicsList.innerHTML = childTopics.map(t => {
          const tStat = summary.topic_stats[t.id] || { hours: 0 };
          const status = t.status || 'pending';
          return `
            <div class="topic-item" data-id="${escHTML(t.id)}">
              <div>
                <div style="font-weight:600; font-size:0.9rem; color:var(--text-primary);">${escHTML(t.name)}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">
                  <span>${tStat.hours}h dedicadas</span>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="topic-status-badge ${escHTML(status)}">${STATUS_LABELS[status] || status}</span>
                <button class="topbar-btn btn-touch-target" data-action="edit-topic" data-id="${escHTML(t.id)}" title="Editar tema">
                  <span class="material-icons-round" style="font-size:18px;">edit</span>
                </button>
                <button class="topbar-btn btn-touch-target" data-action="delete-topic" data-id="${escHTML(t.id)}" title="Eliminar tema" style="color:var(--accent-red);">
                  <span class="material-icons-round" style="font-size:18px;">delete</span>
                </button>
              </div>
            </div>
          `;
        }).join('');

        topicsList.querySelectorAll('[data-action="edit-topic"]').forEach(btn => {
          btn.addEventListener('click', () => openTopicModal(subjectId, btn.dataset.id));
        });
        topicsList.querySelectorAll('[data-action="delete-topic"]').forEach(btn => {
          btn.addEventListener('click', () => handleDeleteTopic(btn.dataset.id));
        });
      }
    }
  }

  function openTopicModal(subjectId, topicId = null) {
    const overlay = $('#topic-modal-overlay');
    if (!overlay) return;
    const titleEl = $('#modal-topic-title');
    const idInput = $('#topic-id-input');
    const subIdInput = $('#topic-subject-id-input');
    const nameInput = $('#topic-name-input');
    const statusInput = $('#topic-status-input');
    const errorsDiv = $('#topic-form-errors');

    if (errorsDiv) {
      errorsDiv.textContent = '';
      errorsDiv.style.display = 'none';
    }

    if (subIdInput) subIdInput.value = subjectId;

    if (topicId) {
      const top = topics.find(t => t.id === topicId);
      if (top) {
        if (titleEl) titleEl.textContent = 'Editar Tema';
        if (idInput) idInput.value = top.id;
        if (nameInput) nameInput.value = top.name || '';
        if (statusInput) statusInput.value = top.status || 'pending';
      }
    } else {
      if (titleEl) titleEl.textContent = 'Nuevo Tema';
      if (idInput) idInput.value = '';
      if (nameInput) nameInput.value = '';
      if (statusInput) statusInput.value = 'pending';
    }

    overlay.classList.add('open');
  }

  function closeTopicModal() {
    const overlay = $('#topic-modal-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function handleSaveTopic() {
    const idInput = $('#topic-id-input');
    const subIdInput = $('#topic-subject-id-input');
    const nameInput = $('#topic-name-input');
    const statusInput = $('#topic-status-input');
    const errorsDiv = $('#topic-form-errors');

    const topicId = idInput?.value ? idInput.value : null;
    const subjectId = subIdInput?.value || selectedSubjectIdForDetail;
    const name = nameInput ? nameInput.value.trim() : '';
    const status = statusInput ? statusInput.value : 'pending';

    const data = {
      subject_id: subjectId,
      name,
      status
    };

    topics = loadTopics();

    if (typeof FocusCore !== 'undefined' && FocusCore.validateTopicForm) {
      const validation = FocusCore.validateTopicForm(data, topics, topicId);
      if (!validation.valid) {
        if (errorsDiv) {
          errorsDiv.innerHTML = validation.errors.map(e => `<div>• ${escHTML(e)}</div>`).join('');
          errorsDiv.style.display = 'block';
        }
        return;
      }
    }

    const now = new Date().toISOString();

    if (topicId) {
      const idx = topics.findIndex(t => t.id === topicId);
      if (idx !== -1) {
        const existing = topics[idx];
        const updated = {
          ...existing,
          name: data.name,
          status: data.status,
          updated_at: now,
          base_version: existing.version || 1
        };
        topics[idx] = updated;
        saveTopics(topics);
        enqueueChange({ ...updated, collection: 'topics' });
        showToast('Tema actualizado ✓');
      }
    } else {
      const newTopic = {
        id: uid(),
        subject_id: subjectId,
        name: data.name,
        status: data.status,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null
      };
      topics.push(newTopic);
      saveTopics(topics);
      enqueueChange({ ...newTopic, collection: 'topics' });
      showToast('Tema agregado ✓');
    }

    closeTopicModal();
    if (subjectId) {
      renderSubjectDetailContent(subjectId);
    }
    renderStudyView();
    syncWithBackend();
  }

  function handleDeleteTopic(topicId) {
    topics = loadTopics();
    const idx = topics.findIndex(t => t.id === topicId);
    if (idx === -1) return;

    const existing = topics[idx];
    const now = new Date().toISOString();
    const tombstone = {
      ...existing,
      deleted_at: now,
      updated_at: now,
      base_version: existing.version || 1
    };
    topics[idx] = tombstone;
    saveTopics(topics);
    enqueueChange({ ...tombstone, collection: 'topics' });
    showToast('Tema eliminado ✓');

    if (existing.subject_id) {
      renderSubjectDetailContent(existing.subject_id);
    }
    renderStudyView();
    syncWithBackend();
  }

  function handleDeleteOrArchiveSubject(subjectId) {
    subjects = loadSubjects();
    topics = loadTopics();
    focusSessions = loadFocusSessions();
    learningNotes = loadLearningNotes();

    const sub = subjects.find(s => s.id === subjectId);
    if (!sub) return;

    const childTopics = topics.filter(t => t.subject_id === subjectId && !t.deleted_at);

    if (sub.archived) {
      // Si ya está archivada, desarchivar
      const unarchived = {
        ...sub,
        archived: 0,
        updated_at: new Date().toISOString(),
        base_version: sub.version || 1
      };
      const idx = subjects.findIndex(s => s.id === subjectId);
      if (idx !== -1) subjects[idx] = unarchived;
      saveSubjects(subjects);
      enqueueChange({ ...unarchived, collection: 'subjects' });
      showToast('Materia desarchivada ✓');
      closeSubjectDetailModal();
      renderStudyView();
      syncWithBackend();
      return;
    }

    const decision = (typeof FocusCore !== 'undefined' && FocusCore.decideSubjectRemoval)
      ? FocusCore.decideSubjectRemoval(sub, focusSessions, learningNotes, childTopics)
      : { action: 'delete' };

    const idx = subjects.findIndex(s => s.id === subjectId);
    if (idx === -1) return;

    if (decision.action === 'archive') {
      const updated = {
        ...sub,
        archived: 1,
        updated_at: decision.subjectPatch.updated_at,
        base_version: sub.version || 1
      };
      subjects[idx] = updated;
      saveSubjects(subjects);
      enqueueChange({ ...updated, collection: 'subjects' });
      showToast('Materia archivada (conserva su historial) ✓');
    } else {
      const updated = {
        ...sub,
        deleted_at: decision.subjectPatch.deleted_at,
        updated_at: decision.subjectPatch.updated_at,
        base_version: sub.version || 1
      };
      subjects[idx] = updated;
      saveSubjects(subjects);
      enqueueChange({ ...updated, collection: 'subjects' });

      // Cascading tombstones to child topics
      if (Array.isArray(decision.topicTombstones)) {
        decision.topicTombstones.forEach(tt => {
          const tIdx = topics.findIndex(t => t.id === tt.id);
          if (tIdx !== -1) {
            topics[tIdx] = { ...topics[tIdx], ...tt };
            enqueueChange({ ...topics[tIdx], collection: 'topics' });
          }
        });
        saveTopics(topics);
      }
      showToast('Materia eliminada ✓');
    }

    closeSubjectDetailModal();
    renderStudyView();
    syncWithBackend();
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
  function formatMarkdown(text) {
    if (!text) return '';
    let html = escHTML(text);
    // Tablas básicas en Markdown
    const lines = html.split('\n');
    let inTable = false;
    let tableHtml = '';
    const outputLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('|') && line.endsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (cells.every(c => /^:?-+:?$/.test(c))) {
          // Separador de tabla, saltar
          continue;
        }
        if (!inTable) {
          inTable = true;
          tableHtml = '<div style="overflow-x:auto; margin:6px 0;"><table style="width:100%; border-collapse:collapse; font-size:0.8rem; border:1px solid var(--border-medium);">';
          tableHtml += '<tr style="background:rgba(0,0,0,0.04); font-weight:600;">' + cells.map(c => `<th style="padding:4px 8px; border:1px solid var(--border-subtle); text-align:left;">${c}</th>`).join('') + '</tr>';
        } else {
          tableHtml += '<tr>' + cells.map(c => `<td style="padding:4px 8px; border:1px solid var(--border-subtle);">${c}</td>`).join('') + '</tr>';
        }
      } else {
        if (inTable) {
          tableHtml += '</table></div>';
          outputLines.push(tableHtml);
          inTable = false;
          tableHtml = '';
        }
        outputLines.push(lines[i]);
      }
    }
    if (inTable) {
      tableHtml += '</table></div>';
      outputLines.push(tableHtml);
    }

    html = outputLines.join('\n');
    // Negrita **texto**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Cursiva *texto*
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Código en línea `codigo`
    html = html.replace(/`(.*?)`/g, '<code style="background:rgba(0,0,0,0.06); padding:2px 4px; border-radius:4px; font-family:monospace; font-size:0.82rem;">$1</code>');
    // Listas viñetas
    html = html.replace(/^[ \t]*[-*][ \t]+(.*)$/gm, '<li style="margin-left:16px;">$1</li>');
    // Saltos de línea
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function addAgentMessage(text) {
    const msgs = $('#chat-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'chat-message agent';
    div.innerHTML = formatMarkdown(text);
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
  let groqChatHistory = [];

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

    groqChatHistory.push({ role: 'user', content: userText });
    
    if (groqChatHistory.length > 6) {
      groqChatHistory = groqChatHistory.slice(-6);
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...groqChatHistory
    ];

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: messages,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });

      removeTypingIndicator();

      if (!response.ok) {
        const errText = await response.text();
        console.error('Groq Error:', errText);
        let detail = '';
        try { detail = JSON.parse(errText).error.message; } catch (e) { detail = errText.slice(0, 200); }
        const hint = response.status === 401
          ? 'La API Key no es válida.'
          : response.status === 429
            ? 'Límite de uso alcanzado, intenta en un momento.'
            : response.status === 404 || response.status === 400
              ? 'Modelo no disponible o petición inválida.'
              : 'Error del servicio.';
        addAgentMessage(`⚠️ Groq (${response.status}): ${hint}\n${detail}`);
        return;
      }

      const resData = await response.json();
      const content = resData.choices[0].message.content;
      const parsed = JSON.parse(content);
      
      groqChatHistory.push({ role: 'assistant', content: content });

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

  // ── Backend LangGraph agent ──
  function getBackendBaseUrl() {
    settings = loadSettings();
    if (settings.backendUrl) return settings.backendUrl.replace(/\/+$/, '');
    if (window.location.protocol.startsWith('http') && (window.location.port === '8000' || window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')) {
      return window.location.origin;
    }
    return 'http://127.0.0.1:8000';
  }

  function backendHeaders() {
    settings = loadSettings();
    const h = { 'Content-Type': 'application/json' };
    if (settings.backendToken) h['X-App-Token'] = settings.backendToken;
    return h;
  }

  async function backendPost(path, body) {
    const base = getBackendBaseUrl();
    const res = await fetch(base + path, { method: 'POST', headers: backendHeaders(), body: JSON.stringify(body) });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail; } catch (e) { detail = await res.text(); }
      throw new Error(`(${res.status}) ${detail}`);
    }
    return res.json();
  }

  const COLLECTION_LABELS = {
    activities: 'Actividad',
    subjects: 'Materia',
    topics: 'Tema',
    focus_sessions: 'Sesión de Enfoque',
    learning_notes: 'Nota de Aprendizaje'
  };

  async function syncWithBackend() {
    activities = loadActivities();
    subjects = loadSubjects();
    topics = loadTopics();
    focusSessions = loadFocusSessions();
    learningNotes = loadLearningNotes();

    const base = getBackendBaseUrl();
    let queue = getSyncQueue();
    if (typeof SyncCore !== 'undefined' && SyncCore.migrateLegacyQueue) {
      queue = SyncCore.migrateLegacyQueue(queue);
      saveSyncQueue(queue);
    }
    const lastSync = getLastSync();

    const collectionsPayload = {
      activities: queue.filter(q => !q.collection || q.collection === 'activities'),
      subjects: queue.filter(q => q.collection === 'subjects'),
      topics: queue.filter(q => q.collection === 'topics'),
      focus_sessions: queue.filter(q => q.collection === 'focus_sessions'),
      learning_notes: queue.filter(q => q.collection === 'learning_notes')
    };

    try {
      const res = await fetch(base + '/sync', {
        method: 'POST',
        headers: backendHeaders(),
        body: JSON.stringify({ collections: collectionsPayload, since: lastSync })
      });
      if (!res.ok) return false;
      const data = await res.json();

      let remainingQueue = (typeof SyncCore !== 'undefined' && SyncCore.purgeCommittedAndConflicted)
        ? SyncCore.purgeCommittedAndConflicted(queue, queue)
        : [];
      saveSyncQueue(remainingQueue);

      const results = data.results || {};
      let allConflicts = [];
      let allRejected = [];
      let allUnknown = [];

      Object.entries(results).forEach(([colName, colRes]) => {
        if (Array.isArray(colRes.conflicts)) {
          colRes.conflicts.forEach(c => allConflicts.push({ ...c, collection: colName }));
        }
        if (Array.isArray(colRes.rejected)) {
          allRejected.push(...colRes.rejected);
        }
        if (Array.isArray(colRes.unknown_fields)) {
          allUnknown.push(...colRes.unknown_fields);
        }
      });

      // Manejo de ítems rechazados por validación del servidor
      if (allRejected.length > 0) {
        let rejectedStore = getRejectedStore();
        if (typeof SyncCore !== 'undefined' && SyncCore.handleRejectedItems) {
          const resRej = SyncCore.handleRejectedItems(rejectedStore, queue, allRejected);
          saveRejectedStore(resRej.rejectedStore);
          remainingQueue = resRej.queue;
          saveSyncQueue(remainingQueue);
        }
        showToast(`⚠️ ${allRejected.length} elemento(s) rechazado(s) por validación.`, 'warning', 'var(--accent-amber)');
      }

      // Manejo de campos desconocidos reportados
      if (allUnknown.length > 0) {
        console.warn('[SyncCore] Campos desconocidos reportados por el servidor:', allUnknown);
      }

      // Manejo de conflictos sin pérdida silenciosa
      if (allConflicts.length > 0) {
        let conflictsStore = getConflictsStore();
        if (typeof SyncCore !== 'undefined' && SyncCore.handleSyncConflicts) {
          const resConf = SyncCore.handleSyncConflicts(conflictsStore, queue, allConflicts);
          saveConflictsStore(resConf.conflictsStore);
        }
        const first = allConflicts[0];
        const label = COLLECTION_LABELS[first.collection] || 'elemento';
        showToast(`⚠️ Conflicto en ${label}: el servidor tiene una versión más nueva (v${first.server_version}).`, 'warning', 'var(--accent-amber)');
      }

      if (data.server_time) {
        setLastSync(data.server_time);
      }

      // Mezclar cambios remotos usando SyncCore para cada colección
      const mergeCol = (localList, colName, saveFn) => {
        const colRes = results[colName];
        if (!colRes || !Array.isArray(colRes.changes)) return;
        if (typeof SyncCore !== 'undefined' && SyncCore.mergeCollectionChanges) {
          const { activities: merged, modified } = SyncCore.mergeCollectionChanges(localList, colRes.changes, {
            resyncRequired: Boolean(data.resync_required || colRes.resync_required),
            pendingQueue: remainingQueue.filter(q => q.collection === colName)
          });
          if (modified) saveFn(merged);
        }
      };

      mergeCol(activities, 'activities', (m) => {
        activities = m;
        saveActivities(activities);
        renderDashboard();
        renderActivityList();
        renderCalendar();
        renderDiarioGrid();
        scheduleWebAlarms();
      });
      mergeCol(subjects, 'subjects', (m) => {
        subjects = m;
        saveSubjects(subjects);
        if ($('#view-study')?.classList.contains('active')) renderStudyView();
        if (selectedSubjectIdForDetail) renderSubjectDetailContent(selectedSubjectIdForDetail);
      });
      mergeCol(topics, 'topics', (m) => {
        topics = m;
        saveTopics(topics);
        if ($('#view-study')?.classList.contains('active')) renderStudyView();
        if (selectedSubjectIdForDetail) renderSubjectDetailContent(selectedSubjectIdForDetail);
      });
      mergeCol(focusSessions, 'focus_sessions', (m) => {
        focusSessions = m;
        saveFocusSessions(focusSessions);
        if ($('#view-study')?.classList.contains('active')) renderStudyView();
        if (selectedSubjectIdForDetail) renderSubjectDetailContent(selectedSubjectIdForDetail);
      });
      mergeCol(learningNotes, 'learning_notes', (m) => {
        learningNotes = m;
        saveLearningNotes(learningNotes);
      });

      return true;
    } catch (err) {
      console.warn('Sync backend en espera:', err);
      return false;
    } finally {
      updateConflictsBadge();
    }
  }

  // ── Conflicts Resolution UI ──
  function updateConflictsBadge() {
    const store = getConflictsStore();
    const count = Object.keys(store).length;
    const btn = $('#btn-conflicts');
    const badge = $('#conflicts-badge');
    if (!btn) return;
    if (count > 0) {
      btn.style.display = 'inline-flex';
      if (badge) badge.textContent = count;
    } else {
      btn.style.display = 'none';
      const overlay = $('#conflicts-overlay');
      if (overlay) overlay.classList.remove('open');
    }
  }

  function openConflictsModal() {
    const overlay = $('#conflicts-overlay');
    if (!overlay) return;
    renderConflictsList();
    overlay.classList.add('open');
  }

  function closeConflictsModal() {
    const overlay = $('#conflicts-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function renderConflictsList() {
    const container = $('#conflicts-list');
    if (!container) return;
    const store = getConflictsStore();
    const ids = Object.keys(store);

    if (ids.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:15px;">No hay conflictos pendientes ✓</p>';
      return;
    }

    container.innerHTML = ids.map(id => {
      const conf = store[id];
      const local = conf.localChange || {};
      const server = conf.serverItem || {};
      const collection = conf.collection || local.collection || 'activities';
      const colLabel = COLLECTION_LABELS[collection] || 'Elemento';
      const title = local.title || local.name || local.goal || (local.learned_text ? local.learned_text.substring(0, 30) + '...' : '') || server.title || server.name || id;
      const subtitle = local.date || local.started_at || '';

      return `
        <div class="conflict-card" style="border:1px solid var(--border-medium); border-radius:var(--radius-md); padding:12px; background:var(--bg-card); margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
            <div>
              <span style="font-size:0.75rem; background:rgba(91,111,160,0.15); color:var(--accent-teal); padding:1px 6px; border-radius:4px; font-weight:600; margin-bottom:4px; display:inline-block;">
                ${colLabel}
              </span>
              <div style="font-weight:600; font-size:0.95rem; color:var(--text-primary);">${escHTML(title)}</div>
              ${subtitle ? `<div style="font-size:0.8rem; color:var(--text-muted);">${subtitle}</div>` : ''}
            </div>
            <span style="font-size:0.75rem; background:rgba(255,171,0,0.15); color:var(--accent-amber); padding:2px 8px; border-radius:12px; font-weight:600;">
              Servidor v${conf.serverVersion || 2}
            </span>
          </div>
          <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:12px;">
            Tu cambio local: <em>"${escHTML(title)}"</em>
          </p>
          <div style="display:flex; gap:8px;">
            <button class="btn-secondary" style="flex:1; padding:6px 10px; font-size:0.8rem;" data-resolve="discard" data-id="${id}">
              Usar la del servidor
            </button>
            <button class="btn-primary" style="flex:1; padding:6px 10px; font-size:0.8rem;" data-resolve="rebase" data-id="${id}" data-version="${conf.serverVersion || 2}">
              Re-aplicar la mía
            </button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-resolve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.resolve;
        const id = btn.dataset.id;
        const currentStore = getConflictsStore();

        if (action === 'discard') {
          if (typeof SyncCore !== 'undefined' && SyncCore.discardConflictChange) {
            const res = SyncCore.discardConflictChange(currentStore, id, { generateUUIDFn: generateUUID });
            saveConflictsStore(res.conflictsStore);
            if (res.preservedNote) {
              learningNotes = loadLearningNotes();
              learningNotes.push(res.preservedNote);
              saveLearningNotes(learningNotes);
              enqueueChange({ ...res.preservedNote, collection: 'learning_notes' });
              showToast('Nota preservada como copia local y versión del servidor adoptada ✓');
            } else {
              showToast('Versión del servidor adoptada ✓');
            }
          } else {
            delete currentStore[id];
            saveConflictsStore(currentStore);
            showToast('Versión del servidor adoptada ✓');
          }
          renderConflictsList();
          await syncWithBackend();
        } else if (action === 'rebase') {
          const version = parseInt(btn.dataset.version || '2', 10);
          const queue = getSyncQueue();
          if (typeof SyncCore !== 'undefined' && SyncCore.rebaseConflictChange) {
            const res = SyncCore.rebaseConflictChange(currentStore, queue, id, version);
            saveConflictsStore(res.conflictsStore);
            saveSyncQueue(res.queue);
          }
          showToast('Re-aplicando cambio sobre la versión del servidor...');
          renderConflictsList();
          await syncWithBackend();
        }
      });
    });
  }

  function addConfirmPrompt(pending, onDecision) {
    const msgs = $('#chat-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'chat-message agent';
    div.style.background = 'rgba(255, 171, 0, 0.08)';
    div.style.border = '1px solid rgba(255, 171, 0, 0.3)';

    const actionsList = (pending.actions || []).map(a => {
      if (a.tool === 'delete_activity') {
        const actId = a.args?.activity_id;
        const act = activities.find(x => x.id === actId);
        const title = act ? `<strong>${escHTML(act.title)}</strong> (${act.date})` : `ID <code>${actId}</code>`;
        return `🗑️ Eliminar: ${title}`;
      }
      return `⚙️ <strong>${escHTML(a.tool)}</strong>: <code>${escHTML(JSON.stringify(a.args))}</code>`;
    }).join('<br>');

    div.innerHTML = `
      <div style="font-weight:600; color:var(--accent-amber); margin-bottom:6px; display:flex; align-items:center; gap:6px;">
        <span class="material-icons-round" style="font-size:18px;">warning_amber</span>
        Confirmación requerida
      </div>
      <div style="font-size:0.84rem; margin-bottom:10px; line-height:1.4;">
        El asistente solicita ejecutar la siguiente acción:
        <div style="margin-top:6px; padding:8px; background:rgba(0,0,0,0.04); border-radius:6px; font-size:0.8rem;">
          ${actionsList}
        </div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn-confirm-yes" style="flex:1; padding:7px 12px; background:var(--accent-teal); color:#0D0D0F; border:none; border-radius:6px; font-weight:600; cursor:pointer; font-size:0.8rem; display:flex; align-items:center; justify-content:center; gap:4px;">
          <span class="material-icons-round" style="font-size:16px;">check</span> Confirmar
        </button>
        <button class="btn-confirm-no" style="flex:1; padding:7px 12px; background:rgba(255,82,82,0.12); color:var(--accent-red); border:1px solid rgba(255,82,82,0.3); border-radius:6px; font-weight:600; cursor:pointer; font-size:0.8rem; display:flex; align-items:center; justify-content:center; gap:4px;">
          <span class="material-icons-round" style="font-size:16px;">close</span> Cancelar
        </button>
      </div>
    `;

    const btnYes = div.querySelector('.btn-confirm-yes');
    const btnNo = div.querySelector('.btn-confirm-no');

    const handleDecision = (approved) => {
      btnYes.disabled = true;
      btnNo.disabled = true;
      btnYes.style.opacity = '0.5';
      btnNo.style.opacity = '0.5';
      div.insertAdjacentHTML('beforeend', `<div style="margin-top:8px; font-size:0.75rem; color:${approved ? 'var(--accent-teal)' : 'var(--accent-red)'}; font-weight:600;">${approved ? '✓ Acción confirmada' : '✕ Acción cancelada'}</div>`);
      onDecision(approved);
    };

    btnYes.addEventListener('click', () => handleDecision(true));
    btnNo.addEventListener('click', () => handleDecision(false));

    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function handleBackendResult(data) {
    if (data.reply) addAgentMessage(data.reply);
    if (data.pending) {
      addConfirmPrompt(data.pending, async (approved) => {
        addTypingIndicator();
        try {
          const next = await backendPost('/agent/confirm', { thread_id: 'web', approved });
          removeTypingIndicator();
          await handleBackendResult(next);
          await syncWithBackend();
        } catch (e) {
          removeTypingIndicator();
          addAgentMessage(`⚠️ Error en confirmación: ${e.message}`);
        }
      });
    }
  }

  async function callBackendAgent(userText) {
    try {
      // 1. Sincroniza cambios locales pendientes antes de consultar al agente
      await syncWithBackend();

      // 2. Ejecuta turno del agente
      const data = await backendPost('/agent/chat', { message: userText, thread_id: 'web' });
      removeTypingIndicator();
      await handleBackendResult(data);

      // 3. Sincroniza cambios generados por el agente
      if (!data.pending) {
        await syncWithBackend();
      }
    } catch (err) {
      console.error(err);
      removeTypingIndicator();
      addAgentMessage(`⚠️ Backend: ${err.message}`);
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

    // Conflicts modal
    $('#btn-conflicts')?.addEventListener('click', openConflictsModal);
    $('#conflicts-close')?.addEventListener('click', closeConflictsModal);
    $('#conflicts-done-btn')?.addEventListener('click', closeConflictsModal);
    $('#conflicts-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeConflictsModal(); });

    // Study view event listeners (Phase B)
    $('#btn-seed-subjects')?.addEventListener('click', handleSeedSubjects);
    $('#btn-add-subject')?.addEventListener('click', () => openSubjectModal());
    $('#study-filter-archived')?.addEventListener('change', (e) => {
      showArchivedSubjects = e.target.checked;
      renderStudyView();
    });

    // Subject modal
    $('#modal-subject-close')?.addEventListener('click', closeSubjectModal);
    $('#btn-cancel-subject')?.addEventListener('click', closeSubjectModal);
    $('#btn-save-subject')?.addEventListener('click', handleSaveSubject);
    $('#subject-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeSubjectModal();
    });
    $('#subject-color-picker')?.addEventListener('input', (e) => {
      const txt = $('#subject-color-input');
      if (txt) txt.value = e.target.value;
    });
    $('#subject-color-input')?.addEventListener('input', (e) => {
      const picker = $('#subject-color-picker');
      if (picker && /^#[0-9A-Fa-f]{6}$/.test(e.target.value)) {
        picker.value = e.target.value;
      }
    });

    // Topic modal
    $('#modal-topic-close')?.addEventListener('click', closeTopicModal);
    $('#btn-cancel-topic')?.addEventListener('click', closeTopicModal);
    $('#btn-save-topic')?.addEventListener('click', handleSaveTopic);
    $('#topic-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeTopicModal();
    });

    // Subject detail modal
    $('#detail-subject-close')?.addEventListener('click', closeSubjectDetailModal);
    $('#btn-close-subject-detail')?.addEventListener('click', closeSubjectDetailModal);
    $('#subject-detail-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeSubjectDetailModal();
    });
    $('#btn-add-topic-from-detail')?.addEventListener('click', () => {
      if (selectedSubjectIdForDetail) openTopicModal(selectedSubjectIdForDetail);
    });
    $('#btn-edit-subject-from-detail')?.addEventListener('click', () => {
      if (selectedSubjectIdForDetail) openSubjectModal(selectedSubjectIdForDetail);
    });
    $('#btn-delete-subject-from-detail')?.addEventListener('click', () => {
      if (selectedSubjectIdForDetail) handleDeleteOrArchiveSubject(selectedSubjectIdForDetail);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSearch();
        closeModal();
        closeDeleteModal();
        closeConflictsModal();
        closeSubjectModal();
        closeTopicModal();
        closeSubjectDetailModal();
        $('#routine-overlay')?.classList.remove('open');
      }
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

        const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';

        if (settings.backendUrl || isLocal) {
          addTypingIndicator();
          callBackendAgent(text);
        } else if (settings.groqKey) {
          addTypingIndicator();
          callGroq(text, settings.groqKey, relevantActs);
        } else if (settings.n8nUrl) {
          addTypingIndicator();
          callN8n(text, relevantActs);
        } else {
          addAgentMessage("⚠️ Para usar el asistente:<br>• En local: El backend ya está activo en <code>127.0.0.1:8000</code>.<br>• En Vercel: Configura tu API Key o URL del backend en la pestaña <strong>Ajustes</strong>.");
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

    // Actualiza badge de conflictos pendientes
    updateConflictsBadge();

    // Sincronización inicial no bloqueante con el backend
    const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
    if (settings.backendUrl || isLocal) {
      syncWithBackend();
    }

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
      block(lun, '06:30', '07:30', 'Calistenia', 'high', ['salud','ejercicio'], ''),
      block(lun, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(lun, '08:00', '10:00', 'Inglés', 'high', ['estudio','idiomas'], ''),
      block(lun, '10:00', '10:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(lun, '10:45', '11:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(lun, '11:10', '11:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(lun, '12:00', '13:00', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(lun, '13:00', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(lun, '14:00', '15:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(lun, '15:10', '15:40', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(lun, '15:40', '16:50', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(lun, '16:50', '17:20', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(lun, '17:20', '19:00', 'Estudiar/Proyectos', 'high', ['estudio','proyectos'], ''),
      block(lun, '19:00', '21:00', 'AI-300', 'high', ['estudio','ia'], ''),
      block(lun, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], ''),
      block(lun, '22:00', '23:00', 'Libro/Meditar', 'medium', ['personal','lectura'], ''),

      // ══ MARTES ══
      block(mar, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(mar, '06:30', '07:30', 'Correr', 'high', ['salud','ejercicio'], ''),
      block(mar, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(mar, '08:00', '10:00', 'Inglés', 'high', ['estudio','idiomas'], ''),
      block(mar, '10:00', '10:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(mar, '10:45', '11:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(mar, '11:10', '11:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(mar, '12:00', '13:00', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(mar, '13:00', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(mar, '14:00', '15:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(mar, '15:10', '15:40', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(mar, '15:40', '16:50', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(mar, '16:50', '17:20', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(mar, '17:20', '19:00', 'Estudiar/Proyectos', 'high', ['estudio','proyectos'], ''),
      block(mar, '19:00', '21:00', 'MLOPS', 'high', ['estudio','ia'], ''),
      block(mar, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], ''),
      block(mar, '22:00', '23:00', 'Libro/Meditar', 'medium', ['personal','lectura'], ''),

      // ══ MIÉRCOLES ══
      block(mie, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(mie, '06:30', '07:30', 'Calistenia', 'high', ['salud','ejercicio'], ''),
      block(mie, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(mie, '08:00', '10:00', 'Inglés', 'high', ['estudio','idiomas'], ''),
      block(mie, '10:00', '10:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(mie, '10:45', '11:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(mie, '11:10', '11:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(mie, '12:00', '13:00', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(mie, '13:00', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(mie, '14:00', '15:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(mie, '15:10', '15:40', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(mie, '15:40', '16:50', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(mie, '16:50', '17:20', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(mie, '17:20', '19:00', 'Estudiar/Proyectos', 'high', ['estudio','proyectos'], ''),
      block(mie, '19:00', '21:00', 'AI-300', 'high', ['estudio','ia'], ''),
      block(mie, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], ''),
      block(mie, '22:00', '23:00', 'Libro/Meditar', 'medium', ['personal','lectura'], ''),

      // ══ JUEVES ══
      block(jue, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(jue, '06:30', '07:30', 'Correr', 'high', ['salud','ejercicio'], ''),
      block(jue, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(jue, '08:00', '10:00', 'Inglés', 'high', ['estudio','idiomas'], ''),
      block(jue, '10:00', '10:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(jue, '10:45', '11:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(jue, '11:10', '11:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(jue, '12:00', '13:00', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(jue, '13:00', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(jue, '14:00', '15:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(jue, '15:10', '15:40', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(jue, '15:40', '16:50', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(jue, '16:50', '17:20', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(jue, '17:20', '19:00', 'Estudiar/Proyectos', 'high', ['estudio','proyectos'], ''),
      block(jue, '19:00', '21:00', 'MLOPS', 'high', ['estudio','ia'], ''),
      block(jue, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], ''),
      block(jue, '22:00', '23:00', 'Libro/Meditar', 'medium', ['personal','lectura'], ''),

      // ══ VIERNES ══
      block(vie, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(vie, '06:30', '07:30', 'Calistenia', 'high', ['salud','ejercicio'], ''),
      block(vie, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(vie, '08:00', '10:00', 'Inglés', 'high', ['estudio','idiomas'], ''),
      block(vie, '10:00', '10:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(vie, '10:45', '11:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(vie, '11:10', '11:45', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(vie, '12:00', '13:00', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(vie, '13:00', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(vie, '14:00', '15:10', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(vie, '15:10', '15:40', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(vie, '15:40', '16:50', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(vie, '16:50', '17:20', 'Benja Recorrido', 'medium', ['personal','familia'], ''),
      block(vie, '17:20', '19:00', 'Estudiar/Proyectos', 'high', ['estudio','proyectos'], ''),
      block(vie, '19:00', '21:00', 'AI-300', 'high', ['estudio','ia'], ''),
      block(vie, '21:00', '22:00', 'Entretenimiento', 'low', ['personal'], ''),
      block(vie, '22:00', '23:00', 'Libro/Meditar', 'medium', ['personal','lectura'], ''),

      // ══ SÁBADO ══
      block(sab, '00:00', '06:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(sab, '06:30', '07:30', 'Correr', 'high', ['salud','ejercicio'], ''),
      block(sab, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(sab, '08:00', '10:00', 'Inglés', 'high', ['estudio','idiomas'], ''),
      block(sab, '10:00', '11:45', 'Fuyu', 'high', ['trabajo','fuyu'], ''),
      block(sab, '12:00', '13:00', 'Entretenimiento', 'low', ['personal'], ''),
      block(sab, '13:00', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(sab, '14:00', '15:10', 'Entretenimiento', 'low', ['personal'], ''),
      block(sab, '15:10', '19:00', 'Estudiar/Proyectos', 'high', ['estudio','proyectos'], ''),
      block(sab, '19:00', '22:00', 'Entretenimiento', 'low', ['personal'], ''),
      block(sab, '22:00', '23:00', 'Entretenimiento', 'low', ['personal'], ''),

      // ══ DOMINGO ══
      block(dom, '00:00', '07:30', 'Dormir', 'high', ['salud'], 'Sueño reparador'),
      block(dom, '07:30', '08:00', 'Desayunar', 'medium', ['personal'], ''),
      block(dom, '08:00', '10:00', 'Libro/Meditar', 'medium', ['personal','lectura','bienestar'], ''),
      block(dom, '10:00', '10:45', 'Libro', 'medium', ['personal','lectura'], ''),
      block(dom, '10:45', '13:00', 'Estudiar/Proyectos', 'high', ['estudio','proyectos'], ''),
      block(dom, '13:00', '14:00', 'Almuerzo', 'low', ['personal'], ''),
      block(dom, '14:00', '22:00', 'Entretenimiento', 'low', ['personal'], ''),
      block(dom, '22:00', '23:00', 'Planificación', 'high', ['personal'], ''),
    ];
    saveActivities(activities);
    renderDashboard();
  }

  // ── Window Exports for Tests & Integrations (Guarded strictly by ?e2e=1 or localStorage) ──
  const isTestMode = typeof window !== 'undefined' && (
    (window.location && window.location.search && (window.location.search.includes('e2e=1') || window.location.search.includes('test=1'))) ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('diary_test_mode') === '1')
  );

  if (isTestMode) {
    window.__AppAgendaTest = {
      syncWithBackend,
      renderDashboard,
      renderCalendar,
      renderActivityList,
      renderStudyView,
      openConflictsModal,
      closeConflictsModal,
      updateConflictsBadge,
      loadActivities,
      saveActivities,
      loadSubjects,
      saveSubjects,
      loadTopics,
      saveTopics,
      handleSeedSubjects,
      openSubjectModal,
      closeSubjectModal,
      handleSaveSubject,
      openTopicModal,
      closeTopicModal,
      handleSaveTopic,
      openSubjectDetailModal,
      closeSubjectDetailModal,
      handleDeleteTopic,
      handleDeleteOrArchiveSubject
    };
    window.syncWithBackend = syncWithBackend;
    window.renderDashboard = renderDashboard;
    window.renderCalendar = renderCalendar;
    window.renderActivityList = renderActivityList;
    window.renderStudyView = renderStudyView;
    window.openConflictsModal = openConflictsModal;
    window.closeConflictsModal = closeConflictsModal;
    window.updateConflictsBadge = updateConflictsBadge;
    window.handleSeedSubjects = handleSeedSubjects;
    window.openSubjectModal = openSubjectModal;
    window.closeSubjectModal = closeSubjectModal;
    window.handleSaveSubject = handleSaveSubject;
    window.openTopicModal = openTopicModal;
    window.closeTopicModal = closeTopicModal;
    window.handleSaveTopic = handleSaveTopic;
    window.openSubjectDetailModal = openSubjectDetailModal;
    window.closeSubjectDetailModal = closeSubjectDetailModal;
    window.handleDeleteTopic = handleDeleteTopic;
    window.handleDeleteOrArchiveSubject = handleDeleteOrArchiveSubject;
  }

  // ── Boot ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
