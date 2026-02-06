/**
 * NoiseCalibrationUI - ノイズキャリブレーションUIコンポーネント
 * 
 * 学習インジケーター、完了通知、Noise-Reducedモード表示
 */

class NoiseCalibrationUI {
    constructor(options = {}) {
        this.containerId = options.containerId ?? 'noise-calibration-ui';
        this.noiseReductionManager = options.noiseReductionManager ?? null;

        this._container = null;
        this._progressBar = null;
        this._statusText = null;
        this._calibrateButton = null;
        this._enabledIndicator = null;

        this._isVisible = false;

        this._initialize();
    }

    _initialize() {
        this._createUI();
        this._bindEvents();
    }

    _createUI() {
        // コンテナ確認
        let container = document.getElementById(this.containerId);

        if (!container) {
            // コンテナがなければ作成
            container = document.createElement('div');
            container.id = this.containerId;
            container.className = 'noise-calibration-ui';
            document.body.appendChild(container);
        }

        this._container = container;

        // UI構造
        container.innerHTML = `
            <div class="noise-cal-panel">
                <div class="noise-cal-header">
                    <span class="noise-cal-title">🔇 ノイズ除去</span>
                    <span class="noise-cal-status" id="noise-cal-enabled">無効</span>
                </div>
                
                <div class="noise-cal-content">
                    <div class="noise-cal-progress-container" style="display: none;">
                        <div class="noise-cal-progress-bar">
                            <div class="noise-cal-progress-fill" id="noise-cal-progress"></div>
                        </div>
                        <span class="noise-cal-progress-text" id="noise-cal-progress-text">0%</span>
                    </div>
                    
                    <div class="noise-cal-status-text" id="noise-cal-status">
                        キャリブレーションを実行して環境ノイズを学習します
                    </div>
                    
                    <button class="noise-cal-button" id="noise-cal-button">
                        🎤 キャリブレーション開始
                    </button>
                </div>
            </div>
        `;

        // 要素参照
        this._progressBar = container.querySelector('#noise-cal-progress');
        this._progressText = container.querySelector('#noise-cal-progress-text');
        this._progressContainer = container.querySelector('.noise-cal-progress-container');
        this._statusText = container.querySelector('#noise-cal-status');
        this._calibrateButton = container.querySelector('#noise-cal-button');
        this._enabledIndicator = container.querySelector('#noise-cal-enabled');

        // スタイル追加
        this._injectStyles();
    }

    _injectStyles() {
        if (document.getElementById('noise-calibration-styles')) return;

        const style = document.createElement('style');
        style.id = 'noise-calibration-styles';
        style.textContent = `
            .noise-calibration-ui {
                position: fixed;
                bottom: 80px;
                right: 20px;
                z-index: 1000;
            }

            .noise-cal-panel {
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border-radius: 12px;
                padding: 16px;
                min-width: 280px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .noise-cal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 12px;
                padding-bottom: 8px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }

            .noise-cal-title {
                font-size: 14px;
                font-weight: 600;
                color: #fff;
            }

            .noise-cal-status {
                font-size: 12px;
                padding: 4px 8px;
                border-radius: 12px;
                background: rgba(255, 100, 100, 0.2);
                color: #ff6b6b;
            }

            .noise-cal-status.enabled {
                background: rgba(100, 255, 100, 0.2);
                color: #51cf66;
            }

            .noise-cal-content {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .noise-cal-progress-container {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .noise-cal-progress-bar {
                flex: 1;
                height: 8px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                overflow: hidden;
            }

            .noise-cal-progress-fill {
                height: 100%;
                width: 0%;
                background: linear-gradient(90deg, #4361ee, #7209b7);
                border-radius: 4px;
                transition: width 0.1s ease;
            }

            .noise-cal-progress-text {
                font-size: 12px;
                color: #aaa;
                min-width: 40px;
                text-align: right;
            }

            .noise-cal-status-text {
                font-size: 12px;
                color: #aaa;
                line-height: 1.4;
            }

            .noise-cal-button {
                padding: 10px 16px;
                border: none;
                border-radius: 8px;
                background: linear-gradient(135deg, #4361ee 0%, #3a0ca3 100%);
                color: #fff;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .noise-cal-button:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(67, 97, 238, 0.4);
            }

            .noise-cal-button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
            }

            .noise-cal-button.calibrating {
                background: linear-gradient(135deg, #f72585 0%, #b5179e 100%);
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }

            .noise-cal-button.calibrating {
                animation: pulse 1s infinite;
            }
        `;
        document.head.appendChild(style);
    }

