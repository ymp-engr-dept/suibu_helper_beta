/**
 * Layer 1: CQT Analyzer & Noise Calibration
 * 
 * Constant-Q Transform: 対数周波数軸での高解像度解析
 * Noise Calibrator: Spectral Subtractionによる動的ノイズ除去
 */

/**
 * CQTAnalyzer - Constant-Q Transform 解析器
 * 
 * 音階に合わせた対数周波数軸解析
 * 低域の解像度不足を物理的に解消
 */
class CQTAnalyzer {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate ?? 48000;
        this.minFreq = options.minFreq ?? 27.5;   // A0
        this.maxFreq = options.maxFreq ?? 4186;   // C8
        this.binsPerOctave = options.binsPerOctave ?? 48;  // 高解像度 (1/4 semitone)

        this._numOctaves = Math.ceil(Math.log2(this.maxFreq / this.minFreq));
        this._numBins = this._numOctaves * this.binsPerOctave;

        // CQTカーネル（周波数ごとの窓関数）
        this._kernels = null;
        this._frequencies = null;

        this._initialize();
    }

    _initialize() {
        this._frequencies = new Float32Array(this._numBins);
        this._kernels = [];

        for (let k = 0; k < this._numBins; k++) {
            // 対数周波数グリッド
            const freq = this.minFreq * Math.pow(2, k / this.binsPerOctave);
            this._frequencies[k] = freq;

            // 周波数ごとに適切なウィンドウサイズを計算
            // Q = f_k / Δf = f_k / (f_k * (2^(1/B) - 1)) = 1 / (2^(1/B) - 1)
            const Q = 1 / (Math.pow(2, 1 / this.binsPerOctave) - 1);
            const windowSize = Math.ceil(Q * this.sampleRate / freq);

            // ハミング窓 × 複素指数関数カーネル
            const kernel = this._createKernel(freq, windowSize, Q);
            this._kernels.push(kernel);
        }
    }

    _createKernel(freq, windowSize, Q) {
        const realPart = new Float32Array(windowSize);
        const imagPart = new Float32Array(windowSize);

        const normFactor = 1 / windowSize;

        for (let n = 0; n < windowSize; n++) {
            // ハミング窓
            const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (windowSize - 1));

            // 複素指数関数: e^(-j * 2π * f * n / sr)
            const phase = -2 * Math.PI * freq * n / this.sampleRate;

            realPart[n] = window * Math.cos(phase) * normFactor;
            imagPart[n] = window * Math.sin(phase) * normFactor;
        }

        return { real: realPart, imag: imagPart, size: windowSize };
    }

    analyze(audioBuffer, sampleRate) {
        if (!this._kernels || this._kernels.length === 0) {
            return { spectrum: null, peaks: null };
        }

        const spectrum = new Float32Array(this._numBins);
        const bufferLength = audioBuffer.length;

        // 各周波数ビンでCQT計算
        for (let k = 0; k < this._numBins; k++) {
            const kernel = this._kernels[k];
            const windowSize = kernel.size;

            if (windowSize > bufferLength) {
                spectrum[k] = 0;
                continue;
            }

            // バッファの末尾を使用（最新データ）
            const startIdx = bufferLength - windowSize;

            let realSum = 0;
            let imagSum = 0;

            for (let n = 0; n < windowSize; n++) {
                const sample = audioBuffer[startIdx + n];
                realSum += sample * kernel.real[n];
                imagSum += sample * kernel.imag[n];
            }

            // 振幅
            spectrum[k] = Math.sqrt(realSum * realSum + imagSum * imagSum);
        }

        // ピーク検出
        const peaks = this._findPeaks(spectrum);

        return {
            spectrum,
            frequencies: this._frequencies,
            peaks,
            numBins: this._numBins,
            binsPerOctave: this.binsPerOctave
        };
    }

    _findPeaks(spectrum) {
        const peaks = [];
        const threshold = this._calculateThreshold(spectrum);

        for (let i = 2; i < spectrum.length - 2; i++) {
            // 極大点検出
            if (spectrum[i] > spectrum[i - 1] &&
                spectrum[i] > spectrum[i + 1] &&
                spectrum[i] > spectrum[i - 2] &&
                spectrum[i] > spectrum[i + 2] &&
                spectrum[i] > threshold) {

                // 放物線補間で精密なピーク位置を推定
                const alpha = spectrum[i - 1];
                const beta = spectrum[i];
                const gamma = spectrum[i + 1];

                const p = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);
                const refinedBin = i + p;
                const refinedFreq = this.minFreq * Math.pow(2, refinedBin / this.binsPerOctave);

                peaks.push({
                    bin: refinedBin,
                    freq: refinedFreq,
                    magnitude: beta + 0.25 * p * p * (alpha - gamma)
                });
            }
        }

        // 振幅順にソート
        peaks.sort((a, b) => b.magnitude - a.magnitude);

        return peaks.slice(0, 10);  // 上位10ピーク
    }

    _calculateThreshold(spectrum) {
        let sum = 0;
        let max = 0;

        for (let i = 0; i < spectrum.length; i++) {
            sum += spectrum[i];
            if (spectrum[i] > max) max = spectrum[i];
        }

        const mean = sum / spectrum.length;
        return Math.max(mean * 3, max * 0.1);
    }

    getFrequencyForBin(bin) {
        return this.minFreq * Math.pow(2, bin / this.binsPerOctave);
    }

    getBinForFrequency(freq) {
        return this.binsPerOctave * Math.log2(freq / this.minFreq);
    }
}

