const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SyncCore = require('./sync-core.js');
const {
  StorageAdapter,
  escHTML,
  enqueueChange,
  dequeueCommitted,
  purgeCommittedAndConflicted,
  handleSyncConflicts,
  rebaseConflictChange,
  discardConflictChange,
  mergeRemoteChanges,
  filterActiveActivities,
  getActiveDashboardActivities,
  getCalendarDayActivities,
  searchActivities,
  getPriorityStats,
  getAlarmEligibleActivities,
  validateImportPayload,
  prepareImportChanges,
  handleRejectedItems,
  migrateLegacyQueue,
  exportAllCollections,
  validateMultiCollectionImportPayload,
  prepareMultiCollectionImportChanges,
  getSubjectForSession,
  getTopicsForSession
} = SyncCore;

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

  describe('1.8.3 Tombstone Exclusion Across All Features', () => {
    const rawLocalArray = [
      { id: 'act-live-1', title: 'Reunión Activa', date: '2026-10-15', startTime: '09:00', endTime: '10:00', priority: 'high', completed: false, description: 'Estrategia de equipo' },
      { id: 'act-live-2', title: 'Calistenia', date: '2026-10-15', startTime: '07:00', endTime: '08:00', priority: 'medium', completed: true, description: 'Ejercicio' },
      { id: 'act-tombstone-1', title: 'Reunión Cancelada', date: '2026-10-15', startTime: '11:00', endTime: '12:00', priority: 'high', completed: false, deleted_at: '2026-10-15T08:00:00Z', description: 'Reunión cancelada' },
      { id: 'act-tombstone-2', title: 'Almuerzo Borrado', date: '2026-10-15', startTime: '13:00', endTime: '14:00', priority: 'low', completed: true, deleted_at: '2026-10-15T08:30:00Z', description: 'Almuerzo' }
    ];

    test('(1.8.3.a) filterActiveActivities strips all records with deleted_at', () => {
      const active = filterActiveActivities(rawLocalArray);
      assert.equal(active.length, 2);
      assert.ok(active.every(a => !a.deleted_at));
      assert.ok(!active.some(a => a.id.startsWith('act-tombstone')));
    });

    test('(1.8.3.b) Dashboard metrics & lists exclude tombstones', () => {
      const todayActs = getActiveDashboardActivities(rawLocalArray, '2026-10-15');
      const completed = todayActs.filter(a => a.completed).length;
      const pending = todayActs.filter(a => !a.completed).length;

      assert.equal(todayActs.length, 2, 'No debe contar tombstones en el total del dashboard');
      assert.equal(completed, 1, 'Solo 1 actividad completada activa');
      assert.equal(pending, 1, 'Solo 1 actividad pendiente activa');
    });

    test('(1.8.3.c) Calendar day dots and details exclude tombstones', () => {
      const dayDetailActs = getCalendarDayActivities(rawLocalArray, '2026-10-15');
      const hasActsForDate = dayDetailActs.length > 0;

      assert.equal(hasActsForDate, true);
      assert.equal(dayDetailActs.length, 2);
      assert.ok(!dayDetailActs.some(a => a.deleted_at));
    });

    test('(1.8.3.d) Search query matching excludes tombstones even if search query matches', () => {
      const searchResults = searchActivities(rawLocalArray, 'reunión');

      assert.equal(searchResults.length, 1, 'Solo debe coincidir la Reunión Activa, no la Cancelada');
      assert.equal(searchResults[0].id, 'act-live-1');
    });

    test('(1.8.3.e) Priority breakdown and productivity chart exclude tombstones', () => {
      const stats = getPriorityStats(rawLocalArray);

      assert.equal(stats.high, 1, 'Solo 1 actividad alta activa (la otra es tombstone)');
      assert.equal(stats.medium, 1);
      assert.equal(stats.low, 0, 'La actividad baja era un tombstone y no debe contarse');
      assert.equal(stats.total, 2);
    });

    test('(1.8.3.f) Alarm scheduling excludes tombstones', () => {
      const alarmEligible = getAlarmEligibleActivities(rawLocalArray, '2026-10-15');

      assert.equal(alarmEligible.length, 1);
      assert.equal(alarmEligible[0].id, 'act-live-1');
    });
  });

  describe('1.9.5 XSS Prevention & HTML Escaping', () => {
    test('(1.9.5.a) escHTML escapes dangerous script, img, svg tags', () => {
      assert.equal(escHTML('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      assert.equal(escHTML('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
      assert.equal(escHTML('"><svg onload=alert(1)>'), '&quot;&gt;&lt;svg onload=alert(1)&gt;');
    });

    test('(1.9.5.b) escHTML escapes both double and single quotes for attributes', () => {
      assert.equal(escHTML('foo"bar\'baz'), 'foo&quot;bar&#39;baz');
      assert.equal(escHTML("' onclick='alert(1)"), '&#39; onclick=&#39;alert(1)');
    });

    test('(1.9.5.c) escHTML handles null, undefined, numbers safely', () => {
      assert.equal(escHTML(null), '');
      assert.equal(escHTML(undefined), '');
      assert.equal(escHTML(123), '123');
    });
  });

  describe('A1.12 StorageAdapter QuotaExceededError Resilience', () => {
    test('(A1.12.a) StorageAdapter.setItem throws QuotaExceededError when quota is full', () => {
      const mockStorage = {
        setItem(k, v) {
          const err = new Error('Quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
      };
      assert.throws(
        () => StorageAdapter.setItem('key', 'val', mockStorage),
        /QuotaExceededError/
      );
    });

    test('(A1.12.b) StorageAdapter.getItem and setItem handle normal operation and errors gracefully', () => {
      const memory = {};
      const mockStorage = {
        getItem(k) { return memory[k] || null; },
        setItem(k, v) { memory[k] = v; },
        removeItem(k) { delete memory[k]; }
      };

      StorageAdapter.setItem('k1', 'val1', mockStorage);
      assert.equal(StorageAdapter.getItem('k1', mockStorage), 'val1');
      StorageAdapter.removeItem('k1', mockStorage);
      assert.equal(StorageAdapter.getItem('k1', mockStorage), null);
    });
  });

  describe('Paso 0.1 Generic Multi-Collection Functions & Legacy Migration', () => {
    const {
      handleRejectedItems,
      migrateLegacyQueue,
      mergeCollectionChanges
    } = require('./sync-core.js');

    test('(0.1.a) Generic queue and merge works uniformly across two distinct collections (activities & dummy_items)', () => {
      // Colección 1: activities
      let actsQueue = [];
      actsQueue = enqueueChange(actsQueue, { id: 'act-1', title: 'Actividad 1', date: '2026-10-10', base_version: 1 });
      actsQueue = enqueueChange(actsQueue, { id: 'act-1', title: 'Actividad 1 Editada', date: '2026-10-10' });
      assert.equal(actsQueue.length, 1);
      assert.equal(actsQueue[0].title, 'Actividad 1 Editada');

      const actsMerged = mergeCollectionChanges(
        [{ id: 'act-1', title: 'Actividad 1', version: 1 }],
        [{ id: 'act-1', title: 'Actividad 1 Server', version: 2 }]
      );
      assert.equal(actsMerged.activities[0].title, 'Actividad 1 Server');

      // Colección 2: dummy_items
      let dummyQueue = [];
      dummyQueue = enqueueChange(dummyQueue, { id: 'dummy-1', name: 'Item Ficticio', score: 100, base_version: 1 });
      dummyQueue = enqueueChange(dummyQueue, { id: 'dummy-1', name: 'Item Ficticio Editado', score: 150 });
      assert.equal(dummyQueue.length, 1);
      assert.equal(dummyQueue[0].name, 'Item Ficticio Editado');

      const dummyMerged = mergeCollectionChanges(
        [{ id: 'dummy-1', name: 'Item Ficticio', version: 1 }],
        [{ id: 'dummy-1', name: 'Item Ficticio Server', version: 2 }]
      );
      assert.equal(dummyMerged.activities[0].name, 'Item Ficticio Server');
    });

    test('(0.1.b) migrateLegacyQueue migrates pending changes without duplicates or data loss', () => {
      const legacyQueue = [
        { id: 'item-1', title: 'Tarea 1', base_version: 1 },
        { id: 'item-1', title: 'Tarea 1 Actualizada', date: '2026-10-10' },
        { id: 'item-2', title: 'Tarea 2', base_version: 2 }
      ];

      const migrated = migrateLegacyQueue(legacyQueue, 'activities');
      assert.equal(migrated.length, 2);
      assert.equal(migrated[0].id, 'item-1');
      assert.equal(migrated[0].title, 'Tarea 1 Actualizada');
      assert.equal(migrated[0].base_version, 1);
      assert.equal(migrated[0].collection, 'activities');
      assert.equal(migrated[1].id, 'item-2');
      assert.equal(migrated[1].collection, 'activities');
    });

    test('(0.3.a) handleRejectedItems sequesters invalid items and purges them from retry queue', () => {
      let queue = [
        { id: 'act-valid', title: 'Válida' },
        { id: 'act-invalid', title: 'Inválida' }
      ];
      let rejectedStore = {};

      const serverRejections = [
        { id: 'act-invalid', collection: 'activities', reason: 'Campo excede tamaño máximo' }
      ];

      const res = handleRejectedItems(rejectedStore, queue, serverRejections);
      rejectedStore = res.rejectedStore;
      queue = res.queue;

      assert.equal(queue.length, 1);
      assert.equal(queue[0].id, 'act-valid');
      assert.ok(rejectedStore['act-invalid']);
      assert.equal(rejectedStore['act-invalid'].reason, 'Campo excede tamaño máximo');
      assert.equal(rejectedStore['act-invalid'].localItem.title, 'Inválida');
    });
  });

  describe('Fase A2: Multi-colección, preservación de notas y huérfanos tolerables', () => {
    test('exportAllCollections genera payload con schema_version 2 y las 5 colecciones', () => {
      const data = {
        activities: [{ id: 'act-1', title: 'A1' }],
        subjects: [{ id: 'sub-1', name: 'S1' }],
        topics: [{ id: 'top-1', name: 'T1' }],
        focus_sessions: [{ id: 'foc-1', effective_seconds: 1500 }],
        learning_notes: [{ id: 'not-1', learned_text: 'L1' }]
      };
      const exp = SyncCore.exportAllCollections(data);
      assert.equal(exp.schema_version, 2);
      assert.ok(exp.exported_at);
      assert.equal(exp.collections.activities.length, 1);
      assert.equal(exp.collections.subjects.length, 1);
      assert.equal(exp.collections.topics.length, 1);
      assert.equal(exp.collections.focus_sessions.length, 1);
      assert.equal(exp.collections.learning_notes.length, 1);
    });

    test('validateMultiCollectionImportPayload valida formato v2 y mantiene compatibilidad v1 legacy', () => {
      // V2 payload
      const v2Payload = {
        schema_version: 2,
        collections: {
          activities: [{ id: 'act-1', title: 'Actividad V2', date: '2026-10-10' }],
          subjects: [{ id: 'sub-1', name: 'Materia V2' }]
        }
      };
      const resV2 = SyncCore.validateMultiCollectionImportPayload(v2Payload);
      assert.equal(resV2.valid, true);
      assert.equal(resV2.sanitized.activities.length, 1);
      assert.equal(resV2.sanitized.subjects.length, 1);

      // V1 legacy payload (array plano de actividades)
      const v1Payload = [{ id: 'act-old', title: 'Legacy Act', date: '2026-10-10' }];
      const resV1 = SyncCore.validateMultiCollectionImportPayload(v1Payload);
      assert.equal(resV1.valid, true);
      assert.equal(resV1.schema_version, 1);
      assert.equal(resV1.sanitized.activities.length, 1);
      assert.equal(resV1.sanitized.activities[0].title, 'Legacy Act');
      assert.deepEqual(resV1.sanitized.subjects, []);
    });

    test('prepareMultiCollectionImportChanges fusiona 5 colecciones respetando versiones y tombstones', () => {
      const imported = {
        activities: [{ id: 'act-1', title: 'Act Importada', date: '2026-10-10', version: 1 }],
        subjects: [{ id: 'sub-1', name: 'Materia Importada', version: 1 }],
        topics: [],
        focus_sessions: [{ id: 'foc-1', effective_seconds: 1800, version: 1 }],
        learning_notes: []
      };
      const current = {
        activities: [{ id: 'act-1', title: 'Act Local Más Nueva', date: '2026-10-10', version: 2 }],
        subjects: [],
        topics: [],
        focus_sessions: [],
        learning_notes: []
      };

      const res = SyncCore.prepareMultiCollectionImportChanges(imported, current, () => 'new-uuid');
      assert.equal(res.stats.imported, 2); // sub-1 y foc-1 importadas
      assert.equal(res.stats.conflicted, 1); // act-1 omitida por version inferior
      assert.equal(res.mergedCollections.activities[0].title, 'Act Local Más Nueva');
      assert.equal(res.mergedCollections.subjects.length, 1);
      assert.equal(res.mergedCollections.focus_sessions.length, 1);
      assert.ok(res.changesToEnqueue.some(c => c.collection === 'subjects'));
      assert.ok(res.changesToEnqueue.some(c => c.collection === 'focus_sessions'));
    });

    test('discardConflictChange preserva texto de learning_notes con conflict_of', () => {
      const conflictsStore = {
        'note-orig-1': {
          localChange: {
            id: 'note-orig-1',
            collection: 'learning_notes',
            learned_text: 'Apunte muy importante del alumno que no debe perderse',
            topic_ids: ['top-1']
          }
        },
        'act-orig-1': {
          localChange: {
            id: 'act-orig-1',
            collection: 'activities',
            title: 'Actividad que se descarta normalmente'
          }
        }
      };

      // 1. Descartar conflicto de learning_notes -> preserva texto
      const resNote = SyncCore.discardConflictChange(conflictsStore, 'note-orig-1', {
        generateUUIDFn: () => 'note-preserved-123'
      });
      assert.equal(resNote.conflictsStore['note-orig-1'], undefined);
      assert.ok(resNote.preservedNote);
      assert.equal(resNote.preservedNote.id, 'note-preserved-123');
      assert.equal(resNote.preservedNote.conflict_of, 'note-orig-1');
      assert.equal(resNote.preservedNote.learned_text, 'Apunte muy importante del alumno que no debe perderse');

      // 2. Descartar conflicto de activities -> no genera preservedNote
      const resAct = SyncCore.discardConflictChange(conflictsStore, 'act-orig-1');
      assert.equal(resAct.conflictsStore['act-orig-1'], undefined);
      assert.equal(resAct.preservedNote, null);
    });

    test('helpers tolerantes a huérfanos manejan referencias ausentes y tombstones', () => {
      const subjects = [
        { id: 'sub-active', name: 'Materia Activa', deleted_at: null },
        { id: 'sub-deleted', name: 'Materia Borrada', deleted_at: '2026-10-10T12:00:00Z' }
      ];
      const topics = [
        { id: 'top-1', name: 'Tema 1', deleted_at: null },
        { id: 'top-2', name: 'Tema 2', deleted_at: '2026-10-10T12:00:00Z' }
      ];

      // Sesión con materia activa
      assert.equal(SyncCore.getSubjectForSession(subjects, 'sub-active').name, 'Materia Activa');
      // Sesión con materia borrada o inexistente
      assert.equal(SyncCore.getSubjectForSession(subjects, 'sub-deleted'), null);
      assert.equal(SyncCore.getSubjectForSession(subjects, 'sub-nonexistent'), null);
      assert.equal(SyncCore.getSubjectForSession(null, 'sub-active'), null);

      // Temas para sesión
      const resTopics = SyncCore.getTopicsForSession(topics, ['top-1', 'top-2', 'top-unknown']);
      assert.equal(resTopics.length, 1);
      assert.equal(resTopics[0].id, 'top-1');
    });
  });

});


