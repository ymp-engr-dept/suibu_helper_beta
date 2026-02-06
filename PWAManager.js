/**
 * PWAManager - プログレッシブWebアプリ管理
 * 
 * インストールプロンプト、オフライン状態、更新管理
 */

class PWAManager {
    constructor() {
        this._deferredPrompt = null;
        this._isInstalled = false;
        this._isOnline = navigator.onLine;
        this._serviceWorkerRegistration = null;
        this._updateAvailable = false;

        // コールバック
        this._onInstallPromptReady = null;
        this._onInstalled = null;
        this._onOnlineStatusChange = null;
        this._onUpdateAvailable = null;

        this._initialize();
    }

    _initialize() {
        // インストールプロンプトをキャプチャ
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this._deferredPrompt = e;
            console.log('[PWA] Install prompt captured');

            if (this._onInstallPromptReady) {
                this._onInstallPromptReady();
            }
        });

        // インストール完了検出
        window.addEventListener('appinstalled', () => {
            this._isInstalled = true;
            this._deferredPrompt = null;
            console.log('[PWA] App installed');

            if (this._onInstalled) {
                this._onInstalled();
            }
        });

        // オンライン/オフライン状態監視
        window.addEventListener('online', () => {
            this._isOnline = true;
            console.log('[PWA] Online');
            if (this._onOnlineStatusChange) {
                this._onOnlineStatusChange(true);
            }
        });

        window.addEventListener('offline', () => {
            this._isOnline = false;
            console.log('[PWA] Offline');
            if (this._onOnlineStatusChange) {
                this._onOnlineStatusChange(false);
            }
        });

        // スタンドアロンモード検出
        if (window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone === true) {
            this._isInstalled = true;
        }

        // Service Worker登録
        this._registerServiceWorker();
    }

    async _registerServiceWorker() {
        if (!('serviceWorker' in navigator)) {
            console.warn('[PWA] Service Worker not supported');
            return;
        }

        try {
            this._serviceWorkerRegistration = await navigator.serviceWorker.register('./service-worker.js');
            console.log('[PWA] Service Worker registered');

            // 更新検出
            this._serviceWorkerRegistration.addEventListener('updatefound', () => {
                const newWorker = this._serviceWorkerRegistration.installing;

                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        this._updateAvailable = true;
                        console.log('[PWA] Update available');

                        if (this._onUpdateAvailable) {
                            this._onUpdateAvailable();
                        }
                    }
                });
            });

        } catch (error) {
            console.error('[PWA] Service Worker registration failed:', error);
        }
    }

    /**
     * インストールプロンプトを表示
     */
    async promptInstall() {
        if (!this._deferredPrompt) {
            console.warn('[PWA] Install prompt not available');
            return { outcome: 'unavailable' };
        }

        this._deferredPrompt.prompt();
        const result = await this._deferredPrompt.userChoice;

        if (result.outcome === 'accepted') {
            this._isInstalled = true;
        }

        this._deferredPrompt = null;
        return result;
    }

    /**
     * 更新を適用（ページリロード）
     */
    applyUpdate() {
        if (this._serviceWorkerRegistration && this._serviceWorkerRegistration.waiting) {
            // Service Workerに即座に有効化を指示
            this._serviceWorkerRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });

            // ページリロード
            window.location.reload();
        }
    }

    /**
     * AIモデルをキャッシュ
     */
    async cacheAIModel(url) {
        if (!navigator.serviceWorker.controller) {
            console.warn('[PWA] No active Service Worker');
            return false;
        }

        return new Promise((resolve) => {
            const messageChannel = new MessageChannel();

            messageChannel.port1.onmessage = (event) => {
                resolve(event.data.success);
            };

            navigator.serviceWorker.controller.postMessage(
                { type: 'CACHE_AI_MODEL', url },
                [messageChannel.port2]
            );
        });
    }

    /**
     * キャッシュバージョンを取得
     */
    async getCacheVersion() {
        if (!navigator.serviceWorker.controller) {
            return null;
        }

        return new Promise((resolve) => {
            const messageChannel = new MessageChannel();

            messageChannel.port1.onmessage = (event) => {
                resolve(event.data.version);
            };

            navigator.serviceWorker.controller.postMessage(
                { type: 'GET_VERSION' },
                [messageChannel.port2]
            );
        });
    }

    /**
     * コールバック設定
     */
    onInstallPromptReady(callback) {
        this._onInstallPromptReady = callback;
        if (this._deferredPrompt) {
            callback();
        }
    }

    onInstalled(callback) {
        this._onInstalled = callback;
    }

    onOnlineStatusChange(callback) {
        this._onOnlineStatusChange = callback;
    }

    onUpdateAvailable(callback) {
        this._onUpdateAvailable = callback;
        if (this._updateAvailable) {
            callback();
        }
    }

    /**
     * 状態取得
     */
    get canInstall() {
        return !!this._deferredPrompt;
    }

    get isInstalled() {
        return this._isInstalled;
    }

    get isOnline() {
        return this._isOnline;
    }

    get hasUpdate() {
        return this._updateAvailable;
    }

    getStatus() {
        return {
            canInstall: this.canInstall,
            isInstalled: this._isInstalled,
            isOnline: this._isOnline,
            hasUpdate: this._updateAvailable,
            serviceWorkerActive: !!navigator.serviceWorker.controller
        };
    }
}

// グローバルインスタンス
const pwaManager = new PWAManager();

// Export
if (typeof window !== 'undefined') {
    window.PWAManager = PWAManager;
    window.pwaManager = pwaManager;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PWAManager };
}
