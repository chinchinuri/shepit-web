// Shepit Web — main thread: recorder, file import, archive (IndexedDB), UI.
// All recognition runs in js/asr-worker.js; nothing leaves the browser except the
// one-time model download from Hugging Face.

const MODEL_BASE = 'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/main';
const MODEL_FILES = ['tokens.txt', 'decoder.int8.onnx', 'joiner.int8.onnx', 'encoder.int8.onnx'];
const SR = 16000;

const LANGS = [
  ['auto', 'Автовизначення'], ['uk', 'Українська'], ['en', 'Англійська'], ['ru', 'Російська'],
  ['pl', 'Польська'], ['de', 'Німецька'], ['fr', 'Французька'], ['es', 'Іспанська'],
  ['it', 'Італійська'], ['pt', 'Португальська'], ['nl', 'Нідерландська'], ['cs', 'Чеська'],
  ['sk', 'Словацька'], ['ro', 'Румунська'], ['hu', 'Угорська'], ['bg', 'Болгарська'],
  ['lt', 'Литовська'], ['lv', 'Латиська'], ['et', 'Естонська'], ['fi', 'Фінська'],
  ['sv', 'Шведська'], ['da', 'Данська'], ['el', 'Грецька'], ['tr', 'Турецька'],
  ['ka', 'Грузинська'], ['he', 'Іврит'], ['ar', 'Арабська'], ['zh', 'Китайська'],
  ['ja', 'Японська'], ['ko', 'Корейська'], ['vi', "В'єтнамська"],
];

const $ = (id) => document.getElementById(id);
const el = {
  language: $('language'), engineState: $('engine-state'),
  setup: $('setup'), loadModel: $('load-model'), modelProgress: $('model-progress'),
  recorder: $('recorder'), record: $('record'), pause: $('pause'), stop: $('stop'),
  timer: $('timer'), wave: $('wave'), pace: $('pace'),
  sheet: $('sheet'), sheetTitle: $('sheet-title'), sheetMeta: $('sheet-meta'),
  lines: $('lines'), partial: $('partial'), player: $('player'), actions: $('sheet-actions'),
  fileProgress: $('file-progress'), cancelFile: $('cancel-file'), del: $('delete'),
  recordings: $('recordings'), recordingsEmpty: $('recordings-empty'),
  fileInput: $('file-input'), error: $('error'),
};

/* ---------- helpers ---------- */

