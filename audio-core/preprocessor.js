/**
 * WindInstrumentPreprocessor - 管楽器専用音声前処理AudioWorklet
 * 
 * 処理層:
 * 1. DC除去 + 入力正規化
 * 2. マイク癖補正（ハイパスフィルタ 50Hz）
 * 3. 管楽器バンドパスフィルタ（自動検出）
 * 4. 動的SNRゲート
 * 5. 突発音検出・削減
 * 
 * 設計原則:
 * - 楽器の音はそのまま通す
 * - ノイズは高性能で除去
 * - 遅延は最小化（<1ms）
 */
class WindInstrumentPreprocessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // === 処理設定 ===
        this._enabled = true;
        this._sampleRate = sampleRate; // AudioWorkletグローバル変数

        // === 1. DC除去フィルタ状態 ===
        this._dcPrevIn = 0;
        this._dcPrevOut = 0;
        this._dcAlpha = 0.995; // カットオフ約10Hz

        // === 2. ハイパスフィルタ状態（50Hz Biquad）===
        this._hp = this._createHighpassCoeffs(50);
        this._hpState = { x1: 0, x2: 0, y1: 0, y2: 0 };

        // === 3. バンドパスフィルタ状態 ===
        // 自動検出用：汎用管楽器帯域（80Hz〜8000Hz）
        this._lpf = this._createLowpassCoeffs(8000);
        this._lpfState = { x1: 0, x2: 0, y1: 0, y2: 0 };
        this._hpf2 = this._createHighpassCoeffs(80);
        this._hpf2State = { x1: 0, x2: 0, y1: 0, y2: 0 };

        // === 4. 動的SNRゲート状態 ===
        this._noiseFloor = 0.005;
        this._gateState = 0;
        this._gateAttackCoeff = 1 - Math.exp(-1 / (0.002 * this._sampleRate)); // 2ms
        this._gateReleaseCoeff = 1 - Math.exp(-1 / (0.05 * this._sampleRate)); // 50ms
        this._thresholdMultiplier = 2.0;

        // === 5. 突発音検出状態 ===
        this._prevEnergy = 0;
        this._transientSuppressGain = 1.0;
        this._transientRecoveryCoeff = 1 - Math.exp(-1 / (0.01 * this._sampleRate)); // 10ms回復

        // === 入力正規化 ===
        this._rmsHistory = new Float32Array(8);
        this._rmsHistoryIdx = 0;
        this._targetRMS = 0.1;

        // === メッセージハンドラ ===
        this.port.onmessage = this._handleMessage.bind(this);
    }

    /**
     * ハイパスBiquadフィルタ係数を計算
     */
    _createHighpassCoeffs(freq) {
        const w0 = 2 * Math.PI * freq / this._sampleRate;
        const cosW0 = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * 0.707); // Q = 0.707

        const b0 = (1 + cosW0) / 2;
        const b1 = -(1 + cosW0);
        const b2 = (1 + cosW0) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cosW0;
        const a2 = 1 - alpha;

        return {
            b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
            a1: a1 / a0, a2: a2 / a0
        };
    }

    /**
     * ローパスBiquadフィルタ係数を計算
     */
    _createLowpassCoeffs(freq) {
        const w0 = 2 * Math.PI * freq / this._sampleRate;
        const cosW0 = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * 0.707);

        const b0 = (1 - cosW0) / 2;
        const b1 = 1 - cosW0;
        const b2 = (1 - cosW0) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cosW0;
        const a2 = 1 - alpha;

        return {
            b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
            a1: a1 / a0, a2: a2 / a0
        };
    }

    /**
     * Biquadフィルタを適用（1サンプル）
     */
    _applyBiquad(sample, coeffs, state) {
        const output = coeffs.b0 * sample
            + coeffs.b1 * state.x1
            + coeffs.b2 * state.x2
            - coeffs.a1 * state.y1
            - coeffs.a2 * state.y2;

        state.x2 = state.x1;
        state.x1 = sample;
        state.y2 = state.y1;
        state.y1 = output;

        return output;
    }

    /**
     * メッセージ処理
     */
    _handleMessage(event) {
        const data = event.data;
        if (data.type === 'enable') {
            this._enabled = data.value;
        } else if (data.type === 'setThreshold') {
            this._thresholdMultiplier = data.value;
        }
    }

    /**
     * メイン処理
     */
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0]) {
            return true;
        }

        const inputChannel = input[0];
        const outputChannel = output[0];
        const length = inputChannel.length;

        // 無効時はパススルー
        if (!this._enabled) {
            outputChannel.set(inputChannel);
            return true;
        }

        // === RMS計算（入力レベル監視用） ===
        let sumSq = 0;
        for (let i = 0; i < length; i++) {
            sumSq += inputChannel[i] * inputChannel[i];
        }
        const currentRMS = Math.sqrt(sumSq / length);

        // RMS履歴更新
        this._rmsHistory[this._rmsHistoryIdx] = currentRMS;
        this._rmsHistoryIdx = (this._rmsHistoryIdx + 1) & 7;

        // 平均RMS計算
        let avgRMS = 0;
        for (let i = 0; i < 8; i++) {
            avgRMS += this._rmsHistory[i];
        }
        avgRMS /= 8;

        // === サンプル単位処理 ===
        for (let i = 0; i < length; i++) {
            let sample = inputChannel[i];

            // === 1. DC除去 ===
            const dcOut = sample - this._dcPrevIn + this._dcAlpha * this._dcPrevOut;
            this._dcPrevIn = sample;
            this._dcPrevOut = dcOut;
            sample = dcOut;

            // === 2. ハイパスフィルタ（50Hz） ===
            sample = this._applyBiquad(sample, this._hp, this._hpState);

            // === 3. バンドパスフィルタ ===
            // ローパス（8kHz）
            sample = this._applyBiquad(sample, this._lpf, this._lpfState);
            // ハイパス（80Hz）
            sample = this._applyBiquad(sample, this._hpf2, this._hpf2State);

            // === 4. 動的SNRゲート ===
            const sampleEnergy = sample * sample;

            // ノイズフロア追従
            if (sampleEnergy < this._noiseFloor * 1.5) {
                this._noiseFloor = this._noiseFloor * 0.9995 + sampleEnergy * 0.0005;
            }

            // 閾値計算
            const threshold = Math.max(this._noiseFloor * this._thresholdMultiplier, 0.00001);

            // ゲート状態更新
            if (sampleEnergy > threshold) {
                // アタック
                this._gateState += this._gateAttackCoeff * (1 - this._gateState);
            } else {
                // リリース
                this._gateState *= (1 - this._gateReleaseCoeff);
            }

            // ゲート適用
            sample *= this._gateState;

            // === 5. 突発音検出・削減 ===
            const energyRatio = sampleEnergy / (this._prevEnergy + 0.00001);

            if (energyRatio > 50) {
                // 急激なエネルギー上昇 = 突発音
                this._transientSuppressGain = 0.3;
            } else {
                // 回復
                this._transientSuppressGain += this._transientRecoveryCoeff * (1 - this._transientSuppressGain);
            }

            sample *= this._transientSuppressGain;
            this._prevEnergy = sampleEnergy;

            // === 出力 ===
            outputChannel[i] = sample;
        }

        return true;
    }
}

registerProcessor('wind-instrument-preprocessor', WindInstrumentPreprocessor);
