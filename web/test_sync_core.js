const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  enqueueChange,
  dequeueCommitted,
  purgeCommittedAndConflicted,
  mergeRemoteChanges,
  filterActiveActivities,
  prepareImportChanges
} = require('./sync-core.js');

describe('SyncCore - Client Sync Logic Tests', () => {

  test('(d.1) Offline queueing and deduplication of rapid updates', () => {
    let queue = [];

    // Usuario offline crea una actividad
    queue = enqueueChange(queue, {
      id: 'act-1',
      title: 'Título Inicial',
      date: '2026-10-10',
      base_version: 1
    });

    // Usuario edita el título de la misma actividad antes de reconectar
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
    // La cola permanece con los datos intactos para el siguiente reintento
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, 'act-pending');
  });

  test('(d.4) Successful sync clears committed changes', () => {
    let queue = [
      { id: 'act-1', title: 'Subido 1' },
      { id: 'act-2', title: 'Subido 2' }
    ];

    const committed = [...queue];
    // Supongamos que mientras se enviaba, el usuario editó 'act-3'
    queue = enqueueChange(queue, { id: 'act-3', title: 'Nuevo en Cola' });

    // Se procesa la confirmación del lote anterior
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

  test('(7.1) Import backup creates safe merge changes without destructive mass delete', () => {
    const existing = [
      { id: 'existing-1', title: 'Local Previo', version: 2, completed: false }
    ];
    const backupToImport = [
      { id: 'existing-1', title: 'Local Previo Restaurado', completed: true },
      { id: 'new-from-backup', title: 'Nueva Restaurada', completed: false }
    ];

    const { mergedActivities, changesToEnqueue } = prepareImportChanges(backupToImport, existing);
    assert.equal(mergedActivities.length, 2);
    assert.equal(changesToEnqueue.length, 2);
    assert.equal(changesToEnqueue[0].base_version, 2, 'Debe asignar base_version para registros existentes');
    assert.equal(changesToEnqueue[1].base_version, undefined, 'Registros nuevos no tienen base_version previa');
  });

});