function fmtTime(ms, withHours = false) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 || withHours ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function srtTime(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function showError(text) {
  el.error.textContent = text;
  el.error.hidden = !text;
}

function langName(code) {
  return (LANGS.find(([c]) => c === code) || [code, code])[1];
}

/* ---------- storage (IndexedDB) ---------- */

const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open('shepit-web', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('recordings', { keyPath: 'id' });
    req.result.createObjectStore('audio');
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const saveRecording = (rec) => tx('recordings', 'readwrite', (s) => s.put(rec));
const allRecordings = () => tx('recordings', 'readonly', (s) => s.getAll());
const getRecording = (id) => tx('recordings', 'readonly', (s) => s.get(id));
const saveAudio = (id, blob) => tx('audio', 'readwrite', (s) => s.put(blob, id));
const getAudio = (id) => tx('audio', 'readonly', (s) => s.get(id));
async function deleteRecording(id) {
  await tx('recordings', 'readwrite', (s) => s.delete(id));
  await tx('audio', 'readwrite', (s) => s.delete(id));
}

/* ---------- worker ---------- */

const worker = new Worker('js/asr-worker.js');
const workerHandlers = new Set();
worker.onmessage = (e) => workerHandlers.forEach((h) => h(e.data));
worker.onerror = (e) => showError(`Помилка рушія: ${e.message}`);
const onWorker = (fn) => { workerHandlers.add(fn); return () => workerHandlers.delete(fn); };

let modelReady = false;

function setEngineState(state, text) {
  el.engineState.dataset.state = state;
  el.engineState.textContent = text;
}

function loadModel() {
  el.loadModel.disabled = true;
  el.modelProgress.hidden = false;
  setEngineState('loading', 'Завантаження моделі…');
  navigator.storage?.persist?.();
  worker.postMessage({ type: 'load', baseUrl: MODEL_BASE, language: el.language.value });
}

onWorker((m) => {
  const fill = el.modelProgress.querySelector('.fill');
  const text = el.modelProgress.querySelector('.progress-text');
  if (m.type === 'model-progress') {
    const pct = m.total ? Math.min(100, (m.done / m.total) * 100) : 0;
    fill.style.width = `${pct}%`;
    text.textContent = `${Math.round(m.done / 1048576)} з ${Math.round(m.total / 1048576)} МБ`;
  } else if (m.type === 'model-status') {
    fill.style.width = '100%';
    text.textContent = m.text;
    setEngineState('loading', m.text);
  } else if (m.type === 'model-warning') {
    showError(m.text);
  } else if (m.type === 'model-ready') {
    modelReady = true;
    setEngineState('ready', 'Модель готова');
    el.setup.hidden = true;
    el.recorder.hidden = false;
    el.record.disabled = false;
  } else if (m.type === 'error') {
    if (m.context === 'load') {
      el.loadModel.disabled = false;
      setEngineState('off', 'Модель не завантажена');
      showError(`${m.message}. Перевірте з'єднання й спробуйте ще раз. Якщо помилка про пам'ять — закрийте інші вкладки.`);
    } else {
      showError(m.message);
    }
  }
});

async function modelIsCached() {
  if (!('caches' in self)) return false;
  const cache = await caches.open('shepit-model-v1');
  for (const f of MODEL_FILES) {
    if (!(await cache.match(`${MODEL_BASE}/${f}`))) return false;
  }
  return true;
}

/* ---------- transcript sheet ---------- */

let current = null; // recording shown on the sheet

function lineEl(seg, index) {
  const li = document.createElement('li');
  li.dataset.start = seg.start;
  li.dataset.end = seg.end;
  const time = document.createElement('time');
  time.textContent = fmtTime(seg.start);
  time.title = 'Відтворити з цього місця';
  time.addEventListener('click', () => playFrom(seg.start));
  const text = document.createElement('span');
  text.className = 't';
  text.textContent = seg.text;
  if (index != null) {
    text.contentEditable = 'true';
    text.spellcheck = true;
    text.addEventListener('blur', async () => {
      if (!current || current.segments[index].text === text.textContent.trim()) return;
      current.segments[index].text = text.textContent.trim();
      await saveRecording(current);
    });
  }
  li.append(time, text);
  return li;
}

function appendLine(seg, index) {
  el.lines.querySelector('.empty-sheet')?.remove();
  el.lines.append(lineEl(seg, index));
  el.partial.scrollIntoView({ block: 'nearest' });
}

async function openRecording(id) {
  const rec = await getRecording(id);
  if (!rec) return;
  current = rec;
  el.sheet.hidden = false;
  el.sheetTitle.textContent = rec.title;
  el.sheetMeta.textContent = `${fmtDate(rec.createdAt)} · ${fmtTime(rec.durationMs)} · ${langName(rec.language)}`;
  el.lines.replaceChildren();
  rec.segments.forEach((s, i) => el.lines.append(lineEl(s, i)));
  if (!rec.segments.length) {
    const p = document.createElement('p');
    p.className = 'empty-sheet';
    p.textContent = rec.status === 'processing' ? 'Розпізнавання не завершилося.' : 'Мовлення не виявлено.';
    el.lines.append(p);
  }
  el.partial.textContent = '';
  el.actions.hidden = false;
  const blob = await getAudio(id);
  if (el.player.src) URL.revokeObjectURL(el.player.src);
  el.player.src = blob ? URL.createObjectURL(blob) : '';
  el.player.hidden = !blob;
  renderList();
}

function playFrom(ms) {
  if (el.player.hidden || !el.player.src) return;
  el.player.currentTime = ms / 1000;
  el.player.play();
}

el.player.addEventListener('timeupdate', () => {
  const ms = el.player.currentTime * 1000;
  for (const li of el.lines.children) {
    li.classList.toggle('playing', ms >= Number(li.dataset.start) && ms < Number(li.dataset.end));
  }
});

el.sheetTitle.addEventListener('blur', async () => {
  if (!current) return;
  const t = el.sheetTitle.textContent.trim();
  if (t && t !== current.title) {
    current.title = t;
    await saveRecording(current);
    renderList();
  }
});
el.sheetTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.sheetTitle.blur(); }
});

/* ---------- archive list ---------- */

