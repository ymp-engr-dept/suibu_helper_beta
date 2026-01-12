// ▼▼▼ ここを更新するたびに書き換える（v1 -> v2 -> v3...） ▼▼▼
const CACHE_NAME = 'suiren-audio-v0.4.10';
// ▲▲▲ これが変わると、ブラウザは「更新がある」と判断します ▲▲▲

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './index.js',
  './index.css',
  './ensemble-processor.js',
  './module/modules.json',
  './module/SpectrumAnalyzer/SpectrumAnalyzer.html',
  './module/SpectrumAnalyzer/SpectrumAnalyzer.js',
  './module/SpectrumAnalyzer/SpectrumAnalyzer.css',
  './module/Tuner/Tuner.html',
  './module/Tuner/Tuner.js',
  './module/Tuner/Tuner.css',
  './module/Metronome/Metronome.html',
  './module/Metronome/Metronome.js',
  './module/Metronome/Metronome.css'
];

self.addEventListener('install', (event) => {
  // インストール処理：新しいファイルをキャッシュする
  console.log('[Service Worker] Installing new version:', CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  // 新しいSWを待機させず、すぐに有効化（スキップ）する
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // アクティベート処理：古いキャッシュを掃除する
  console.log('[Service Worker] Activating...');
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          // 現在のバージョンと違う名前のキャッシュは削除
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  // 全てのクライアント（タブ）を即座に制御下に置く
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // フェッチ処理：キャッシュがあれば返す（ネットワークフォールバック付き）
  // 常に最新が欲しい場合は Network First にする手もあるが、
  // オフライン動作と高速化のためには Cache First が推奨される。
  // 更新は上記のバージョンアップで行う。
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