/**
 * NoiseCalibrator - 環境ノイズキャリブレーション
 * 
 * Spectral Subtractionによる動的ノイズ除去
 */
class NoiseCalibrator {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate ?? 48000;
        this.fftSize = options.fftSize ?? 2048;
        this.calibrationFrames = options.calibrationFrames ?? 50;

        this._noiseProfile = null;
        this._isCalibrating = false;
        this._calibrationBuffer = [];
        this._calibrated = false;

        // スペクトル減算パラメータ
        this._overSubtraction = 1.0;     // 過減算係数
        this._spectralFloor = 0.002;      // スペクトルフロア
        this._smoothingFactor = 0.98;     // 平滑化係数
    }

    startCalibration() {
        this._isCalibrating = true;
        this._calibrationBuffer = [];
        this._noiseProfile = null;
        this._calibrated = false;
        if (window.debugLog) debugLog('Noise calibration started...');
    }

    feedSample(audioBuffer) {
        if (!this._isCalibrating) return false;

        // RMSチェック（本当に無音かどうか）
        const rms = this._calculateRMS(audioBuffer);
        if (rms > 0.01) {
            console.warn('Signal detected during calibration, skipping frame');
            return false;
        }

        // FFTでスペクトル取得
        const spectrum = this._computeSpectrum(audioBuffer);
        this._calibrationBuffer.push(spectrum);

        if (this._calibrationBuffer.length >= this.calibrationFrames) {
            this._finishCalibration();
            return true;
        }

        return false;
    }

    _finishCalibration() {
        const numFrames = this._calibrationBuffer.length;
        const spectrumLength = this._calibrationBuffer[0].length;

        // 平均ノイズスペクトルを計算
        this._noiseProfile = new Float32Array(spectrumLength);

        for (let i = 0; i < spectrumLength; i++) {
            let sum = 0;
            for (let j = 0; j < numFrames; j++) {
                sum += this._calibrationBuffer[j][i];
            }
            this._noiseProfile[i] = sum / numFrames;
        }

        this._isCalibrating = false;
        this._calibrated = true;
        this._calibrationBuffer = [];

        if (window.debugLog) debugLog('Noise calibration completed:', {
            avgNoiseLevel: this._noiseProfile.reduce((a, b) => a + b) / spectrumLength
        });
    }

    denoise(audioBuffer) {
        if (!this._calibrated || !this._noiseProfile) {
            return audioBuffer;
        }

        // スペクトル減算
        const fftSize = this.fftSize;
        const halfFFT = fftSize / 2;

        // 入力をFFT
        const spectrum = this._computeComplexSpectrum(audioBuffer);

        // スペクトル減算適用
        for (let i = 0; i < halfFFT; i++) {
            const signalMag = spectrum.magnitude[i];
            const noiseMag = this._noiseProfile[i] * this._overSubtraction;

            // ハーフウェーブ整流
            let cleanMag = signalMag - noiseMag;
            if (cleanMag < this._spectralFloor * signalMag) {
                cleanMag = this._spectralFloor * signalMag;
            }

            // 振幅のみ変更、位相は保持
            const scaleFactor = cleanMag / (signalMag + 1e-10);
            spectrum.real[i] *= scaleFactor;
            spectrum.imag[i] *= scaleFactor;
        }

        // 逆FFT
        return this._inverseFFT(spectrum, audioBuffer.length);
    }

    _computeSpectrum(audioBuffer) {
        const fftSize = Math.min(this.fftSize, audioBuffer.length);
        const spectrum = new Float32Array(fftSize / 2);

        // 簡易DFT（パフォーマンス向上のため必要に応じてFFT実装に置換）
        for (let k = 0; k < fftSize / 2; k++) {
            let realSum = 0;
            let imagSum = 0;

            for (let n = 0; n < fftSize; n++) {
                const sample = n < audioBuffer.length ? audioBuffer[n] : 0;
                const angle = -2 * Math.PI * k * n / fftSize;
                realSum += sample * Math.cos(angle);
                imagSum += sample * Math.sin(angle);
            }

            spectrum[k] = Math.sqrt(realSum * realSum + imagSum * imagSum) / fftSize;
        }

        return spectrum;
    }

    _computeComplexSpectrum(audioBuffer) {
        const fftSize = Math.min(this.fftSize, audioBuffer.length);
        const real = new Float32Array(fftSize / 2);
        const imag = new Float32Array(fftSize / 2);
        const magnitude = new Float32Array(fftSize / 2);

        for (let k = 0; k < fftSize / 2; k++) {
            let realSum = 0;
            let imagSum = 0;

            for (let n = 0; n < fftSize; n++) {
                const sample = n < audioBuffer.length ? audioBuffer[n] : 0;
                const angle = -2 * Math.PI * k * n / fftSize;
                realSum += sample * Math.cos(angle);
                imagSum += sample * Math.sin(angle);
            }

            real[k] = realSum / fftSize;
            imag[k] = imagSum / fftSize;
            magnitude[k] = Math.sqrt(realSum * realSum + imagSum * imagSum) / fftSize;
        }

        return { real, imag, magnitude };
    }

    _inverseFFT(spectrum, outputLength) {
        const fftSize = spectrum.real.length * 2;
        const output = new Float32Array(outputLength);

        for (let n = 0; n < Math.min(fftSize, outputLength); n++) {
            let sum = 0;

            for (let k = 0; k < spectrum.real.length; k++) {
                const angle = 2 * Math.PI * k * n / fftSize;
                sum += spectrum.real[k] * Math.cos(angle) - spectrum.imag[k] * Math.sin(angle);
            }

            output[n] = sum * 2;  // 実数信号なので2倍
        }

        return output;
    }

    _calculateRMS(buffer) {
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            sum += buffer[i] * buffer[i];
        }
        return Math.sqrt(sum / buffer.length);
    }

    isCalibrated() {
        return this._calibrated;
    }

    isCalibrating() {
        return this._isCalibrating;
    }

    getCalibrationProgress() {
        if (!this._isCalibrating) return this._calibrated ? 1 : 0;
        return this._calibrationBuffer.length / this.calibrationFrames;
    }

    reset() {
        this._noiseProfile = null;
        this._isCalibrating = false;
        this._calibrationBuffer = [];
        this._calibrated = false;
    }
}

// Export
if (typeof window !== 'undefined') {
    window.CQTAnalyzer = CQTAnalyzer;
    window.NoiseCalibrator = NoiseCalibrator;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CQTAnalyzer, NoiseCalibrator };
}