async function renderList() {
  const recs = (await allRecordings()).sort((a, b) => b.createdAt - a.createdAt);
  el.recordingsEmpty.hidden = recs.length > 0;
  el.recordings.replaceChildren(...recs.map((r) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    if (current && current.id === r.id) b.setAttribute('aria-current', 'true');
    const t = document.createElement('span');
    t.className = 'r-title';
    t.textContent = r.title;
    const m = document.createElement('span');
    m.className = 'r-meta';
    m.textContent = `${fmtDate(r.createdAt)} · ${fmtTime(r.durationMs)}`;
    b.append(t, m);
    b.addEventListener('click', () => { if (!busy()) openRecording(r.id); });
    li.append(b);
    return li;
  }));
}

/* ---------- exports ---------- */

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function plainText(rec) {
  // A new paragraph after a pause longer than 2 s.
  let out = '';
  let prevEnd = -1;
  for (const s of rec.segments) {
    if (prevEnd >= 0) out += s.start - prevEnd > 2000 ? '\n\n' : ' ';
    out += s.text;
    prevEnd = s.end;
  }
  return out;
}

function srt(rec) {
  return rec.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n');
}

const safeName = (t) => t.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

el.actions.addEventListener('click', async (e) => {
  const kind = e.target.dataset?.export;
  if (!kind || !current) return;
  if (kind === 'txt') download(`${safeName(current.title)}.txt`, new Blob([plainText(current)], { type: 'text/plain' }));
  if (kind === 'srt') download(`${safeName(current.title)}.srt`, new Blob([srt(current)], { type: 'application/x-subrip' }));
  if (kind === 'copy') {
    await navigator.clipboard.writeText(plainText(current));
    e.target.textContent = 'Скопійовано';
    setTimeout(() => { e.target.textContent = 'Копіювати текст'; }, 1500);
  }
  if (kind === 'audio') {
    const blob = await getAudio(current.id);
    if (blob) download(`${safeName(current.title)}.${current.audioExt || 'wav'}`, blob);
  }
});

el.del.addEventListener('click', async () => {
  if (!current || !confirm(`Видалити «${current.title}» разом з аудіо та текстом?`)) return;
  await deleteRecording(current.id);
  current = null;
  el.sheet.hidden = true;
  renderList();
});

/* ---------- live recording ---------- */

let rec = null; // active recording session

const busy = () => Boolean(rec) || Boolean(fileJob);

function makeResampler(inRate) {
  const step = inRate / SR;
  let pos = 0;
  let prev = 0;
  return (input) => {
    const out = new Float32Array(Math.ceil((input.length - pos) / step) + 1);
    let n = 0;
    while (true) {
      const i = Math.floor(pos);
      if (i + 1 >= input.length) break;
      const a = i < 0 ? prev : input[i];
      out[n++] = a + (input[i + 1] - a) * (pos - i);
      pos += step;
    }
    pos -= input.length;
    prev = input[input.length - 1];
    return out.subarray(0, n);
  };
}

