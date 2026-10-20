/**
 * notes-core.js
 * Lógica pura de los Apuntes: etiquetas, búsqueda sin tildes, filtros por etiqueta y día,
 * orden (fijados primero) y progreso de la lista de tareas. Sin DOM ni almacenamiento.
 * Compatible con Node.js (CommonJS) y navegadores web (UMD / Global).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NotesCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  function fold(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }

  /** "Casa, #ideas  trabajo" -> ['casa', 'ideas', 'trabajo'] (sin repetir, máx. 20). */
  function parseTags(input) {
    const raw = Array.isArray(input) ? input : String(input || '').split(/[,\s]+/);
    const out = [];
    raw.forEach(t => {
      const tag = String(t || '').trim().toLowerCase().replace(/^#+/, '').slice(0, 40);
      if (tag && !out.includes(tag)) out.push(tag);
    });
    return out.slice(0, 20);
  }

  function isActive(n) {
    return !!n && !n.deleted_at;
  }

  function checklistProgress(note) {
    const items = note && Array.isArray(note.checklist) ? note.checklist.filter(i => i && String(i.text || '').trim()) : [];
    const done = items.filter(i => i.done).length;
    return { done, total: items.length, complete: items.length > 0 && done === items.length };
  }

  /** Busca en título, texto, tareas y etiquetas; filtra por etiqueta y por día. */
  function filterNotes(notes, { query = '', tag = '', date = '' } = {}) {
    const q = fold(query);
    const t = String(tag || '').toLowerCase();
    return (Array.isArray(notes) ? notes : []).filter(isActive).filter(n => {
      if (t && !(n.tags || []).includes(t)) return false;
      if (date && n.date !== date) return false;
      if (!q) return true;
      const haystack = fold([n.title, n.content, ...(n.checklist || []).map(i => i.text), ...(n.tags || [])].join(' '));
      return q.split(' ').every(word => haystack.includes(word));
    });
  }

  /** Fijados primero; dentro de cada grupo, el más recientemente editado arriba. */
  function sortNotes(notes) {
    return [...(Array.isArray(notes) ? notes : [])].sort((a, b) =>
      (Number(!!b.pinned) - Number(!!a.pinned)) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  /** Etiquetas usadas, de la más frecuente a la menos. */
  function allTags(notes) {
    const counts = {};
    (Array.isArray(notes) ? notes : []).filter(isActive).forEach(n => (n.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
  }

  function notesForDate(notes, date) {
    return sortNotes(filterNotes(notes, { date }));
  }

  /** Extracto corto del texto para la tarjeta. */
  function excerpt(note, max = 140) {
    const text = String((note && note.content) || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
  }

  function isEmpty(note) {
    return !String(note.title || '').trim() && !String(note.content || '').trim() && checklistProgress(note).total === 0;
  }

  return { fold, parseTags, checklistProgress, filterNotes, sortNotes, allTags, notesForDate, excerpt, isEmpty };
});
