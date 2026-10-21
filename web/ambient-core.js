/**
 * ambient-core.js
 * Sonidos ambientales para el enfoque (Fase F), generados con WebAudio: sin archivos ni internet.
 * - generateNoise(): lógica pura y determinista con rng inyectable (probada en Node).
 * - createAmbientPlayer(): reproductor para el navegador (bucle, volumen, cambio de sonido).
 * Compatible con Node.js (CommonJS) y navegadores web (UMD / Global).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AmbientCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const SOUNDS = [
    { id: 'none', label: 'Sin sonido' },
    { id: 'white', label: 'Ruido blanco' },
    { id: 'pink', label: 'Ruido rosa' },
    { id: 'brown', label: 'Ruido marrón' },
    { id: 'rain', label: 'Lluvia' },
    { id: 'ocean', label: 'Olas del mar' },
    { id: 'om', label: 'Tono profundo (OM)' }
  ];
  const SOUND_IDS = SOUNDS.map(s => s.id);

  /**
   * Devuelve un Float32Array de `length` muestras en [-1, 1] del tipo pedido.
   * white: espectro plano · pink: -3 dB/oct (filtro de Paul Kellet) · brown: -6 dB/oct (integración)
   * rain: ruido rosa con ráfagas suaves y gotas aleatorias.
   * ocean: ruido marrón que sube y baja como olas (2 olas por bucle).
   * om: tono grave (~136 Hz) con armónicos y un vaivén lento; ciclos enteros para que el bucle no "salte".
   */
  function generateNoise(type, length, sampleRate = 44100, rng = Math.random) {
    const out = new Float32Array(Math.max(0, length | 0));
    if (!SOUND_IDS.includes(type) || type === 'none') return out;
    if (type === 'om') return generateDrone(out, sampleRate);

    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let brown = 0;
    let drop = 0;
    for (let i = 0; i < out.length; i++) {
      const white = rng() * 2 - 1;
      let v;
      if (type === 'white') {
        v = white * 0.5;
      } else if (type === 'brown' || type === 'ocean') {
        brown = (brown + 0.02 * white) / 1.02;
        v = brown * 3.5;
        if (type === 'ocean') {
          // Ola: sube despacio, rompe y se retira; nunca llega a silencio total.
          const phase = ((2 * i) / out.length) % 1;
          const swell = Math.pow(Math.sin(Math.PI * phase), 2);
          v = brown * (1.2 + 3.6 * swell) + white * 0.06 * swell;
        }
      } else {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
        if (type === 'pink') {
          v = pink;
        } else {
          // Lluvia: rosa con una ondulación lenta (ráfagas) y gotas que decaen rápido.
          const gust = 0.75 + 0.25 * Math.sin((2 * Math.PI * i) / (sampleRate * 3.7));
          if (rng() < 12 / sampleRate) drop = 0.6 + rng() * 0.4;
          drop *= 0.9985;
          v = pink * gust + drop * white * 0.35;
        }
      }
      out[i] = Math.max(-1, Math.min(1, v));
    }
    return out;
  }

  function generateDrone(out, sampleRate) {
    const seconds = out.length / sampleRate;
    if (!seconds) return out;
    // Frecuencias con un número entero de ciclos en el búfer: el bucle empalma sin clics.
    const cycles = Math.max(1, Math.round(136.1 * seconds));
    const f0 = cycles / seconds;
    const wobble = 2 / seconds; // dos vaivenes de volumen por bucle
    for (let i = 0; i < out.length; i++) {
      const t = i / sampleRate;
      const tone = Math.sin(2 * Math.PI * f0 * t)
        + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t)
        + 0.25 * Math.sin(2 * Math.PI * 3 * f0 * t)
        + 0.12 * Math.sin(2 * Math.PI * 5 * f0 * t);
      const amp = 0.7 + 0.3 * Math.sin(2 * Math.PI * wobble * t);
      out[i] = Math.max(-1, Math.min(1, tone * amp * 0.32));
    }
    return out;
  }

  /**
   * Campana tibetana: parciales inarmónicos que se apagan despacio (más rápido los agudos).
   * Se usa como gong al empezar y terminar una meditación.
   */
  function generateBell(length, sampleRate = 44100, baseFreq = 220) {
    const out = new Float32Array(Math.max(0, length | 0));
    const partials = [[1, 1, 0.9], [2.76, 0.55, 1.6], [5.4, 0.3, 2.6], [8.93, 0.15, 3.8]];
    for (let i = 0; i < out.length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.01);
      let v = 0;
      for (const [ratio, amp, decay] of partials) {
        v += amp * Math.exp(-decay * t) * Math.sin(2 * Math.PI * baseFreq * ratio * t);
      }
      out[i] = Math.max(-1, Math.min(1, v * attack * 0.45));
    }
    return out;
  }

  /** Reproductor para el navegador. `AudioContextCtor` se inyecta para poder probarlo. */
  function createAmbientPlayer(AudioContextCtor) {
    let ctx = null;
    let source = null;
    let gain = null;
    let current = 'none';
    let volume = 0.4;
    const buffers = {};

    function ensureContext() {
      if (!ctx) {
        const Ctor = AudioContextCtor || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
        if (!Ctor) return null;
        ctx = new Ctor();
        gain = ctx.createGain();
        gain.gain.value = volume;
        gain.connect(ctx.destination);
      }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return ctx;
    }

    function bufferFor(type) {
      if (!buffers[type]) {
        const seconds = 8; // bucle largo para que no se note la repetición
        const data = generateNoise(type, ctx.sampleRate * seconds, ctx.sampleRate);
        const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
        buf.getChannelData(0).set(data);
        buffers[type] = buf;
      }
      return buffers[type];
    }

    function stop() {
      if (source) {
        try { source.stop(); } catch (e) { /* ya detenido */ }
        source.disconnect();
        source = null;
      }
      current = 'none';
    }

    function play(type) {
      if (!SOUND_IDS.includes(type) || type === 'none') { stop(); return false; }
      if (type === current && source) return true;
      if (!ensureContext()) return false;
      stop();
      source = ctx.createBufferSource();
      source.buffer = bufferFor(type);
      source.loop = true;
      source.connect(gain);
      source.start();
      current = type;
      return true;
    }

    function setVolume(v) {
      volume = Math.max(0, Math.min(1, Number(v) || 0));
      if (gain) gain.gain.value = volume;
    }

    // Los navegadores crean el audio "suspendido" si no hubo un clic; se reanuda con el siguiente gesto.
    function unlock() {
      if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
    }

    // Toque de campana (no en bucle), por encima del sonido de fondo.
    let bellBuffer = null;
    function bell() {
      if (!ensureContext()) return false;
      if (!bellBuffer) {
        const data = generateBell(ctx.sampleRate * 6, ctx.sampleRate);
        bellBuffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
        bellBuffer.getChannelData(0).set(data);
      }
      const src = ctx.createBufferSource();
      src.buffer = bellBuffer;
      src.connect(ctx.destination);
      src.start();
      return true;
    }

    return { play, stop, setVolume, unlock, bell, get current() { return current; }, get volume() { return volume; } };
  }

  return { SOUNDS, SOUND_IDS, generateNoise, generateBell, createAmbientPlayer };
});
