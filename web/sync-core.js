/**
 * SyncCore: Funciones puras para la gestión de la cola de sincronización,
 * resolución de conflictos (rebase/adopt), aplicación de tombstones,
 * pull incremental, validación e importación segura de datos.
 */

const MAX_IMPORT_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Agrega o actualiza un cambio en la cola de sincronización de manera idempotente.
 * Si ya existe una modificación pendiente para el mismo ID, combina los campos conservando el base_version original.
 */
function enqueueChange(queue, change) {
  if (!change || !change.id) return [...(queue || [])];
  const q = [...(queue || [])];
  const idx = q.findIndex(item => item.id === change.id);

  if (idx !== -1) {
    const existing = q[idx];
    q[idx] = {
      ...existing,
      ...change,
      // Conservar el base_version inicial con el que se originó el cambio
      base_version: existing.base_version !== undefined ? existing.base_version : change.base_version
    };
  } else {
    q.push({ ...change });
  }
  return q;
}

/**
 * Remueve de la cola los cambios que fueron exitosamente confirmados por el servidor.
 * Si hubo fallo de red, la cola debe conservarse intacta.
 */
function dequeueCommitted(queue, committedChanges, conflicts = []) {
  if (!Array.isArray(queue) || !Array.isArray(committedChanges)) return queue || [];
  const conflictIds = new Set((conflicts || []).map(c => c.id));
  const committedIds = new Set(committedChanges.map(c => c.id));

  return queue.filter(item => !committedIds.has(item.id) || conflictIds.has(item.id));
}

/**
 * Limpia totalmente los IDs confirmados de la cola una vez procesados o movidos al almacén de conflictos.
 */
function purgeCommittedAndConflicted(queue, committedChanges) {
  if (!Array.isArray(queue) || !Array.isArray(committedChanges)) return queue || [];
  const committedIds = new Set(committedChanges.map(c => c.id));
  return queue.filter(item => !committedIds.has(item.id));
}

/**
 * Registra conflictos en el almacén `conflictsStore` sin perder la edición local del usuario.
 */
function handleSyncConflicts(conflictsStore, queue, serverConflicts = []) {
  const store = { ...(conflictsStore || {}) };
  if (!Array.isArray(serverConflicts) || serverConflicts.length === 0) {
    return { conflictsStore: store, queue: queue || [] };
  }

  serverConflicts.forEach(conf => {
    if (!conf || !conf.id) return;
    const localChange = (queue || []).find(q => q.id === conf.id);
    store[conf.id] = {
      id: conf.id,
      localChange: localChange || null,
      serverVersion: conf.server_version,
      serverUpdatedAt: conf.server_updated_at,
      serverItem: conf.server_item || null,
      reason: conf.reason || 'conflict',
      detectedAt: new Date().toISOString()
    };
  });

  return { conflictsStore: store, queue: queue || [] };
}

/**
 * Re-aplica la edición local sobre la versión más reciente del servidor (Rebase).
 * Asigna la nueva base_version y re-encola el cambio.
 */
function rebaseConflictChange(conflictsStore, queue, activityId, newBaseVersion) {
  const store = { ...(conflictsStore || {}) };
  let q = [...(queue || [])];

  const conflict = store[activityId];
  if (conflict && conflict.localChange) {
    const rebasedChange = {
      ...conflict.localChange,
      base_version: newBaseVersion
    };
    q = enqueueChange(q, rebasedChange);
  }
  delete store[activityId];

  return { conflictsStore: store, queue: q };
}

/**
 * Descarta la edición local en conflicto y adopta la versión del servidor.
 */
function discardConflictChange(conflictsStore, activityId) {
  const store = { ...(conflictsStore || {}) };
  delete store[activityId];
  return { conflictsStore: store };
}

/**
 * Mezcla cambios remotos recibidos del servidor con las actividades locales.
 * - Si resyncRequired es true: reemplaza la lista con las actividades activas del servidor,
 *   pero conserva y aplica cambios locales pendientes en `options.pendingQueue`.
 * - Si hay tombstones (deleted_at): remueve la actividad local.
 * - Si hay modificaciones: compara versiones y gana la versión remota >= local.
 */
function mergeRemoteChanges(localActivities, remoteChanges, options = {}) {
  const current = Array.isArray(localActivities) ? [...localActivities] : [];
  if (!Array.isArray(remoteChanges)) return { activities: current, modified: false };

  if (options.resyncRequired) {
    const serverActive = remoteChanges.filter(a => a && !a.deleted_at);
    let merged = [...serverActive];

    // Conservar cambios pendientes locales que aún no subieron
    if (Array.isArray(options.pendingQueue) && options.pendingQueue.length > 0) {
      options.pendingQueue.forEach(pending => {
        if (!pending || !pending.id) return;
        const idx = merged.findIndex(a => a.id === pending.id);
        if (pending.deleted_at) {
          if (idx !== -1) merged.splice(idx, 1);
        } else {
          if (idx !== -1) {
            merged[idx] = { ...merged[idx], ...pending };
          } else {
            merged.push({ ...pending });
          }
        }
      });
    }

    return { activities: merged, modified: true };
  }

  let modified = false;
  const result = [...current];

  remoteChanges.forEach(remote => {
    if (!remote || !remote.id) return;
    const idx = result.findIndex(a => a.id === remote.id);

    if (remote.deleted_at) {
      if (idx !== -1) {
        result.splice(idx, 1);
        modified = true;
      }
    } else {
      if (idx !== -1) {
        const localVer = result[idx].version || 1;
        const remoteVer = remote.version || 1;
        if (remoteVer >= localVer) {
          result[idx] = { ...result[idx], ...remote };
          modified = true;
        }
      } else {
        result.push({ ...remote });
        modified = true;
      }
    }
  });

  return { activities: result, modified };
}

