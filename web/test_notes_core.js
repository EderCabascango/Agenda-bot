/**
 * test_notes_core.js
 * Tests unitarios con node:test para web/notes-core.js (sección Apuntes).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const NotesCore = require('./notes-core.js');

const NOTES = [
  { id: 'n1', title: 'Compras', content: 'Para el sábado', checklist: [{ text: 'Leche', done: true }, { text: 'Pan', done: false }], tags: ['casa'], date: '2026-10-19', pinned: 0, updated_at: '2026-10-19T10:00:00Z' },
  { id: 'n2', title: 'Ideas app', content: 'Módulo de canción y música', checklist: [], tags: ['ideas', 'app'], date: '', pinned: 1, updated_at: '2026-10-18T10:00:00Z' },
  { id: 'n3', title: 'Reunión', content: 'Revisar presupuesto con Ana', checklist: [{ text: 'Enviar acta', done: true }], tags: ['trabajo'], date: '2026-10-19', pinned: 0, updated_at: '2026-10-20T10:00:00Z' },
  { id: 'n4', title: 'Borrada', content: 'no debe salir', tags: ['casa'], date: '2026-10-19', deleted_at: '2026-10-19T11:00:00Z' }
];

test('NotesCore - Apuntes', async (t) => {

  await t.test('1. parseTags: separa por comas o espacios, quita #, minúsculas y sin repetir', () => {
    assert.deepEqual(NotesCore.parseTags('Casa, #ideas  trabajo casa'), ['casa', 'ideas', 'trabajo']);
    assert.deepEqual(NotesCore.parseTags(['#A', 'a', '']), ['a']);
    assert.equal(NotesCore.parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20);
  });

  await t.test('2. Búsqueda sin tildes ni mayúsculas en título, texto, tareas y etiquetas', () => {
    assert.deepEqual(NotesCore.filterNotes(NOTES, { query: 'cancion' }).map(n => n.id), ['n2']);
    assert.deepEqual(NotesCore.filterNotes(NOTES, { query: 'LECHE' }).map(n => n.id), ['n1']);
    assert.deepEqual(NotesCore.filterNotes(NOTES, { query: 'trabajo' }).map(n => n.id), ['n3']);
    assert.deepEqual(NotesCore.filterNotes(NOTES, { query: 'revisar ana' }).map(n => n.id), ['n3'], 'todas las palabras');
    assert.equal(NotesCore.filterNotes(NOTES, { query: 'borrada' }).length, 0, 'los borrados no salen');
  });

  await t.test('3. Filtro por etiqueta y por día', () => {
    assert.deepEqual(NotesCore.filterNotes(NOTES, { tag: 'casa' }).map(n => n.id), ['n1']);
    assert.deepEqual(NotesCore.filterNotes(NOTES, { date: '2026-10-19' }).map(n => n.id), ['n1', 'n3']);
    assert.deepEqual(NotesCore.notesForDate(NOTES, '2026-10-19').map(n => n.id), ['n3', 'n1'], 'del día, más recientes primero');
  });

  await t.test('4. Orden: fijados primero y luego por última edición', () => {
    assert.deepEqual(NotesCore.sortNotes(NOTES.slice(0, 3)).map(n => n.id), ['n2', 'n3', 'n1']);
  });

  await t.test('5. Progreso de tareas, etiquetas usadas, extracto y vacío', () => {
    assert.deepEqual(NotesCore.checklistProgress(NOTES[0]), { done: 1, total: 2, complete: false });
    assert.deepEqual(NotesCore.checklistProgress(NOTES[2]), { done: 1, total: 1, complete: true });
    assert.deepEqual(NotesCore.checklistProgress({ checklist: [{ text: '  ' }] }), { done: 0, total: 0, complete: false });
    assert.deepEqual(NotesCore.allTags(NOTES).map(x => x.tag), ['app', 'casa', 'ideas', 'trabajo']);
    assert.equal(NotesCore.excerpt({ content: 'a'.repeat(200) }, 20).length, 20);
    assert.equal(NotesCore.isEmpty({ title: ' ', content: '', checklist: [] }), true);
    assert.equal(NotesCore.isEmpty({ checklist: [{ text: 'x' }] }), false);
  });
});