    _bindEvents() {
        // ボタンクリック
        this._calibrateButton.addEventListener('click', () => {
            this.startCalibration();
        });

        // NoiseReductionManagerからのコールバック設定
        if (this.noiseReductionManager) {
            this.noiseReductionManager._onCalibrationStart = () => {
                this._onCalibrationStart();
            };

            this.noiseReductionManager._onCalibrationProgress = (progress) => {
                this._onCalibrationProgress(progress);
            };

            this.noiseReductionManager._onCalibrationComplete = (numFrames) => {
                this._onCalibrationComplete(numFrames);
            };

            this.noiseReductionManager._onCalibrationFailed = (reason) => {
                this._onCalibrationFailed(reason);
            };

            this.noiseReductionManager._onStateChange = (state) => {
                this._onStateChange(state);
            };
        }
    }

    startCalibration() {
        if (!this.noiseReductionManager) {
            console.error('NoiseReductionManager not set');
            return;
        }

        this.noiseReductionManager.startCalibration();
    }

    _onCalibrationStart() {
        this._progressContainer.style.display = 'flex';
        this._calibrateButton.disabled = true;
        this._calibrateButton.classList.add('calibrating');
        this._calibrateButton.textContent = '📊 学習中...';
        this._statusText.textContent = '静かにしてください。環境ノイズを学習しています...';
    }

    _onCalibrationProgress(progress) {
        const percent = Math.round(progress * 100);
        this._progressBar.style.width = `${percent}%`;
        this._progressText.textContent = `${percent}%`;
    }

    _onCalibrationComplete(numFrames) {
        this._progressContainer.style.display = 'none';
        this._calibrateButton.disabled = false;
        this._calibrateButton.classList.remove('calibrating');
        this._calibrateButton.textContent = '🔄 再キャリブレーション';
        this._statusText.textContent = `✅ ノイズ学習完了（${numFrames}フレーム）\nNoise-Reduced Mode が有効になりました`;

        this._enabledIndicator.textContent = '有効';
        this._enabledIndicator.classList.add('enabled');
    }

    _onCalibrationFailed(reason) {
        this._progressContainer.style.display = 'none';
        this._calibrateButton.disabled = false;
        this._calibrateButton.classList.remove('calibrating');
        this._calibrateButton.textContent = '🎤 キャリブレーション開始';
        this._statusText.textContent = `❌ 失敗: ${reason}\nもう一度お試しください`;
    }

    _onStateChange(state) {
        if (state.isEnabled) {
            this._enabledIndicator.textContent = '有効';
            this._enabledIndicator.classList.add('enabled');
        } else {
            this._enabledIndicator.textContent = '無効';
            this._enabledIndicator.classList.remove('enabled');
        }
    }

    setNoiseReductionManager(manager) {
        this.noiseReductionManager = manager;
        this._bindEvents();
    }

    show() {
        this._container.style.display = 'block';
        this._isVisible = true;
    }

    hide() {
        this._container.style.display = 'none';
        this._isVisible = false;
    }

    toggle() {
        if (this._isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }
}

// Export
if (typeof window !== 'undefined') {
    window.NoiseCalibrationUI = NoiseCalibrationUI;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NoiseCalibrationUI };
}
