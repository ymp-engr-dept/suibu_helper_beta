/**
 * DownloadIndicatorManager - ダウンロード進捗表示マネージャー
 * 
 * Service Workerからのメッセージを受け取り、UIを更新
 */

class DownloadIndicatorManager {
    constructor() {
        this._indicator = null;
        this._textElement = null;
        this._progressFill = null;
        this._state = 'idle'; // idle, checking, downloading, complete, offline
        this._hideTimeout = null;
        this._initialized = false;
    }

    initialize() {
        if (this._initialized) return;

        this._indicator = document.getElementById('downloadIndicator');
        this._textElement = this._indicator?.querySelector('.download-text');
        this._progressFill = document.getElementById('downloadProgressFill');

        if (!this._indicator) {
            console.warn('[DownloadIndicator] Element not found');
            return;
        }

        // Service Workerからのメッセージを受信
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                this._handleServiceWorkerMessage(event.data);
            });
        }

        // オンライン/オフライン監視
        window.addEventListener('online', () => this._updateOnlineStatus(true));
        window.addEventListener('offline', () => this._updateOnlineStatus(false));

        // 初期状態
        if (!navigator.onLine) {
            this._showOffline();
        } else {
            this._showChecking();
        }

        this._initialized = true;
    }

    _handleServiceWorkerMessage(data) {
        switch (data.type) {
            case 'DOWNLOAD_START':
                this._showDownloading(data.fileName || 'データ', 0);
                break;
            case 'DOWNLOAD_PROGRESS':
                this._updateProgress(data.progress, data.fileName);
                break;
            case 'DOWNLOAD_COMPLETE':
                this._showComplete();
                break;
            case 'CACHE_HIT':
                this._showCacheHit();
                break;
            case 'CHECKING_UPDATE':
                this._showChecking();
                break;
            case 'UPDATE_AVAILABLE':
                this._showUpdateAvailable();
                break;
        }
    }

    _updateOnlineStatus(isOnline) {
        if (isOnline) {
            this._hideIndicator();
        } else {
            this._showOffline();
        }
    }

    _showChecking() {
        this._setState('checking');
        this._setText('更新確認中...');
        this._setProgress(0);
        this._show();

        // 3秒後に自動非表示
        this._scheduleHide(3000);
    }

    _showDownloading(fileName, progress) {
        this._clearHideTimeout();
        this._setState('downloading');
        this._setText(`${fileName} ダウンロード中...`);
        this._setProgress(progress);
        this._show();
    }

    _updateProgress(progress, fileName) {
        if (fileName) {
            this._setText(`${fileName} ${Math.round(progress)}%`);
        }
        this._setProgress(progress);
    }

    _showComplete() {
        this._setState('complete');
        this._setText('準備完了');
        this._setProgress(100);
        this._show();
        this._scheduleHide(2000);
    }

    _showCacheHit() {
        this._setState('complete');
        this._setText('キャッシュ済み');
        this._show();
        this._scheduleHide(1500);
    }

    _showOffline() {
        this._clearHideTimeout();
        this._setState('offline');
        this._setText('オフライン');
        this._show();
    }

    _showUpdateAvailable() {
        this._setState('downloading');
        this._setText('更新があります');
        this._show();
    }

    _setState(state) {
        this._state = state;
        if (!this._indicator) return;

        this._indicator.classList.remove('offline', 'complete');
        if (state === 'offline') {
            this._indicator.classList.add('offline');
        } else if (state === 'complete') {
            this._indicator.classList.add('complete');
        }
    }

    _setText(text) {
        if (this._textElement) {
            this._textElement.textContent = text;
        }
    }

    _setProgress(progress) {
        if (this._progressFill) {
            this._progressFill.style.width = `${Math.min(100, progress)}%`;
        }
    }

    _show() {
        if (this._indicator) {
            this._indicator.classList.add('visible');
        }
    }

    _hideIndicator() {
        if (this._indicator) {
            this._indicator.classList.remove('visible');
        }
    }

    _scheduleHide(delay) {
        this._clearHideTimeout();
        this._hideTimeout = setTimeout(() => {
            this._hideIndicator();
        }, delay);
    }

    _clearHideTimeout() {
        if (this._hideTimeout) {
            clearTimeout(this._hideTimeout);
            this._hideTimeout = null;
        }
    }

    // 外部から呼び出し可能なメソッド
    showDownloading(fileName, progress = 0) {
        this._showDownloading(fileName, progress);
    }

    updateProgress(progress, fileName) {
        this._updateProgress(progress, fileName);
    }

    showComplete() {
        this._showComplete();
    }

    hide() {
        this._hideIndicator();
    }
}

// グローバルインスタンス
const downloadIndicator = new DownloadIndicatorManager();

// DOM Ready後に初期化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => downloadIndicator.initialize());
} else {
    downloadIndicator.initialize();
}

// Export
if (typeof window !== 'undefined') {
    window.DownloadIndicatorManager = DownloadIndicatorManager;
    window.downloadIndicator = downloadIndicator;
}
