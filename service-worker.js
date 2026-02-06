// ▼▼▼ ここを更新するたびに書き換える（v1 -> v2 -> v3...） ▼▼▼
const CACHE_NAME = 'suiren-audio-v0.60.14';
// ▲▲▲ これが変わると、ブラウザは「更新がある」と判断します ▲▲▲

// ===== キャッシュ戦略定数 =====
const CACHE_STRATEGIES = {
  CACHE_FIRST: 'cache-first',
  NETWORK_FIRST: 'network-first',
  STALE_WHILE_REVALIDATE: 'stale-while-revalidate'
};

// ===== アセット分類 =====
// SWR戦略: 頻繁に更新されるファイル（キャッシュ返却＋バックグラウンド更新）
const SWR_ASSETS = new Set([
  './index.js',
  './index.css',
  './index.html'
]);

// 通常アセット（軽量・Cache First）
const CORE_ASSETS = [
  './',
  './index.html',
  './index.js',
  './index.css',
  './manifest.json',
  './DownloadIndicatorManager.js',
  './PWAManager.js'
];

// AudioWorkletプロセッサ
const WORKLET_ASSETS = [
  './ensemble-processor.js',
  './audio-core/AudioPipeline.js',
  './audio-core/passthrough-processor.js',
  './audio-core/preprocessor.js',
  './audio-core/PowerManager.js',
  './audio-core/config.js',
  './audio-core/UnifiedPitchEngine.js',
  './audio-core/UnifiedPitchDispatcher.js',
  './audio-core/noise-reduction/spectral-subtraction-worklet.js',
  './audio-core/noise-reduction/NoiseReductionManager.js'
];

// ピッチ検出システム（5層アーキテクチャコンポーネント）
const PITCH_DETECTION_ASSETS = [
  './audio-core/pitch-detection/utils/PitchUtils.js',
  './audio-core/pitch-detection/postprocessing/PostProcessing.js',
  './audio-core/pitch-detection/algorithms/PitchAlgorithms.js',
  './audio-core/pitch-detection/algorithms/AdvancedAlgorithms.js',
  './audio-core/pitch-detection/AdaptiveTrackingFilter.js',
  './audio-core/pitch-detection/NeuralLoaders.js',
  './audio-core/pitch-detection/CREPELargeEngine.js',
  './audio-core/pitch-detection/layers/Layer1_CQT.js',
  './audio-core/pitch-detection/layers/Layer3_Ensemble.js',
  './audio-core/pitch-detection/layers/Layer4_SuperResolution.js',
  './audio-core/pitch-detection/layers/Layer5_Strobe.js'
];

// UIモジュール
const MODULE_ASSETS = [
  './module/modules.json',
  './module/SpectrumAnalyzer/SpectrumAnalyzer.html',
  './module/SpectrumAnalyzer/SpectrumAnalyzer.js',
  './module/SpectrumAnalyzer/SpectrumAnalyzer.css',
  './module/Tuner/Tuner.html',
  './module/Tuner/Tuner.js',
  './module/Tuner/Tuner.css',
  './module/Metronome/Metronome.html',
  './module/Metronome/Metronome.js',
  './module/Metronome/Metronome.css',
  './module/PerformanceGraph/PerformanceGraph.html',
  './module/PerformanceGraph/PerformanceGraph.js',
  './module/PerformanceGraph/PerformanceGraph.css'
];

// AIモデル（ローカルtinyモデル - 軽量・高速）
const AI_MODEL_CACHE_NAME = 'suiren-ai-models-v2';
const AI_MODEL_ASSETS = [
  './audio-core/pitch-detection/models/tiny.onnx'
];

// 全アセット（AIモデル含む）
const ASSETS_TO_CACHE = [
  ...CORE_ASSETS,
  ...WORKLET_ASSETS,
  ...PITCH_DETECTION_ASSETS,
  ...MODULE_ASSETS,
  ...AI_MODEL_ASSETS
];

// ===== ヘルパー関数 =====

// クライアント通知
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage(message));
}

// 並列プリキャッシュ（高速化）
async function parallelPreCache(cache, urls) {
  const BATCH_SIZE = 6; // 同時接続数制限
  const results = { success: 0, failed: 0 };

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (url) => {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) {
          await cache.put(url, response);
          results.success++;
        } else {
          results.failed++;
        }
      } catch (e) {
        results.failed++;
      }
    });
    await Promise.all(promises);
  }

  return results;
}

