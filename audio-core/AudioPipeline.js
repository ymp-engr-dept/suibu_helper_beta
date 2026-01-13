/**
 * AudioPipeline - 超低遅延オーディオパイプライン管理
 * 
 * 責務:
 * - AudioContext管理
 * - マイク/ファイル入力切り替え
 * - AudioWorkletNode管理
 * - Analyser接続
 * - 遅延最小化
 * 
 * v2.0: 音声前処理パイプライン追加
 */
class AudioPipeline {
    constructor() {
        // AudioContext（遅延設定）
        this.audioContext = null;

        // ノード
        this.micSource = null;
        this.playerSource = null;
        this.preprocessorNode = null;  // 新規：音声前処理
        this.passthroughNode = null;
        this.ensembleNode = null;
        this.analyser = null;
        this.gainNode = null;

        // ストリーム
        this.micStream = null;

        // 状態
        this.isInitialized = false;
        this.isWorkletLoaded = false;
        this.currentMode = 'solo'; // 'solo' | 'ensemble'
        this.sourceType = 'mic'; // 'mic' | 'file'
        this.preprocessEnabled = true; // 前処理有効

        // 設定
        this.config = {
            // 超低遅延設定
            latencyHint: 'interactive',
            sampleRate: 48000,

            // Analyser設定（モジュール用）
            analyserFftSize: 2048,
            analyserSmoothing: 0.6,
        };

        // データ配列（プリアロケート）
        this.dataArray = null;

        // コールバック
        this.onStatusChange = null;
        this.onError = null;
    }

    /**
     * パイプラインを初期化
     */
    async initialize() {
        if (this.isInitialized) return true;

        try {
            // 超低遅延AudioContext作成
            const AC = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AC({
                latencyHint: this.config.latencyHint,
                sampleRate: this.config.sampleRate,
            });

            // 実際のレイテンシーを確認
            const baseLatency = this.audioContext.baseLatency || 0;
            const outputLatency = this.audioContext.outputLatency || 0;

            // Analyser作成（モジュール用）
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = this.config.analyserFftSize;
            this.analyser.smoothingTimeConstant = this.config.analyserSmoothing;

            // データ配列をプリアロケート
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

            // GainNode作成
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = 1.0;

            // AudioWorkletをロード
            await this._loadWorklets();

            this.isInitialized = true;
            this._emitStatus('initialized', `Latency: ${((baseLatency + outputLatency) * 1000).toFixed(1)}ms`);

            return true;
        } catch (e) {
            this._emitError('init', e);
            return false;
        }
    }

    /**
     * AudioWorkletをロード
     */
    async _loadWorklets() {
        if (!this.audioContext.audioWorklet) {
            throw new Error('AudioWorklet not supported');
        }

        try {
            // 前処理プロセッサをロード（新規）
            await this.audioContext.audioWorklet.addModule('./audio-core/preprocessor.js');

            // 前処理ノード作成
            this.preprocessorNode = new AudioWorkletNode(
                this.audioContext,
                'wind-instrument-preprocessor'
            );

            // パススループロセッサをロード
            await this.audioContext.audioWorklet.addModule('./audio-core/passthrough-processor.js');

            // パススルーノード作成
            this.passthroughNode = new AudioWorkletNode(
                this.audioContext,
                'passthrough-processor'
            );

            // 合奏プロセッサをロード（既存）
            await this.audioContext.audioWorklet.addModule('./ensemble-processor.js');

            // 合奏ノード作成
            this.ensembleNode = new AudioWorkletNode(
                this.audioContext,
                'ensemble-audio-processor'
            );

            // 合奏ノードのメッセージハンドラ
            this.ensembleNode.port.onmessage = (event) => {
                if (event.data.type === 'noiseCalibrated') {
                    this._emitStatus('ensemble-calibrated', 'ノイズキャリブレーション完了');
                }
            };

            this.isWorkletLoaded = true;
        } catch (e) {
            throw new Error(`Worklet load failed: ${e.message}`);
        }
    }

    /**
     * マイク入力を開始
     */
    async startMicInput() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            // 既存のマイクソースを解放
            this._disconnectMic();

