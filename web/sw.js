// Shepit Web service worker: keeps the app itself available offline.
// The model is cached separately by the recognition worker.
const VERSION = 'shepit-app-__BUILD__';
const SHELL = [
  './',
  'index.html',
  'css/app.css?v=__BUILD__',
  'js/app.js?v=__BUILD__',
  'js/asr-worker.js',
  'js/recognizer-core.js',
  'js/capture-worklet.js',
  'engine/sherpa-onnx-asr.js',
  'engine/sherpa-onnx-wasm-main-asr.js',
  'engine/sherpa-onnx-wasm-main-asr.wasm',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shepit-app-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // Network first, so a new version shows up at once; cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        if (resp.ok) caches.open(VERSION).then((c) => c.put(e.request, copy));
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: false }).then((r) => r || caches.match('index.html'))),
  );
});
