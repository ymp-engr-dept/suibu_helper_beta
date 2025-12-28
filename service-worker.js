const CACHE_NAME = 'suiren-audio-v1';

// キャッシュするファイル（構成にある全てのファイルを指定）
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './module/SpectrumAnalyzer/index.html',
  './module/SpectrumAnalyzer/script.js',
  './module/SpectrumAnalyzer/style.css',
  './module/Tuner/index.html',
  './module/Tuner/script.js',
  './module/Tuner/style.css'
];

// 1. インストール時（キャッシュの保存）
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching all assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  // 即座に有効化
  self.skipWaiting();
});

// 2. 有効化時（古いキャッシュの削除）
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

// 3. フェッチ時（オフライン対応：キャッシュ優先）
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // キャッシュにあればそれを返す
      if (response) {
        return response;
      }
      // なければネットワークに取りに行く
      return fetch(event.request).catch(() => {
        // オフラインでキャッシュにもない場合のエラーハンドリング
        // 必要であればオフライン用のページを返すなどの処理をここに追加
      });
    })
  );
});
