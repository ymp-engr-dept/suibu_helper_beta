/**
 * EnsembleAudioProcessor - AudioWorklet for Ensemble Mode
 * 合奏練習時に自分の音を周囲の音から分離するための音声処理ワークレット
 */
class EnsembleAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // === Configuration ===
        this.config = {
            // 適応型ノイズゲート
            noiseGateAttack: 0.05,
            noiseGateRelease: 0.995,
            noiseGateThresholdMultiplier: 2.5,
            noiseGateMinThreshold: 0.005,

            // スペクトル減算
            spectralAlpha: 1.3,          // over-subtraction factor
            spectralBeta: 0.02,          // spectral floor
            noiseLearnRate: 0.05,        // ノイズスペクトル学習レート

            // ハーモニック強調
            harmonicBoost: 1.5,          // 倍音強調係数
            harmonicTolerance: 0.04,     // 倍音許容誤差

            // 近接効果
            proximityLowFreqStart: 80,
            proximityLowFreqEnd: 300,
            proximityMidFreqStart: 1000,
            proximityMidFreqEnd: 3000,
            proximityThreshold: 0.8,

            // FFT設定
            fftSize: 2048,
            hopSize: 512,
        };

        // === State ===
        // ノイズゲート
        this.noiseFloor = 0.01;
        this.gateState = 0;  // 0 = closed, 1 = open

        // スペクトル減算
        this.noiseSpectrum = null;
        this.isNoiseCalibrated = false;
        this.noiseCalibrationFrames = 0;
        this.maxNoiseCalibrationFrames = 50;

        // FFTバッファ
        this.inputBuffer = new Float32Array(this.config.fftSize);
        this.outputBuffer = new Float32Array(this.config.fftSize);
        this.inputWritePos = 0;
        this.outputReadPos = 0;

        // ハニング窓
        this.window = this.createHannWindow(this.config.fftSize);

        // 有効/無効状態
        this.isEnabled = false;

        // メッセージハンドラ
        this.port.onmessage = (event) => {
            if (event.data.type === 'enable') {
                this.isEnabled = event.data.value;
                if (this.isEnabled) {
                    // 合奏モード有効時にノイズキャリブレーションをリセット
                    this.resetNoiseCalibration();
                }
            } else if (event.data.type === 'reset') {
                this.resetNoiseCalibration();
            }
        };
    }

    /**
     * ハニング窓を作成
     */
    createHannWindow(size) {
        const window = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
        }
        return window;
    }

    /**
     * ノイズキャリブレーションをリセット
     */
    resetNoiseCalibration() {
        this.noiseSpectrum = null;
        this.isNoiseCalibrated = false;
        this.noiseCalibrationFrames = 0;
        this.noiseFloor = 0.01;
    }

    /**
     * RMSを計算
     */
    calculateRMS(buffer, start, length) {
        let sum = 0;
        for (let i = start; i < start + length && i < buffer.length; i++) {
            sum += buffer[i] * buffer[i];
        }
        return Math.sqrt(sum / length);
    }

    /**
     * 適応型ノイズゲート処理
     */
    applyAdaptiveNoiseGate(input, rms) {
        // 背景ノイズフロアの推定（低いRMS値を追跡）
        if (rms < this.noiseFloor * 1.5 || rms < this.config.noiseGateMinThreshold) {
            this.noiseFloor = this.noiseFloor * this.config.noiseGateRelease
                + rms * (1 - this.config.noiseGateRelease);
        }

        // 動的閾値を計算
        const threshold = Math.max(
            this.noiseFloor * this.config.noiseGateThresholdMultiplier,
            this.config.noiseGateMinThreshold
        );

        // ゲート状態を更新（スムーズな開閉）
        const targetState = rms > threshold ? 1.0 : 0.0;

        if (targetState > this.gateState) {
            // アタック（速く開く）
            this.gateState += this.config.noiseGateAttack;
            if (this.gateState > 1) this.gateState = 1;
        } else {
            // リリース（ゆっくり閉じる）
            this.gateState *= this.config.noiseGateRelease;
            if (this.gateState < 0.001) this.gateState = 0;
        }

        // ゲートを適用
        const output = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
            output[i] = input[i] * this.gateState;
        }

        return output;
    }

    /**
     * 簡易DFT（実数入力）
     * 注: 本番ではFFTライブラリを使用することを推奨
     */
    simpleDFT(input) {
        const N = input.length;
        const real = new Float32Array(N / 2 + 1);
        const imag = new Float32Array(N / 2 + 1);

        for (let k = 0; k <= N / 2; k++) {
            let sumReal = 0;
            let sumImag = 0;
            for (let n = 0; n < N; n++) {
                const angle = 2 * Math.PI * k * n / N;
                sumReal += input[n] * Math.cos(angle);
                sumImag -= input[n] * Math.sin(angle);
            }
            real[k] = sumReal;
            imag[k] = sumImag;
        }

        return { real, imag };
    }

    /**
     * 簡易逆DFT
     */
    simpleIDFT(real, imag) {
        const N = (real.length - 1) * 2;
        const output = new Float32Array(N);

        for (let n = 0; n < N; n++) {
            let sum = 0;
            for (let k = 0; k < real.length; k++) {
                const angle = 2 * Math.PI * k * n / N;
                sum += real[k] * Math.cos(angle) - imag[k] * Math.sin(angle);
                // 対称性を利用
                if (k > 0 && k < real.length - 1) {
                    sum += real[k] * Math.cos(angle) + imag[k] * Math.sin(angle);
                }
            }
            output[n] = sum / N;
        }

        return output;
    }

    /**
     * マグニチュードを計算
     */
    calculateMagnitude(real, imag) {
        const mag = new Float32Array(real.length);
        for (let i = 0; i < real.length; i++) {
            mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        }
        return mag;
    }

    /**
     * 位相を計算
     */
    calculatePhase(real, imag) {
        const phase = new Float32Array(real.length);
        for (let i = 0; i < real.length; i++) {
            phase[i] = Math.atan2(imag[i], real[i]);
        }
        return phase;
    }

    /**
     * スペクトル減算によるノイズ除去
     */
    applySpectralSubtraction(magnitude, sampleRate) {
        const binCount = magnitude.length;

        // ノイズスペクトルの初期化
        if (!this.noiseSpectrum) {
            this.noiseSpectrum = new Float32Array(binCount);
        }

        // ノイズキャリブレーション（最初の数フレーム）
        if (!this.isNoiseCalibrated && this.noiseCalibrationFrames < this.maxNoiseCalibrationFrames) {
            for (let i = 0; i < binCount; i++) {
                this.noiseSpectrum[i] = this.noiseSpectrum[i] * (1 - this.config.noiseLearnRate)
                    + magnitude[i] * this.config.noiseLearnRate;
            }
            this.noiseCalibrationFrames++;

            if (this.noiseCalibrationFrames >= this.maxNoiseCalibrationFrames) {
                this.isNoiseCalibrated = true;
                this.port.postMessage({ type: 'noiseCalibrated' });
            }
        }

        // スペクトル減算を適用
        const output = new Float32Array(binCount);
        for (let i = 0; i < binCount; i++) {
            const subtracted = magnitude[i] - this.config.spectralAlpha * this.noiseSpectrum[i];
            output[i] = Math.max(subtracted, this.config.spectralBeta * magnitude[i]);
        }

        return output;
    }

    /**
     * ハーモニック強調
     * 倍音構造を持つ周波数帯を強調
     */
    applyHarmonicEnhancement(magnitude, sampleRate) {
        const binCount = magnitude.length;
        const freqPerBin = sampleRate / (binCount * 2);
        const output = new Float32Array(magnitude);

        // ピークを検出
        const peaks = [];
        for (let i = 2; i < binCount - 2; i++) {
            if (magnitude[i] > magnitude[i - 1] && magnitude[i] > magnitude[i + 1]) {
                if (magnitude[i] > magnitude[i - 2] && magnitude[i] > magnitude[i + 2]) {
                    peaks.push({ bin: i, mag: magnitude[i], freq: i * freqPerBin });
                }
            }
        }

        // 各ピークの倍音スコアを計算
        for (const peak of peaks) {
            let harmonicScore = 0;

            // 2〜6倍音をチェック
            for (let n = 2; n <= 6; n++) {
                const expectedBin = Math.round(peak.bin * n);
                if (expectedBin >= binCount) break;

                // 許容範囲内でピークがあるか確認
                const tolerance = Math.max(2, Math.round(expectedBin * this.config.harmonicTolerance));
                for (let b = expectedBin - tolerance; b <= expectedBin + tolerance && b < binCount; b++) {
                    if (b >= 0 && magnitude[b] > peak.mag * 0.1) {
                        harmonicScore++;
                        break;
                    }
                }
            }

            // 倍音スコアが高いピークを強調
            if (harmonicScore >= 2) {
                const boost = 1 + (harmonicScore / 6) * (this.config.harmonicBoost - 1);
                const tolerance = Math.max(1, Math.round(peak.bin * 0.02));
                for (let b = peak.bin - tolerance; b <= peak.bin + tolerance && b < binCount; b++) {
                    if (b >= 0) {
                        output[b] *= boost;
                    }
                }
            }
        }

        return output;
    }

    /**
     * 近接効果フィルタ
     * マイクに近い音源は低周波が相対的に強くなる特性を利用
     */
    applyProximityFilter(magnitude, sampleRate) {
        const binCount = magnitude.length;
        const freqPerBin = sampleRate / (binCount * 2);

        // 低周波帯と中周波帯のエネルギーを計算
        let lowFreqEnergy = 0;
        let midFreqEnergy = 0;
        let lowCount = 0;
        let midCount = 0;

        for (let i = 0; i < binCount; i++) {
            const freq = i * freqPerBin;

            if (freq >= this.config.proximityLowFreqStart && freq <= this.config.proximityLowFreqEnd) {
                lowFreqEnergy += magnitude[i] * magnitude[i];
                lowCount++;
            } else if (freq >= this.config.proximityMidFreqStart && freq <= this.config.proximityMidFreqEnd) {
                midFreqEnergy += magnitude[i] * magnitude[i];
                midCount++;
            }
        }

        // 平均エネルギーを計算
        lowFreqEnergy = lowCount > 0 ? Math.sqrt(lowFreqEnergy / lowCount) : 0;
        midFreqEnergy = midCount > 0 ? Math.sqrt(midFreqEnergy / midCount) : 0.001;

        // 近接度を計算（低周波/中周波比率）
        const proximityRatio = lowFreqEnergy / midFreqEnergy;

        // 近接度が低い場合（遠い音源）は信号を減衰
        const output = new Float32Array(magnitude);
        if (proximityRatio < this.config.proximityThreshold) {
            const attenuation = Math.max(0.3, proximityRatio / this.config.proximityThreshold);
            for (let i = 0; i < binCount; i++) {
                output[i] *= attenuation;
            }
        }

        return output;
    }

    /**
     * マグニチュードと位相から信号を再構成
     */
    reconstructSignal(magnitude, phase) {
        const N = (magnitude.length - 1) * 2;
        const output = new Float32Array(N);

        // 実部と虚部を再構成
        const real = new Float32Array(magnitude.length);
        const imag = new Float32Array(magnitude.length);

        for (let i = 0; i < magnitude.length; i++) {
            real[i] = magnitude[i] * Math.cos(phase[i]);
            imag[i] = magnitude[i] * Math.sin(phase[i]);
        }

        // 逆DFT
        return this.simpleIDFT(real, imag);
    }

    /**
     * メイン処理ルーチン
     */
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0] || input[0].length === 0) {
            return true;
        }

        const inputChannel = input[0];
        const outputChannel = output[0];

        // 合奏モードが無効の場合はパススルー
        if (!this.isEnabled) {
            for (let i = 0; i < inputChannel.length; i++) {
                outputChannel[i] = inputChannel[i];
            }
            return true;
        }

        // RMSを計算
        const rms = this.calculateRMS(inputChannel, 0, inputChannel.length);

        // 適応型ノイズゲートを適用
        const gatedInput = this.applyAdaptiveNoiseGate(inputChannel, rms);

        // 単純なパススルー（FFT処理はCPU負荷が高いため、最適化版では別途実装）
        // 現在のバージョンでは、ノイズゲートのみを適用
        for (let i = 0; i < gatedInput.length; i++) {
            outputChannel[i] = gatedInput[i];
        }

        return true;
    }
}

registerProcessor('ensemble-audio-processor', EnsembleAudioProcessor);