            // マイクストリーム取得
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    latency: 0,
                }
            });

            // ソースノード作成
            this.micSource = this.audioContext.createMediaStreamSource(this.micStream);

            // ルーティング接続
            this._connectMicRouting();

            this.sourceType = 'mic';
            this._emitStatus('mic-ready', 'Mic Ready');

            return true;
        } catch (e) {
            this._emitError('mic', e);
            return false;
        }
    }

    /**
     * マイクルーティングを接続
     * パイプライン: mic → preprocessor → (passthrough/ensemble) → analyser
     */
    _connectMicRouting() {
        if (!this.micSource) return;

        // まず前処理を通す（常に有効）
        this.micSource.connect(this.preprocessorNode);

        // 現在のモードに応じてルーティング
        if (this.currentMode === 'solo') {
            // Solo: preprocessor → passthrough → analyser
            this.preprocessorNode.connect(this.passthroughNode);
            this.passthroughNode.connect(this.analyser);
        } else {
            // Ensemble: preprocessor → ensemble → analyser
            this.preprocessorNode.connect(this.ensembleNode);
            this.ensembleNode.connect(this.analyser);
        }
    }

    /**
     * マイクを切断
     */
    _disconnectMic() {
        if (this.micSource) {
            this.micSource.disconnect();
            this.micSource = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
        }
    }

    /**
     * ファイル入力を設定
     */
    setFileSource(audioElement) {
        if (!this.isInitialized) return false;

        try {
            // 既存のプレイヤーソースを解放
            if (this.playerSource) {
                this.playerSource.disconnect();
            }

            // ソースノード作成
            this.playerSource = this.audioContext.createMediaElementSource(audioElement);
            this.playerSource.connect(this.gainNode);
            this.gainNode.connect(this.analyser);
            this.gainNode.connect(this.audioContext.destination);

            this.sourceType = 'file';
            this._emitStatus('file-mode', 'File Mode');

            return true;
        } catch (e) {
            this._emitError('file', e);
            return false;
        }
    }

    /**
     * モードを切り替え
     */
    setMode(mode) {
        if (mode !== 'solo' && mode !== 'ensemble') return;
        if (mode === this.currentMode) return;

        this.currentMode = mode;

        // ルーティングを再構築
        if (this.sourceType === 'mic' && this.micSource) {
            this.micSource.disconnect();
            if (this.preprocessorNode) this.preprocessorNode.disconnect();
            if (this.passthroughNode) this.passthroughNode.disconnect();
            if (this.ensembleNode) this.ensembleNode.disconnect();

            this._connectMicRouting();
        }

        // 合奏モード有効化
        if (this.ensembleNode) {
            this.ensembleNode.port.postMessage({
                type: 'enable',
                value: mode === 'ensemble'
            });

            if (mode === 'ensemble') {
                this.ensembleNode.port.postMessage({ type: 'reset' });
            }
        }

        this._emitStatus(mode === 'ensemble' ? 'ensemble-mode' : 'solo-mode',
            mode === 'ensemble' ? '合奏モード' : 'Soloモード');
    }

    /**
     * ゲインを設定
     */
    setGain(value) {
        if (this.passthroughNode) {
            this.passthroughNode.port.postMessage({ type: 'gain', value });
        }
        if (this.gainNode) {
            this.gainNode.gain.value = value;
        }
    }

    /**
     * Analyserを取得（モジュール用）
     */
    getAnalyser() {
        return this.analyser;
    }

    /**
     * AudioContextを取得
     */
    getAudioContext() {
        return this.audioContext;
    }

    /**
     * 周波数データを取得（プリアロケート配列使用）
     */
    getFrequencyData() {
        if (this.analyser && this.dataArray) {
            this.analyser.getByteFrequencyData(this.dataArray);
        }
        return this.dataArray;
    }

    /**
     * 時間領域データを取得
     */
    getTimeDomainData() {
        if (this.analyser && this.dataArray) {
            this.analyser.getByteTimeDomainData(this.dataArray);
        }
        return this.dataArray;
    }

    /**
     * Float32配列で波形データを取得
     */
    getFloatTimeDomainData(array) {
        if (this.analyser) {
            this.analyser.getFloatTimeDomainData(array);
        }
    }

    /**
     * ステータス通知
     */
    _emitStatus(status, message) {
        if (this.onStatusChange) {
            this.onStatusChange(status, message);
        }
    }

    /**
     * エラー通知
     */
    _emitError(type, error) {
        if (this.onError) {
            this.onError(type, error);
        }
    }

    /**
     * リソース解放
     */
    destroy() {
        this._disconnectMic();

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.isInitialized = false;
        this.isWorkletLoaded = false;
    }
}

// グローバルエクスポート
window.AudioPipeline = AudioPipeline;
