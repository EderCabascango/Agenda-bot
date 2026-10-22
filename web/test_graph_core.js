/**
 * test_graph_core.js
 * Tests unitarios con node:test para web/graph-core.js (grafo de apuntes).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('./graph-core.js');
const NotesCore = require('./notes-core.js');

const NOTES = [
  { id: 'a', title: 'Hábitos', content: '[[Disciplina]] y [[Sistemas]]' },
  { id: 'b', title: 'Disciplina', content: 'vuelve a [[hábitos]]' },
  { id: 'c', title: 'Sistemas', content: '' },
  { id: 'd', title: 'Suelta', content: 'sin enlaces' },
  { id: 'e', title: 'Ideas', content: '[[Libro pendiente]] [[Ideas]]' },
  { id: 'f', title: 'Borrada', content: '[[Hábitos]]', deleted_at: '2026-01-01' },
];

test('GraphCore - Grafo de apuntes', async (t) => {

  await t.test('1. Nodos, aristas sin duplicar, fantasmas y grados', () => {
    const g = G.buildGraph(NOTES, NotesCore);
    const byTitle = Object.fromEntries(g.nodes.map(n => [n.title, n]));
    assert.equal(g.nodes.length, 6, '5 apuntes activos + 1 fantasma');
    assert.equal(g.edges.length, 3, 'a-b se cuenta una vez aunque se enlacen en ambos sentidos; sin auto-enlaces');
    assert.equal(byTitle['Hábitos'].degree, 2);
    assert.equal(byTitle['Libro pendiente'].missing, true);
    assert.equal(byTitle['Libro pendiente'].noteId, null);
    assert.equal(byTitle['Suelta'].degree, 0);
    assert.ok(!g.nodes.some(n => n.title === 'Borrada'), 'los borrados no aparecen');
    assert.equal(G.buildGraph(NOTES, NotesCore, { includeOrphans: false }).nodes.length, 5, 'sin "Suelta"');
  });

  await t.test('2. Vecinos', () => {
    const g = G.buildGraph(NOTES, NotesCore);
    const id = g.nodes.find(n => n.title === 'Hábitos').id;
    assert.deepEqual([...G.neighbors(g, id)].map(x => g.nodes.find(n => n.id === x).title).sort(), ['Disciplina', 'Sistemas']);
  });

  await t.test('3. La simulación converge, separa los nodos y acerca los enlazados', () => {
    const g = G.buildGraph(NOTES, NotesCore);
    const s = G.run(G.createLayout(g, { width: 800, height: 600, seed: 3 }), 600);
    assert.equal(s.alpha, 0, 'se detiene');
    const ps = Object.values(s.pos);
    assert.ok(ps.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    const dist = (x, y) => Math.hypot(s.pos[x].x - s.pos[y].x, s.pos[x].y - s.pos[y].y);
    const ids = g.nodes.map(n => n.id);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      assert.ok(dist(ids[i], ids[j]) > 15, 'ningún par de nodos queda encimado');
    }
    const id = title => g.nodes.find(n => n.title === title).id;
    assert.ok(dist(id('Hábitos'), id('Disciplina')) < dist(id('Disciplina'), id('Suelta')), 'los enlazados quedan más cerca');
    const b = G.bounds(s);
    assert.ok(b.w > 0 && b.h > 0);
  });

  await t.test('4. Determinista con la misma semilla; un nodo fijo no se mueve', () => {
    const g = G.buildGraph(NOTES, NotesCore);
    const a = G.run(G.createLayout(g, { seed: 9 }), 100);
    const b = G.run(G.createLayout(g, { seed: 9 }), 100);
    assert.deepEqual(a.pos, b.pos);
    const s = G.createLayout(g, { seed: 9 });
    const first = g.nodes[0].id;
    s.pos[first].fixed = true;
    const before = { ...s.pos[first] };
    G.run(s, 50);
    assert.equal(s.pos[first].x, before.x);
    assert.equal(s.pos[first].y, before.y);
  });

  await t.test('5. Grafo vacío', () => {
    const g = G.buildGraph([], NotesCore);
    assert.deepEqual(g, { nodes: [], edges: [] });
    const s = G.run(G.createLayout(g), 10);
    assert.deepEqual(G.bounds(s), { x: 0, y: 0, w: 800, h: 600 });
  });
});