function encodeWav(chunks, totalSamples) {
  const buf = new ArrayBuffer(44 + totalSamples * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + totalSamples * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, totalSamples * 2, true);
  let off = 44;
  for (const c of chunks) {
    new Int16Array(buf, off, c.length).set(c);
    off += c.length * 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function drawWave(samples) {
  const c = el.wave;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  ctx.drawImage(c, -4, 0); // scroll left
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const bar = Math.max(2, Math.min(h, Math.sqrt(peak) * h * 1.4));
  ctx.clearRect(w - 4, 0, 4, h);
  ctx.fillStyle = rec && !rec.paused ? '#d7263d' : '#9aa5b1';
  ctx.fillRect(w - 3, (h - bar) / 2, 2, bar);
}

async function startRecording() {
  showError('');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch (e) {
    showError('Немає доступу до мікрофона. Дозвольте його в адресному рядку браузера й спробуйте ще раз.');
    return;
  }
  el.wave.width = Math.max(100, Math.round(el.wave.clientWidth * (window.devicePixelRatio || 1)));
  el.wave.height = Math.round(48 * (window.devicePixelRatio || 1));
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('js/capture-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture-processor');
  source.connect(node);

  const id = crypto.randomUUID();
  rec = {
    id, stream, ctx, node, paused: false, chunks: [], samples: 0,
    segments: [], pendingMs: 0, busyMs: 0, audioMs: 0,
    resample: makeResampler(ctx.sampleRate),
    language: el.language.value,
    wakeLock: await navigator.wakeLock?.request?.('screen').catch(() => null),
  };
  current = {
    id, title: `Запис від ${fmtDate(Date.now())}`, createdAt: Date.now(), durationMs: 0,
    language: rec.language, segments: rec.segments, status: 'recording', source: 'mic', audioExt: 'wav',
  };
  el.sheet.hidden = false;
  el.sheetTitle.textContent = current.title;
  el.sheetMeta.textContent = 'Йде запис…';
  el.lines.replaceChildren();
  el.partial.textContent = '';
  el.actions.hidden = true;
  el.player.hidden = true;

  worker.postMessage({ type: 'live-start', language: rec.language });
  node.port.onmessage = (e) => {
    if (!rec || rec.paused) return;
    const pcm16k = rec.resample(e.data);
    const int16 = new Int16Array(pcm16k.length);
    for (let i = 0; i < pcm16k.length; i++) int16[i] = Math.max(-32768, Math.min(32767, pcm16k[i] * 32767));
    rec.chunks.push(int16);
    rec.samples += pcm16k.length;
    el.timer.textContent = fmtTime((rec.samples / SR) * 1000);
    drawWave(pcm16k);
    rec.pendingMs += (pcm16k.length / SR) * 1000;
    worker.postMessage({ type: 'live-audio', samples: pcm16k }, [pcm16k.buffer]);
  };

  el.record.setAttribute('aria-pressed', 'true');
  el.record.setAttribute('aria-label', 'Зупинити запис');
  el.pause.disabled = false;
  el.stop.disabled = false;
  el.fileInput.disabled = true;
}

onWorker((m) => {
  if (m.type !== 'live-result' || !rec) return;
  if (m.audioMs) {
    rec.pendingMs = Math.max(0, rec.pendingMs - m.audioMs);
    rec.busyMs += m.busyMs;
    rec.audioMs += m.audioMs;
  }
  if (m.final) {
    rec.segments.push(m.final);
    appendLine(m.final, rec.segments.length - 1);
  }
  el.partial.textContent = m.partial || '';
  updatePace();
  if (m.flushed && rec.onFlushed) rec.onFlushed();
});

function updatePace() {
  if (!rec || rec.audioMs < 3000) return;
  const load = rec.busyMs / rec.audioMs; // < 1 = keeps up
  const behind = rec.pendingMs / 1000;
  if (behind > 4) {
    el.pace.dataset.warn = '';
    el.pace.textContent = `Розпізнавання відстає на ${Math.round(behind)} с — запис іде повністю, текст наздожене після зупинки.`;
  } else {
    delete el.pace.dataset.warn;
    el.pace.textContent = `Розпізнавання встигає: використовує ${Math.round(load * 100)}% часу процесора.`;
  }
}

function togglePause() {
  if (!rec) return;
  rec.paused = !rec.paused;
  el.pause.textContent = rec.paused ? 'Продовжити' : 'Пауза';
  if (rec.paused) {
    worker.postMessage({ type: 'live-flush', timelineMs: (rec.samples / SR) * 1000 });
    rec.ctx.suspend();
  } else {
    rec.ctx.resume();
  }
}

async function stopRecording() {
  if (!rec) return;
  const r = rec;
  r.paused = true;
  el.stop.disabled = true;
  el.pause.disabled = true;
  el.sheetMeta.textContent = 'Завершення розпізнавання…';
  r.node.port.onmessage = null;
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close();
  r.wakeLock?.release?.();
  // Wait until the worker has worked through the backlog and flushed the last phrase.
  await new Promise((resolve) => {
    r.onFlushed = resolve;
    worker.postMessage({ type: 'live-flush' });
  });
  el.partial.textContent = '';
  current.durationMs = Math.round((r.samples / SR) * 1000);
  current.status = 'done';
  await saveAudio(current.id, encodeWav(r.chunks, r.samples));
  await saveRecording(current);
  rec = null;
  el.record.setAttribute('aria-pressed', 'false');
  el.record.setAttribute('aria-label', 'Почати запис');
  el.pause.textContent = 'Пауза';
  el.timer.textContent = '0:00';
  el.wave.getContext('2d').clearRect(0, 0, el.wave.width, el.wave.height);
  el.pace.textContent = '';
  el.fileInput.disabled = false;
  await openRecording(current.id);
}

el.record.addEventListener('click', () => (rec ? stopRecording() : startRecording()));
el.pause.addEventListener('click', togglePause);
el.stop.addEventListener('click', stopRecording);

/* ---------- file transcription ---------- */

let fileJob = null;

async function decodeTo16k(file) {
  const data = await file.arrayBuffer();
  el.wave.width = Math.max(100, Math.round(el.wave.clientWidth * (window.devicePixelRatio || 1)));
  el.wave.height = Math.round(48 * (window.devicePixelRatio || 1));
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    ctx.close();
  }
  const length = Math.ceil(decoded.duration * SR);
  const off = new OfflineAudioContext(1, length, SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

async function transcribeFile(file) {
  if (!modelReady) { showError('Спершу завантажте модель.'); return; }
  showError('');
  let samples;
  try {
    el.sheet.hidden = false;
    el.sheetTitle.textContent = file.name;
    el.sheetMeta.textContent = 'Читання файлу…';
    el.lines.replaceChildren();
    el.actions.hidden = true;
    el.player.hidden = true;
    samples = await decodeTo16k(file);
  } catch (e) {
    showError('Браузер не зміг прочитати аудіо з цього файлу. Спробуйте MP3, M4A, OGG, WAV або MP4.');
    el.sheet.hidden = true;
    return;
  }

  const id = crypto.randomUUID();
  const ext = (file.name.split('.').pop() || 'audio').toLowerCase();
  current = {
    id, title: file.name.replace(/\.[^.]+$/, ''), createdAt: Date.now(),
    durationMs: Math.round((samples.length / SR) * 1000), language: el.language.value,
    segments: [], status: 'processing', source: 'file', audioExt: ext,
  };
  await saveAudio(id, file);
  await saveRecording(current);
  el.sheetTitle.textContent = current.title;
  el.sheetMeta.textContent = `${fmtTime(current.durationMs)} · ${langName(current.language)}`;
  el.fileProgress.hidden = false;
  el.record.disabled = true;
  const fill = el.fileProgress.querySelector('.fill');
  const text = el.fileProgress.querySelector('.progress-text');
  fill.style.width = '0';
  text.textContent = 'Розпізнавання…';

  fileJob = { id };
  const job = current;
  await new Promise((resolve) => {
    const off = onWorker(async (m) => {
      if (m.type === 'file-segment') {
        job.segments.push(m.segment);
        if (current === job) appendLine(m.segment, job.segments.length - 1);
      } else if (m.type === 'file-progress') {
        fill.style.width = `${m.progress * 100}%`;
        const left = m.speed > 0 ? ((1 - m.progress) * job.durationMs) / 1000 / m.speed : 0;
        text.textContent = `${Math.round(m.progress * 100)}% · у ${m.speed.toFixed(1)}× швидше за звучання · лишилось ~${fmtTime(left * 1000)}`;
      } else if (m.type === 'file-done' || m.type === 'file-cancelled' || (m.type === 'error' && m.context === 'file')) {
        off();
        job.status = m.type === 'file-done' ? 'done' : 'processing';
        await saveRecording(job);
        resolve();
      }
    });
    worker.postMessage({ type: 'file', samples, language: job.language }, [samples.buffer]);
  });
  fileJob = null;
  el.fileProgress.hidden = true;
  el.record.disabled = false;
  await openRecording(job.id);
}

el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files[0];
  el.fileInput.value = '';
  if (f && !busy()) transcribeFile(f);
});
el.cancelFile.addEventListener('click', () => worker.postMessage({ type: 'file-cancel' }));

/* ---------- language ---------- */

el.language.append(...LANGS.map(([code, name]) => new Option(name, code)));
el.language.value = localStorage.getItem('shepit-lang') || 'uk';
el.language.addEventListener('change', () => {
  localStorage.setItem('shepit-lang', el.language.value);
  if (rec) {
    rec.language = el.language.value;
    worker.postMessage({ type: 'live-language', language: rec.language });
  }
});

/* ---------- start ---------- */

el.loadModel.addEventListener('click', loadModel);
el.record.disabled = true;
renderList();

if (await modelIsCached()) {
  // Already downloaded once: start the engine straight away.
  el.recorder.hidden = false;
  loadModel();
} else {
  el.setup.hidden = false;
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