/**
 * Filtra únicamente las actividades activas (excluye tombstones).
 */
function filterActiveActivities(activities) {
  if (!Array.isArray(activities)) return [];
  return activities.filter(a => a && !a.deleted_at);
}

/**
 * Valida minuciosamente el payload de importación JSON.
 */
function validateImportPayload(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_IMPORT_SIZE_BYTES) {
      return { valid: false, error: 'El archivo excede el tamaño máximo permitido (5 MB).' };
    }
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { valid: false, error: 'El archivo no contiene un JSON válido.' };
    }
  }

  if (!Array.isArray(parsed)) {
    return { valid: false, error: 'La estructura debe ser un array de actividades JSON.' };
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
  const sanitized = [];

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object') {
      return { valid: false, error: `El elemento en la posición ${i} no es un objeto válido.` };
    }
    if (!item.title || typeof item.title !== 'string' || item.title.trim() === '') {
      return { valid: false, error: `El elemento en la posición ${i} requiere un título no vacío.` };
    }
    if (!item.date || typeof item.date !== 'string' || !dateRegex.test(item.date)) {
      return { valid: false, error: `El elemento '${item.title}' tiene una fecha inválida (formato requerido: YYYY-MM-DD).` };
    }

    const startTime = (typeof item.startTime === 'string' && timeRegex.test(item.startTime)) ? item.startTime : '';
    const endTime = (typeof item.endTime === 'string' && timeRegex.test(item.endTime)) ? item.endTime : '';
    const priority = ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium';
    const tags = Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string').map(t => t.trim()).filter(Boolean) : [];
    const completed = Boolean(item.completed);
    const description = typeof item.description === 'string' ? item.description : '';

    sanitized.push({
      id: item.id && typeof item.id === 'string' ? item.id : undefined,
      title: item.title.trim(),
      date: item.date,
      startTime,
      endTime,
      priority,
      tags,
      completed,
      description,
      version: typeof item.version === 'number' ? item.version : 1,
      deleted_at: item.deleted_at || null
    });
  }

  return { valid: true, sanitized };
}

/**
 * Prepara actividades importadas de un backup para sincronización segura.
 * Reporta estadísticas de importación y evita resucitar elementos eliminados o degradar versiones.
 */
function prepareImportChanges(importedList, currentList, generateUUIDFn, options = {}) {
  if (!Array.isArray(importedList)) {
    return { mergedActivities: currentList || [], changesToEnqueue: [], stats: { imported: 0, skipped: 0, conflicted: 0 } };
  }
  const currentMap = new Map((currentList || []).map(a => [a.id, a]));
  const merged = [...(currentList || [])];
  const changes = [];
  let importedCount = 0;
  let skippedCount = 0;
  let conflictedCount = 0;

  importedList.forEach(item => {
    if (!item) return;
    const actId = item.id || (typeof generateUUIDFn === 'function' ? generateUUIDFn() : `${Date.now()}_${Math.random()}`);
    const existing = currentMap.get(actId);

    // Si ya existe como eliminado y no se especificó resucitar
    if (existing && existing.deleted_at && !options.resurrect) {
      skippedCount++;
      return;
    }

    // Si el registro existente tiene una versión superior a la que se intenta importar
    if (existing && (existing.version || 1) > (item.version || 1)) {
      conflictedCount++;
      // No degradar versión
      return;
    }

    const normalized = {
      ...item,
      id: actId,
      completed: Boolean(item.completed),
      tags: Array.isArray(item.tags) ? item.tags : [],
      version: existing ? (existing.version || 1) : 1,
      base_version: existing ? (existing.version || 1) : undefined,
    };

    if (existing) {
      const idx = merged.findIndex(a => a.id === actId);
      merged[idx] = normalized;
    } else {
      merged.push(normalized);
    }
    changes.push(normalized);
    importedCount++;
  });

  return {
    mergedActivities: merged,
    changesToEnqueue: changes,
    stats: {
      imported: importedCount,
      skipped: skippedCount,
      conflicted: conflictedCount
    }
  };
}

// Exportación compatible con Node.js y Navegadores
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    enqueueChange,
    dequeueCommitted,
    purgeCommittedAndConflicted,
    handleSyncConflicts,
    rebaseConflictChange,
    discardConflictChange,
    mergeRemoteChanges,
    filterActiveActivities,
    validateImportPayload,
    prepareImportChanges
  };
}
if (typeof window !== 'undefined') {
  window.SyncCore = {
    enqueueChange,
    dequeueCommitted,
    purgeCommittedAndConflicted,
    handleSyncConflicts,
    rebaseConflictChange,
    discardConflictChange,
    mergeRemoteChanges,
    filterActiveActivities,
    validateImportPayload,
    prepareImportChanges
  };
}
