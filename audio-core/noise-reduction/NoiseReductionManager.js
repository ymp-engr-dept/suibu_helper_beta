/**
 * NoiseReductionManager - ノイズ除去管理クラス
 * 
 * スペクトル減算AudioWorkletの制御とUI連携
 */

class NoiseReductionManager {
    constructor(options = {}) {
        this.audioContext = options.audioContext ?? null;

        this._workletNode = null;
        this._isInitialized = false;
        this._isCalibrating = false;
        this._isEnabled = false;
        this._calibrationProgress = 0;
        this._noiseProfile = null;

        // パラメータ
        this._overSubtraction = options.overSubtraction ?? 1.5;
        this._spectralFloor = options.spectralFloor ?? 0.002;
        this._smoothingAlpha = options.smoothingAlpha ?? 0.96;

        // コールバック
        this._onCalibrationStart = options.onCalibrationStart ?? null;
        this._onCalibrationProgress = options.onCalibrationProgress ?? null;
        this._onCalibrationComplete = options.onCalibrationComplete ?? null;
        this._onCalibrationFailed = options.onCalibrationFailed ?? null;
        this._onStateChange = options.onStateChange ?? null;
    }

    async initialize(audioContext) {
        if (this._isInitialized) return true;

        this.audioContext = audioContext ?? this.audioContext;
        if (!this.audioContext) {
            console.error('NoiseReductionManager: AudioContext is required');
            return false;
        }

        try {
            // AudioWorkletモジュールをロード
            await this.audioContext.audioWorklet.addModule(
                'audio-core/noise-reduction/spectral-subtraction-worklet.js'
            );

            // ノード作成
            this._workletNode = new AudioWorkletNode(
                this.audioContext,
                'spectral-subtraction-processor',
                {
                    processorOptions: {
                        fftSize: 512,
                        hopSize: 128,
                        calibrationFrames: 30
                    }
                }
            );

            // メッセージハンドラ
            this._workletNode.port.onmessage = (event) => {
                this._handleWorkletMessage(event.data);
            };

            this._isInitialized = true;
            if (window.debugLog) debugLog('NoiseReductionManager initialized');

            return true;

        } catch (error) {
            console.error('NoiseReductionManager initialization failed:', error);
            return false;
        }
    }

    _handleWorkletMessage(data) {
        switch (data.type) {
            case 'calibrationStarted':
                this._isCalibrating = true;
                this._calibrationProgress = 0;
                if (this._onCalibrationStart) {
                    this._onCalibrationStart();
                }
                this._notifyStateChange();
                break;

            case 'calibrationProgress':
                this._calibrationProgress = data.progress;
                if (this._onCalibrationProgress) {
                    this._onCalibrationProgress(data.progress);
                }
                break;

            case 'calibrationComplete':
                this._isCalibrating = false;
                this._calibrationProgress = 1;
                this._noiseProfile = data.profile;
                this._isEnabled = true;
                if (this._onCalibrationComplete) {
                    this._onCalibrationComplete(data.numFrames);
                }
                this._notifyStateChange();
                break;

            case 'calibrationFailed':
                this._isCalibrating = false;
                this._calibrationProgress = 0;
                if (this._onCalibrationFailed) {
                    this._onCalibrationFailed(data.reason);
                }
                this._notifyStateChange();
                break;
        }
    }

    _notifyStateChange() {
        if (this._onStateChange) {
            this._onStateChange({
                isCalibrating: this._isCalibrating,
                isEnabled: this._isEnabled,
                calibrationProgress: this._calibrationProgress,
                hasNoiseProfile: !!this._noiseProfile
            });
        }
    }

    /**
     * キャリブレーション開始
     */
    startCalibration() {
        if (!this._isInitialized || !this._workletNode) {
            console.error('NoiseReductionManager not initialized');
            return false;
        }

        this._workletNode.port.postMessage({
            type: 'startCalibration'
        });

        return true;
    }

    /**
     * ノイズ除去を有効化/無効化
     */
    setEnabled(enabled) {
        if (!this._isInitialized || !this._workletNode) return;

        this._isEnabled = enabled;
        this._workletNode.port.postMessage({
            type: 'enable',
            value: enabled
        });

        this._notifyStateChange();
    }

    /**
     * バイパス（デバッグ用）
     */
    setBypass(bypass) {
        if (!this._isInitialized || !this._workletNode) return;

        this._workletNode.port.postMessage({
            type: 'bypass',
            value: bypass
        });
    }

    /**
     * パラメータ設定
     */
    setParameters(params) {
        if (!this._isInitialized || !this._workletNode) return;

        if (params.overSubtraction !== undefined) {
            this._overSubtraction = params.overSubtraction;
        }
        if (params.spectralFloor !== undefined) {
            this._spectralFloor = params.spectralFloor;
        }
        if (params.smoothingAlpha !== undefined) {
            this._smoothingAlpha = params.smoothingAlpha;
        }

        this._workletNode.port.postMessage({
            type: 'setParameters',
            overSubtraction: this._overSubtraction,
            spectralFloor: this._spectralFloor,
            smoothingAlpha: this._smoothingAlpha
        });
    }

    /**
     * 保存されたノイズプロファイルをロード
     */
    loadNoiseProfile(profile) {
        if (!this._isInitialized || !this._workletNode) return false;

        this._noiseProfile = profile;
        this._workletNode.port.postMessage({
            type: 'setNoiseProfile',
            profile
        });

        this._isEnabled = true;
        this._notifyStateChange();
        return true;
    }

    /**
     * ノイズプロファイルを取得（保存用）
     */
    getNoiseProfile() {
        return this._noiseProfile;
    }

    /**
     * AudioWorkletノードを取得
     */
    getNode() {
        return this._workletNode;
    }

    /**
     * オーディオグラフに接続
     */
    connect(source, destination) {
        if (!this._workletNode) return false;

        source.connect(this._workletNode);
        this._workletNode.connect(destination);
        return true;
    }

    /**
     * 接続解除
     */
    disconnect() {
        if (this._workletNode) {
            this._workletNode.disconnect();
        }
    }

    /**
     * 状態取得
     */
    getState() {
        return {
            isInitialized: this._isInitialized,
            isCalibrating: this._isCalibrating,
            isEnabled: this._isEnabled,
            calibrationProgress: this._calibrationProgress,
            hasNoiseProfile: !!this._noiseProfile,
            parameters: {
                overSubtraction: this._overSubtraction,
                spectralFloor: this._spectralFloor,
                smoothingAlpha: this._smoothingAlpha
            }
        };
    }

    /**
     * リセット
     */
    reset() {
        if (this._workletNode) {
            this._workletNode.port.postMessage({ type: 'reset' });
        }

        this._isCalibrating = false;
        this._isEnabled = false;
        this._calibrationProgress = 0;
        this._noiseProfile = null;

        this._notifyStateChange();
    }

    /**
     * 破棄
     */
    dispose() {
        this.disconnect();
        this._workletNode = null;
        this._isInitialized = false;
        this._noiseProfile = null;
    }
}

// Export
if (typeof window !== 'undefined') {
    window.NoiseReductionManager = NoiseReductionManager;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NoiseReductionManager };
}
