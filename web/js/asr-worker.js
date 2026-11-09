// Shepit Web — recognition worker. Loads the WebAssembly engine and the Nemotron
// model (cached by the browser after the first download) and runs all recognition
// off the main thread.
/* global Module, StreamingTranscriber, SAMPLE_RATE */

const MODEL_CACHE = 'shepit-model-v1';
// Sizes are only for the progress bar (the real size comes from the server).
const MODEL_FILES = {
  'tokens.txt': 131440,
  'decoder.int8.onnx': 14978075,
  'joiner.int8.onnx': 9504438,
  'encoder.int8.onnx': 657601403,
};
const MODEL_DIR = '/model';

let ready = null;      // Promise resolving when the wasm runtime is up
let modelLoaded = false;
let live = null;       // StreamingTranscriber for the microphone
let fileJob = null;    // { cancelled }

self.Module = {
  locateFile: (path) => `../engine/${path}`,
  print: (t) => console.log('[engine]', t),
  printErr: (t) => console.warn('[engine]', t),
};
ready = new Promise((resolve) => {
  self.Module.onRuntimeInitialized = resolve;
});
importScripts('../engine/sherpa-onnx-asr.js', 'recognizer-core.js', '../engine/sherpa-onnx-wasm-main-asr.js');

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

/** Downloads a file once into Cache Storage (with progress), then returns it as a Blob. */
async function cachedBlob(url, onBytes) {
  const cache = await caches.open(MODEL_CACHE);
  let resp = await cache.match(url);
  if (!resp) {
    const net = await fetch(url);
    if (!net.ok) throw new Error(`Не вдалося завантажити ${url.split('/').pop()}: HTTP ${net.status}`);
    const total = Number(net.headers.get('content-length')) || 0;
    let done = 0;
    // Count bytes on the way to the cache: nothing is held in memory.
    const counted = net.body.pipeThrough(new TransformStream({
      transform(chunk, ctrl) {
        done += chunk.length;
        onBytes(done, total);
        ctrl.enqueue(chunk);
      },
    }));
    await cache.put(url, new Response(counted, { headers: { 'content-length': String(total) } }));
    resp = await cache.match(url);
  } else {
    const size = Number(resp.headers.get('content-length')) || 0;
    onBytes(size, size);
  }
  return resp.blob();
}

async function loadModel(baseUrl) {
  await ready;
  if (modelLoaded) return;
  const FS = Module.FS;
  const blobs = [];
  const expected = Object.values(MODEL_FILES).reduce((a, b) => a + b, 0);
  const doneBy = {};
  let lastPost = 0;
  for (const name of Object.keys(MODEL_FILES)) {
    const blob = await cachedBlob(`${baseUrl}/${name}`, (done) => {
      doneBy[name] = done;
      const now = performance.now();
      if (now - lastPost < 200) return;
      lastPost = now;
      post({
        type: 'model-progress',
        file: name,
        done: Object.values(doneBy).reduce((a, b) => a + b, 0),
        total: expected,
      });
    });
    doneBy[name] = blob.size;
    blobs.push({ name, data: blob });
  }
  post({ type: 'model-status', text: 'Запуск моделі… (до хвилини)' });
  // WORKERFS reads the cached blobs lazily instead of copying 660 MB into memory first.
  try { FS.mkdir(MODEL_DIR); } catch (e) { /* exists */ }
  FS.mount(FS.filesystems.WORKERFS, { blobs }, MODEL_DIR);
  modelLoaded = true;
}

function newTranscriber(language, maxPhraseSec) {
  return new StreamingTranscriber(Module, MODEL_DIR, { language, maxPhraseSec });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function transcribeFile(samples, language) {
  const job = { cancelled: false };
  fileJob = job;
  const t = newTranscriber(language, 25);
  const block = SAMPLE_RATE / 2;
  const started = performance.now();
  try {
    for (let i = 0; i < samples.length; i += block) {
      if (job.cancelled) {
        post({ type: 'file-cancelled' });
        return;
      }
      const { final } = t.accept(samples.subarray(i, Math.min(i + block, samples.length)));
      if (final) post({ type: 'file-segment', segment: final });
      // Every ~10 s of audio, report progress and let cancel messages through.
      if ((i / block) % 20 === 0) {
        const audioSec = i / SAMPLE_RATE;
        const wallSec = (performance.now() - started) / 1000;
        post({ type: 'file-progress', progress: i / samples.length, speed: wallSec > 0 ? audioSec / wallSec : 0 });
        await sleep(0);
      }
    }
    const last = t.finish();
    if (last) post({ type: 'file-segment', segment: last });
    const wallSec = (performance.now() - started) / 1000;
    post({ type: 'file-done', speed: samples.length / SAMPLE_RATE / Math.max(wallSec, 0.001) });
  } finally {
    t.free();
    if (fileJob === job) fileJob = null;
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'load':
        await loadModel(msg.baseUrl);
        // Building the recognizer once here makes the first recording start instantly.
        if (!live) live = newTranscriber(msg.language || 'auto', 20);
        post({ type: 'model-ready' });
        break;
      case 'live-start':
        if (!live) live = newTranscriber(msg.language, 20);
        else live.setLanguage(msg.language);
        live.setTimeline(0);
        break;
      case 'live-audio': {
        const t0 = performance.now();
        const { partial, final } = live.accept(msg.samples);
        const busyMs = performance.now() - t0;
        post({ type: 'live-result', partial, final, busyMs, audioMs: (msg.samples.length * 1000) / SAMPLE_RATE });
        break;
      }
      case 'live-flush': {
        const final = live ? live.finish() : null;
        post({ type: 'live-result', partial: '', final, flushed: true });
        if (msg.timelineMs != null && live) live.setTimeline(msg.timelineMs);
        break;
      }
      case 'live-language': {
        const final = live ? live.setLanguage(msg.language) : null;
        post({ type: 'live-result', partial: '', final });
        break;
      }
      case 'file':
        await transcribeFile(msg.samples, msg.language);
        break;
      case 'file-cancel':
        if (fileJob) fileJob.cancelled = true;
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', context: msg.type, message: String(err && err.message ? err.message : err) });
  }
};
