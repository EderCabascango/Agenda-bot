/**
 * test_ambient_core.js
 * Tests unitarios con node:test para web/ambient-core.js (Fase F: sonidos ambientales).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const AmbientCore = require('./ambient-core.js');

// Generador determinista (LCG) para que los tests sean reproducibles.
function seededRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const meanAbsDiff = (arr) => {
  let sum = 0;
  for (let i = 1; i < arr.length; i++) sum += Math.abs(arr[i] - arr[i - 1]);
  return sum / (arr.length - 1);
};
const rms = (arr) => Math.sqrt(arr.reduce((a, v) => a + v * v, 0) / arr.length);

test('AmbientCore - Generación de sonidos ambientales', async (t) => {

  await t.test('1. Catálogo: sin sonido, ruido blanco, rosa, marrón y lluvia', () => {
    assert.deepEqual(AmbientCore.SOUND_IDS, ['none', 'white', 'pink', 'brown', 'rain']);
  });

  await t.test('2. Todas las muestras quedan en [-1, 1], tienen la longitud pedida y no están en silencio', () => {
    for (const type of ['white', 'pink', 'brown', 'rain']) {
      const data = AmbientCore.generateNoise(type, 44100, 44100, seededRng(7));
      assert.equal(data.length, 44100, type);
      assert.ok(data.every(v => v >= -1 && v <= 1), `${type} fuera de rango`);
      assert.ok(rms(data) > 0.01, `${type} no debe ser silencio`);
    }
  });

  await t.test('3. El color del ruido se nota: marrón y rosa varían más suave que el blanco', () => {
    const white = AmbientCore.generateNoise('white', 20000, 44100, seededRng(1));
    const pink = AmbientCore.generateNoise('pink', 20000, 44100, seededRng(1));
    const brown = AmbientCore.generateNoise('brown', 20000, 44100, seededRng(1));
    const smooth = (a) => meanAbsDiff(a) / rms(a);
    assert.ok(smooth(brown) < smooth(pink), 'el marrón debe ser más suave que el rosa');
    assert.ok(smooth(pink) < smooth(white), 'el rosa debe ser más suave que el blanco');
  });

  await t.test('4. "none" y tipos desconocidos devuelven silencio; es determinista con el mismo rng', () => {
    assert.ok(AmbientCore.generateNoise('none', 100).every(v => v === 0));
    assert.ok(AmbientCore.generateNoise('cafe', 100).every(v => v === 0));
    const a = AmbientCore.generateNoise('rain', 5000, 44100, seededRng(3));
    const b = AmbientCore.generateNoise('rain', 5000, 44100, seededRng(3));
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  await t.test('5. El reproductor crea un bucle, cambia de sonido, ajusta volumen y se detiene', () => {
    const started = [];
    class FakeCtx {
      constructor() { this.sampleRate = 8000; this.state = 'running'; this.destination = {}; }
      createGain() { return { gain: { value: 0 }, connect() {} }; }
      createBuffer(ch, len) { const data = new Float32Array(len); return { getChannelData: () => data }; }
      createBufferSource() {
        return { loop: false, connect() {}, disconnect() {}, start() { started.push(this); this.playing = true; }, stop() { this.playing = false; } };
      }
    }
    const player = AmbientCore.createAmbientPlayer(FakeCtx);
    assert.equal(player.play('rain'), true);
    assert.equal(player.current, 'rain');
    assert.equal(started[0].loop, true);
    assert.equal(player.play('rain'), true, 'repetir el mismo sonido no reinicia');
    assert.equal(started.length, 1);

    player.play('brown');
    assert.equal(started.length, 2);
    assert.equal(started[0].playing, false, 'el sonido anterior se detiene al cambiar');

    player.setVolume(2);
    assert.equal(player.volume, 1);
    player.play('none');
    assert.equal(player.current, 'none');
    assert.equal(started[1].playing, false);
  });
});
