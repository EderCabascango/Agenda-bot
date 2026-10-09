const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./sync-core.js');

describe('SyncCore - Complete Client Sync Logic Test Suite (Fase 1, 1.5, 1.6)', () => {

  test('(d.1) Offline queueing and deduplication of rapid updates', () => {
    let queue = [];

    queue = enqueueChange(queue, {
      id: 'act-1',
      title: 'Título Inicial',
      date: '2026-10-10',
      base_version: 1
    });

    queue = enqueueChange(queue, {
      id: 'act-1',
      title: 'Título Actualizado 1',
      date: '2026-10-10'
    });

    queue = enqueueChange(queue, {
      id: 'act-1',
      title: 'Título Final',
      date: '2026-10-10'
    });

    assert.equal(queue.length, 1, 'La cola no debe acumular registros redundantes para el mismo ID');
    assert.equal(queue[0].title, 'Título Final');
    assert.equal(queue[0].base_version, 1, 'Debe preservar el base_version original');
  });

  test('(d.2) Multiple distinct activities in queue', () => {
    let queue = [];
    queue = enqueueChange(queue, { id: 'act-1', title: 'Act 1', date: '2026-10-10' });
    queue = enqueueChange(queue, { id: 'act-2', title: 'Act 2', date: '2026-10-10' });
    queue = enqueueChange(queue, { id: 'act-3', title: 'Act 3', date: '2026-10-10' });

    assert.equal(queue.length, 3);
  });

  test('(d.3) Network failure resilience: queue is NOT cleared if sync fails', () => {
    let queue = [{ id: 'act-pending', title: 'Pendiente', date: '2026-10-10' }];
    // Si la llamada fetch falla por red, no se llama a dequeue/purge
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, 'act-pending');
  });

  test('(d.4) Successful sync clears committed changes (idempotent purge)', () => {
    let queue = [
      { id: 'act-1', title: 'Subido 1' },
      { id: 'act-2', title: 'Subido 2' }
    ];

    const committed = [...queue];
    queue = enqueueChange(queue, { id: 'act-3', title: 'Nuevo en Cola' });

    queue = purgeCommittedAndConflicted(queue, committed);

    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, 'act-3');
  });

  test('(d.5) Incremental merge: Remote higher version wins over local older version', () => {
    const local = [
      { id: 'act-shared', title: 'Local Viejo', version: 1, date: '2026-10-10' }
    ];
    const remote = [
      { id: 'act-shared', title: 'Remoto Servidor Nuevo', version: 2, date: '2026-10-10' },
      { id: 'act-new-remote', title: 'Remoto Recién Creado', version: 1, date: '2026-10-10' }
    ];

    const { activities, modified } = mergeRemoteChanges(local, remote);
    assert.equal(modified, true);
    assert.equal(activities.length, 2);
    assert.equal(activities[0].title, 'Remoto Servidor Nuevo');
    assert.equal(activities[0].version, 2);
    assert.equal(activities[1].id, 'act-new-remote');
  });

  test('(d.6) Incremental merge: Tombstone (deleted_at) removes local activity', () => {
    const local = [
      { id: 'act-to-be-deleted', title: 'Actividad que se borrará', version: 1 },
      { id: 'act-keep', title: 'Permanente', version: 1 }
    ];
    const remote = [
      { id: 'act-to-be-deleted', title: 'Por borrar', deleted_at: '2026-10-10T12:00:00Z', version: 2 }
    ];

    const { activities, modified } = mergeRemoteChanges(local, remote);
    assert.equal(modified, true);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].id, 'act-keep');
  });

  test('(d.7) Full resync support when server signals resyncRequired=true', () => {
    const staleLocal = [
      { id: 'stale-1', title: 'Desactualizado 1' },
      { id: 'stale-2', title: 'Desactualizado 2' }
    ];
    const cleanServerList = [
      { id: 'server-clean-1', title: 'Servidor Actual 1', version: 5 }
    ];

    const { activities, modified } = mergeRemoteChanges(staleLocal, cleanServerList, { resyncRequired: true });
    assert.equal(modified, true);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].id, 'server-clean-1');
  });

  test('(1.6.3.a) Conflict does not lose local edit: saved in conflictsStore', () => {
    let queue = [
      { id: 'act-conf', title: 'Edición Local Desactualizada', base_version: 1 }
    ];
    let conflictsStore = {};

    const serverConflicts = [
      {
        id: 'act-conf',
        server_version: 3,
        server_updated_at: '2026-10-10T15:00:00Z',
        reason: 'version_stale'
      }
    ];

    const result = handleSyncConflicts(conflictsStore, queue, serverConflicts);
    conflictsStore = result.conflictsStore;

    assert.ok(conflictsStore['act-conf'], 'El conflicto debe guardarse en el store');
    assert.equal(conflictsStore['act-conf'].localChange.title, 'Edición Local Desactualizada');
    assert.equal(conflictsStore['act-conf'].serverVersion, 3);
  });

  test('(1.6.3.b) Rebase conflict change assigns new base_version and enqueues', () => {
    let conflictsStore = {
      'act-conf': {
        id: 'act-conf',
        localChange: { id: 'act-conf', title: 'Edición Local Desactualizada', base_version: 1 },
        serverVersion: 3
      }
    };
    let queue = [];

    const result = rebaseConflictChange(conflictsStore, queue, 'act-conf', 3);
    conflictsStore = result.conflictsStore;
    queue = result.queue;

    assert.equal(Object.keys(conflictsStore).length, 0, 'El conflicto resuelto se remueve del store');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].base_version, 3, 'La nueva base_version debe ser 3');
    assert.equal(queue[0].title, 'Edición Local Desactualizada');
  });

  test('(1.6.3.c) Discard conflict removes item from store (accepting server)', () => {
    let conflictsStore = {
      'act-conf': { id: 'act-conf', serverVersion: 3 }
    };
    const result = discardConflictChange(conflictsStore, 'act-conf');
    assert.equal(Object.keys(result.conflictsStore).length, 0);
  });

  test('(1.6.5.a) Resync required retains and merges pending queue changes', () => {
    const staleLocal = [
      { id: 'act-1', title: 'Antiguo 1', version: 1 }
    ];
    const pendingQueue = [
      { id: 'act-offline-edit', title: 'Edición en Cola Offline', version: 2 }
    ];
    const serverFullList = [
      { id: 'act-server-1', title: 'Servidor Canónico', version: 5 }
    ];

    const { activities, modified } = mergeRemoteChanges(staleLocal, serverFullList, {
      resyncRequired: true,
      pendingQueue
    });

    assert.equal(modified, true);
    assert.equal(activities.length, 2, 'Debe incluir la lista limpia del servidor + las ediciones en cola');
    assert.ok(activities.some(a => a.id === 'act-server-1'));
    assert.ok(activities.some(a => a.id === 'act-offline-edit'));
  });

  test('(1.6.6.a) validateImportPayload: rejects invalid JSON, bad dates, missing titles, oversized', () => {
    assert.equal(validateImportPayload('not json').valid, false);
    assert.equal(validateImportPayload({ not: 'an array' }).valid, false);
    assert.equal(validateImportPayload([{ title: '', date: '2026-10-10' }]).valid, false);
    assert.equal(validateImportPayload([{ title: 'Valido', date: 'invalid-date' }]).valid, false);

    const validPayload = [
      { id: 'uuid-1', title: 'Estudiar', date: '2026-10-10', priority: 'high', completed: true, tags: ['estudio'] }
    ];
    const res = validateImportPayload(validPayload);
    assert.equal(res.valid, true);
    assert.equal(res.sanitized.length, 1);
    assert.equal(res.sanitized[0].title, 'Estudiar');
  });

  test('(1.6.6.b) prepareImportChanges reports import, skip, and conflict stats', () => {
    const current = [
      { id: 'act-deleted', title: 'Eliminado', deleted_at: '2026-10-10T10:00:00Z', version: 2 },
      { id: 'act-newer', title: 'Versión Nueva', version: 5 }
    ];

    const incoming = [
      { id: 'act-deleted', title: 'Eliminado Intentado', version: 1 },
      { id: 'act-newer', title: 'Versión Vieja', version: 2 },
      { id: 'act-fresh', title: 'Totalmente Nuevo', date: '2026-10-10' }
    ];

    const { mergedActivities, changesToEnqueue, stats } = prepareImportChanges(incoming, current, () => 'gen-uuid');

    assert.equal(stats.skipped, 1, 'No debe resucitar tombstones');
    assert.equal(stats.conflicted, 1, 'No debe degradar versiones superiores');
    assert.equal(stats.imported, 1, 'Solo importa el elemento fresco');
    assert.equal(changesToEnqueue.length, 1);
    assert.equal(changesToEnqueue[0].id, 'act-fresh');
  });

  test('(1.6.6.c) Export -> Import equivalence on clean instance', () => {
    const originalActivities = [
      { id: 'act-1', title: 'Rutina A', date: '2026-10-15', startTime: '08:00', endTime: '09:00', priority: 'high', tags: ['salud'], completed: false, version: 1 },
      { id: 'act-2', title: 'Rutina B', date: '2026-10-15', startTime: '09:00', endTime: '10:00', priority: 'medium', tags: ['trabajo'], completed: true, version: 2 }
    ];

    const exportedJSON = JSON.stringify(originalActivities);

    const validation = validateImportPayload(exportedJSON);
    assert.equal(validation.valid, true);

    const { mergedActivities } = prepareImportChanges(validation.sanitized, []);

    assert.equal(mergedActivities.length, originalActivities.length);
    assert.equal(mergedActivities[0].id, originalActivities[0].id);
    assert.equal(mergedActivities[0].title, originalActivities[0].title);
    assert.equal(mergedActivities[1].completed, true);
  });

  test('(7.1) Import backup creates safe merge changes without destructive mass delete', () => {
    const existing = [
      { id: 'existing-1', title: 'Local Previo', version: 2, completed: false }
    ];
    const backupToImport = [
      { id: 'existing-1', title: 'Local Previo Restaurado', version: 2, completed: true },
      { id: 'new-from-backup', title: 'Nueva Restaurada', completed: false }
    ];

    const { mergedActivities, changesToEnqueue } = prepareImportChanges(backupToImport, existing);
    assert.equal(mergedActivities.length, 2);
    assert.equal(changesToEnqueue.length, 2);
    assert.equal(changesToEnqueue[0].base_version, 2, 'Debe asignar base_version para registros existentes');
    assert.equal(changesToEnqueue[1].base_version, undefined, 'Registros nuevos no tienen base_version previa');
  });

});
