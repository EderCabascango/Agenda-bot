/**
 * SyncCore: Funciones puras para la gestión de la cola de sincronización,
 * resolución de conflictos, aplicación de tombstones y pull incremental.
 */

/**
 * Agrega o actualiza un cambio en la cola de sincronización de manera idempotente.
 * Si ya existe una modificación pendiente para el mismo ID, combina los campos conservando el base_version original.
 */
function enqueueChange(queue, change) {
  if (!change || !change.id) return [...queue];
  const q = [...queue];
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
 * Si hubo fallo de red (no hay respuesta exitosa), la cola debe conservarse intacta.
 */
function dequeueCommitted(queue, committedChanges, conflicts = []) {
  if (!Array.isArray(queue) || !Array.isArray(committedChanges)) return queue || [];
  const conflictIds = new Set((conflicts || []).map(c => c.id));
  const committedIds = new Set(committedChanges.map(c => c.id));

  // Quitamos lo que se envió satisfactoriamente (incluyendo conflictos resueltos por servidor)
  return queue.filter(item => !committedIds.has(item.id) || conflictIds.has(item.id));
}

/**
 * Limpia totalmente los IDs confirmados y los que entraron en conflicto una vez que el cliente
 * adopta el estado del servidor.
 */
function purgeCommittedAndConflicted(queue, committedChanges) {
  if (!Array.isArray(queue) || !Array.isArray(committedChanges)) return queue || [];
  const committedIds = new Set(committedChanges.map(c => c.id));
  return queue.filter(item => !committedIds.has(item.id));
}

/**
 * Mezcla cambios remotos recibidos del servidor con las actividades locales.
 * - Si resyncRequired es true: reemplaza la lista con las actividades activas del servidor.
 * - Si hay tombstones (deleted_at): remueve la actividad local.
 * - Si hay modificaciones: compara versiones y gana la versión remota >= local.
 */
function mergeRemoteChanges(localActivities, remoteChanges, options = {}) {
  const current = Array.isArray(localActivities) ? [...localActivities] : [];
  if (!Array.isArray(remoteChanges)) return { activities: current, modified: false };

  if (options.resyncRequired) {
    const active = remoteChanges.filter(a => !a.deleted_at);
    return {
      activities: active,
      modified: true
    };
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
 * Prepara actividades importadas de un backup para sincronización segura sin DELETE masivo.
 * Conserva IDs existentes o genera nuevos, asigna base_version y encola los cambios.
 */
function prepareImportChanges(importedList, currentList, generateUUIDFn) {
  if (!Array.isArray(importedList)) return { mergedActivities: currentList || [], changesToEnqueue: [] };
  const currentMap = new Map((currentList || []).map(a => [a.id, a]));
  const merged = [...(currentList || [])];
  const changes = [];

  importedList.forEach(item => {
    if (!item) return;
    const actId = item.id || (typeof generateUUIDFn === 'function' ? generateUUIDFn() : `${Date.now()}_${Math.random()}`);
    const existing = currentMap.get(actId);

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
  });

  return { mergedActivities: merged, changesToEnqueue: changes };
}

// Exportación compatible con Node.js (CommonJS) y Navegadores
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    enqueueChange,
    dequeueCommitted,
    purgeCommittedAndConflicted,
    mergeRemoteChanges,
    filterActiveActivities,
    prepareImportChanges
  };
}
if (typeof window !== 'undefined') {
  window.SyncCore = {
    enqueueChange,
    dequeueCommitted,
    purgeCommittedAndConflicted,
    mergeRemoteChanges,
    filterActiveActivities,
    prepareImportChanges
  };
}
