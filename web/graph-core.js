/**
 * graph-core.js
 * Grafo del "segundo cerebro": nodos = apuntes, aristas = enlaces [[Título]].
 * Los enlaces a apuntes que aún no existen aparecen como nodos "fantasma".
 * Incluye una simulación de fuerzas simple (repulsión + resortes + gravedad al centro),
 * determinista con semilla, sin dependencias. Compatible con Node.js y navegador (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GraphCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * notes: apuntes; notesCore: { fold, extractLinks } (NotesCore).
   * Devuelve { nodes: [{ id, title, noteId, missing, degree, tags }], edges: [{ source, target }] }.
   */
  function buildGraph(notes, notesCore, { includeOrphans = true } = {}) {
    const { fold, extractLinks } = notesCore;
    const active = (notes || []).filter(n => n && !n.deleted_at);
    const nodes = [];
    const byKey = {};
    const addNode = (key, data) => {
      if (!byKey[key]) { byKey[key] = { id: key, degree: 0, ...data }; nodes.push(byKey[key]); }
      return byKey[key];
    };
    active.forEach(n => {
      const title = String(n.title || '').trim();
      // Sin título no se puede enlazar, pero se muestra (puede enlazar a otros).
      addNode(title ? `t:${fold(title)}` : `n:${n.id}`, { title: title || 'Sin título', noteId: n.id, missing: false, tags: n.tags || [] });
    });
    const edges = [];
    const seen = new Set();
    active.forEach(n => {
      const title = String(n.title || '').trim();
      const from = title ? `t:${fold(title)}` : `n:${n.id}`;
      extractLinks(n.content).forEach(t => {
        const to = `t:${fold(t)}`;
        if (to === from) return;
        addNode(to, { title: t, noteId: null, missing: true, tags: [] });
        const key = from < to ? `${from}|${to}` : `${to}|${from}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({ source: from, target: to });
        byKey[from].degree++;
        byKey[to].degree++;
      });
    });
    const keep = includeOrphans ? nodes : nodes.filter(nd => nd.degree > 0);
    return { nodes: keep, edges };
  }

  /** Vecinos directos de un nodo (para resaltar al pasar el ratón). */
  function neighbors(graph, id) {
    const out = new Set();
    graph.edges.forEach(e => {
      if (e.source === id) out.add(e.target);
      if (e.target === id) out.add(e.source);
    });
    return out;
  }

  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
  }

  /** Estado de la simulación: posiciones iniciales en espiral (estable, sin solaparse). */
  function createLayout(graph, { width = 800, height = 600, seed = 7 } = {}) {
    const rand = rng(seed);
    const cx = width / 2;
    const cy = height / 2;
    const pos = {};
    graph.nodes.forEach((n, i) => {
      const angle = i * 2.399963; // ángulo áureo
      const r = 18 * Math.sqrt(i + 1);
      pos[n.id] = { x: cx + r * Math.cos(angle) + rand() - 0.5, y: cy + r * Math.sin(angle) + rand() - 0.5, vx: 0, vy: 0, fixed: false };
    });
    return { graph, pos, width, height, alpha: 1 };
  }

  /** Un paso de la simulación. Devuelve el alpha restante (0 = quieto). */
  function step(state, { repulsion = 7000, springLength = 130, springK = 0.05, gravity = 0.01, damping = 0.82 } = {}) {
    const { graph, pos, width, height } = state;
    const ids = graph.nodes.map(n => n.id);
    const a = state.alpha;
    const fx = {};
    const fy = {};
    ids.forEach(id => { fx[id] = 0; fy[id] = 0; });

    for (let i = 0; i < ids.length; i++) {
      const p = pos[ids[i]];
      for (let j = i + 1; j < ids.length; j++) {
        const q = pos[ids[j]];
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = 0.1 * (i - j); dy = 0.1; d2 = dx * dx + dy * dy; }
        const f = repulsion / d2;
        const d = Math.sqrt(d2);
        fx[ids[i]] += (dx / d) * f; fy[ids[i]] += (dy / d) * f;
        fx[ids[j]] -= (dx / d) * f; fy[ids[j]] -= (dy / d) * f;
      }
    }
    graph.edges.forEach(e => {
      const p = pos[e.source];
      const q = pos[e.target];
      if (!p || !q) return;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = springK * (d - springLength);
      fx[e.source] += (dx / d) * f; fy[e.source] += (dy / d) * f;
      fx[e.target] -= (dx / d) * f; fy[e.target] -= (dy / d) * f;
    });
    ids.forEach(id => {
      const p = pos[id];
      fx[id] += (width / 2 - p.x) * gravity;
      fy[id] += (height / 2 - p.y) * gravity;
      if (p.fixed) { p.vx = 0; p.vy = 0; return; }
      p.vx = (p.vx + fx[id] * a) * damping;
      p.vy = (p.vy + fy[id] * a) * damping;
      // Límite de velocidad para que nada salga disparado.
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (v > 30) { p.vx *= 30 / v; p.vy *= 30 / v; }
      p.x += p.vx;
      p.y += p.vy;
    });
    state.alpha = Math.max(0, a * 0.985 - 0.001);
    return state.alpha;
  }

  function run(state, iterations = 300) {
    for (let i = 0; i < iterations && state.alpha > 0; i++) step(state);
    return state;
  }

  /** Caja que contiene todos los nodos (para encuadrar la vista). */
  function bounds(state, margin = 40) {
    const ps = Object.values(state.pos);
    if (!ps.length) return { x: 0, y: 0, w: state.width, h: state.height };
    const xs = ps.map(p => p.x);
    const ys = ps.map(p => p.y);
    const x = Math.min(...xs) - margin;
    const y = Math.min(...ys) - margin;
    return { x, y, w: Math.max(...xs) + margin - x, h: Math.max(...ys) + margin - y };
  }

  return { buildGraph, neighbors, createLayout, step, run, bounds };
});