// キャッシュ整合性チェック
async function validateCacheEntry(cache, request) {
  const cached = await cache.match(request);
  if (!cached) return false;

  // レスポンスが有効か確認
  const contentLength = cached.headers.get('content-length');
  if (contentLength && parseInt(contentLength) === 0) {
    await cache.delete(request);
    return false;
  }

  return true;
}

// ===== ナビゲーションプリロード =====
async function enableNavigationPreload() {
  if (self.registration.navigationPreload) {
    try {
      await self.registration.navigationPreload.enable();
      console.log('[SW] Navigation preload enabled');
    } catch (e) {
      console.warn('[SW] Navigation preload not supported');
    }
  }
}

// ===== インストール =====
self.addEventListener('install', (event) => {
  console.log('[SW] Installing:', CACHE_NAME);

  event.waitUntil(
    // 全アセット（AIモデル含む）を並列キャッシュ
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[SW] Parallel caching all assets...');
      notifyClients({ type: 'DOWNLOAD_START', fileName: 'アプリデータ' });

      const result = await parallelPreCache(cache, ASSETS_TO_CACHE);
      console.log('[SW] Cache result:', result);

      notifyClients({ type: 'DOWNLOAD_COMPLETE', fileName: 'アプリデータ' });
    })
  );

  self.skipWaiting();
});

// ===== アクティベート =====
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating:', CACHE_NAME);

  event.waitUntil(
    Promise.all([
      // ナビゲーションプリロード有効化
      enableNavigationPreload(),

      // 古いキャッシュ削除
      caches.keys().then((keyList) => {
        return Promise.all(
          keyList.map((key) => {
            if (key !== CACHE_NAME && key !== AI_MODEL_CACHE_NAME) {
              console.log('[SW] Removing old cache:', key);
              return caches.delete(key);
            }
          })
        );
      })
    ])
  );

  self.clients.claim();
});

// ===== フェッチ =====
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // GETリクエストのみ処理
  if (request.method !== 'GET') return;

  // 外部CDNリソース（Network First + キャッシュフォールバック）
  if (url.origin !== self.location.origin) {
    event.respondWith(handleExternalResource(request));
    return;
  }

  // SWR対象アセット（Stale-While-Revalidate）
  const pathname = './' + url.pathname.replace(/^\//, '');
  if (SWR_ASSETS.has(pathname)) {
    event.respondWith(handleSWR(request, event));
    return;
  }

  // その他（Cache First）- ONNXモデル含む
  event.respondWith(handleCacheFirst(request, event));
});

// 外部リソース（Network First）
async function handleExternalResource(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

// Stale-While-Revalidate
async function handleSWR(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // バックグラウンドで更新（ナビゲーションプリロード対応）
  const fetchPromise = (async () => {
    try {
      let response;

      // ナビゲーションプリロードを使用
      if (event.preloadResponse && request.mode === 'navigate') {
        response = await event.preloadResponse;
      }

      if (!response) {
        response = await fetch(request);
      }

      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    } catch (e) {
      return null;
    }
  })();

  // キャッシュがあれば即座に返却、なければネットワーク待機
  return cached || fetchPromise;
}

// Cache First
async function handleCacheFirst(request, event) {
  const cache = await caches.open(CACHE_NAME);

  // キャッシュ整合性チェック
  if (await validateCacheEntry(cache, request)) {
    return cache.match(request);
  }

  try {
    let response;

    // ナビゲーションプリロードを使用
    if (event.preloadResponse && request.mode === 'navigate') {
      response = await event.preloadResponse;
    }

    if (!response) {
      response = await fetch(request);
    }

    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    // オフラインフォールバック
    if (request.mode === 'navigate') {
      return cache.match('./index.html');
    }
    throw e;
  }
}

// ===== メッセージハンドリング =====
self.addEventListener('message', (event) => {
  const { type } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.ports[0]?.postMessage({ version: CACHE_NAME });
      break;

    case 'CLEAR_ALL_CACHES':
      caches.keys().then(keys => keys.forEach(key => caches.delete(key)));
      break;

    case 'CHECK_CACHE_STATUS':
      handleCheckCacheStatus(event.ports[0]);
      break;
  }
});

async function handleCheckCacheStatus(port) {
  const cacheNames = await caches.keys();
  const status = {
    version: CACHE_NAME,
    caches: cacheNames
  };
  port?.postMessage(status);
}