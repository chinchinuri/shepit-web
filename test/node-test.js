// Runs the browser engine (same wasm + recognizer-core.js) under Node.js on the
// model's test recordings: checks the text and reports speed vs real time.
// Usage: node test/node-test.js <model-dir>
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const modelDir = path.resolve(process.argv[2]);
const engineDir = path.resolve(__dirname, '../web/engine');

function readWav(file) {
  const buf = fs.readFileSync(file);
  // Find the "data" chunk.
  let off = 12;
  let sr = 16000;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') sr = buf.readUInt32LE(off + 12);
    if (id === 'data') {
      const n = size / 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return { samples: out, sr };
    }
    off += 8 + size;
  }
  throw new Error('no data chunk');
}

globalThis.Module = {
  locateFile: (p) => path.join(engineDir, p),
  print: () => {},
  printErr: (t) => console.error('[engine]', t),
};

const started = new Promise((resolve) => { globalThis.Module.onRuntimeInitialized = resolve; });
const { createOnlineRecognizer } = require(path.join(engineDir, 'sherpa-onnx-asr.js'));
globalThis.createOnlineRecognizer = createOnlineRecognizer;
// Emscripten's non-modular output must run as a global script so it picks up
// globalThis.Module (as in the browser worker).
globalThis.require = require;
globalThis.__dirname = engineDir;
globalThis.__filename = path.join(engineDir, 'sherpa-onnx-wasm-main-asr.js');
vm.runInThisContext(fs.readFileSync(globalThis.__filename, 'utf8'), { filename: globalThis.__filename });
vm.runInThisContext(fs.readFileSync(path.resolve(__dirname, '../web/js/recognizer-core.js'), 'utf8')
  .replace(/^const /gm, 'var ').replace(/^class (\w+)/m, 'globalThis.$1 = class $1'));

(async () => {
  await started;
  const M = globalThis.Module;
  M.FS.mkdir('/model');
  M.FS.mount(M.FS.filesystems.NODEFS, { root: modelDir }, '/model');

  let t0 = Date.now();
  const t = new globalThis.StreamingTranscriber(M, '/model', { language: 'auto', maxPhraseSec: 25 });
  console.log(`model load: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  let totalAudio = 0;
  let totalWall = 0;
  let ukText = '';
  for (const lang of ['de', 'es', 'fr', 'ja', 'uk']) {
    const { samples, sr } = readWav(path.join(modelDir, 'test_wavs', `${lang}.wav`));
    if (sr !== 16000) throw new Error(`${lang}.wav is ${sr} Hz`);
    t0 = Date.now();
    const finals = [];
    // Same block size as the microphone path (~64 ms) to exercise streaming.
    const block = 1024;
    for (let i = 0; i < samples.length; i += block) {
      const { final } = t.accept(samples.subarray(i, i + block));
      if (final) finals.push(final);
    }
    const last = t.finish();
    if (last) finals.push(last);
    const wall = (Date.now() - t0) / 1000;
    const audio = samples.length / 16000;
    totalAudio += audio;
    totalWall += wall;
    const text = finals.map((f) => f.text).join(' ');
    if (lang === 'uk') ukText = text;
    console.log(`${lang}: ${audio.toFixed(1)} s audio in ${wall.toFixed(1)} s (x${(audio / wall).toFixed(2)}) → ${text}`);
  }
  console.log(`SPEED: ${(totalAudio / totalWall).toFixed(2)}x real time (single thread, this CPU)`);
  if (!/країн/i.test(ukText)) throw new Error('Ukrainian sample not recognised');

  // Fixed language and switching mid-stream.
  t.setLanguage('uk');
  const { samples } = readWav(path.join(modelDir, 'test_wavs', 'uk.wav'));
  for (let i = 0; i < samples.length; i += 8000) t.accept(samples.subarray(i, i + 8000));
  const f = t.finish();
  console.log('uk fixed:', f && f.text);
  t.free();
  console.log('NODE TEST OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
