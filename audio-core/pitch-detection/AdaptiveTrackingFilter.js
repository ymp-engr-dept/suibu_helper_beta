/**
 * AdaptiveTrackingFilter - 2段階動的フィルタリングシステム
 * 
 * ミサイル誘導システムのように正確にターゲット音を追跡
 * 
 * Stage 1: 粗推定 (Coarse Estimation)
 *   - 楽器カテゴリ帯域の固定BPF
 *   - 高速ACFによる暫定ピッチ推定
 * 
 * Stage 2: 精密推定 (Fine Estimation with ATF)
 *   - 動的4次バターワースBPF (f0±5半音 ～ 2.5*f0)
 *   - 係数線形補間によるジッパーノイズ防止
 *   - EMA平滑化によるジッター抑制
 */

class AdaptiveTrackingFilter {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate ?? 48000;
        this.mode = options.mode ?? 'solo';

        this.instrumentPresets = {
            guitar: { lowFreq: 70, highFreq: 1500, name: 'Guitar' },
            bass: { lowFreq: 30, highFreq: 400, name: 'Bass' },
            violin: { lowFreq: 180, highFreq: 3500, name: 'Violin' },
            cello: { lowFreq: 60, highFreq: 1000, name: 'Cello' },
            flute: { lowFreq: 250, highFreq: 2500, name: 'Flute' },
            clarinet: { lowFreq: 130, highFreq: 1500, name: 'Clarinet' },
            trumpet: { lowFreq: 160, highFreq: 1000, name: 'Trumpet' },
            saxophone: { lowFreq: 100, highFreq: 900, name: 'Saxophone' },
            voice: { lowFreq: 80, highFreq: 1100, name: 'Voice' },
            piano: { lowFreq: 27, highFreq: 4200, name: 'Piano' },
            default: { lowFreq: 50, highFreq: 2000, name: 'Default' }
        };

        this.currentInstrument = options.instrument ?? 'default';

        this.fixedBPF = new BiquadCascade(4);
        this.trackingBPF = new BiquadCascade(4);

        this._targetCoeffs = null;
        this._currentCoeffs = null;
        this._coeffInterpolationAlpha = 0.15;

        this._emaFreq = 0;
        this._emaAlpha = 0.2;
        this._lastValidFreq = 0;

        this._confidenceThreshold = 0.3;
        this._bypassed = true;

        this._soloQ = 2.0;
        this._ensembleQ = 4.0;

        this._coarseBuffer = new Float32Array(1024);
        this._fineBuffer = new Float32Array(2048);

        this._initialized = false;

        this._initializeFixedFilter();
    }

    _initializeFixedFilter() {
        const preset = this.instrumentPresets[this.currentInstrument] || this.instrumentPresets.default;
        const centerFreq = Math.sqrt(preset.lowFreq * preset.highFreq);
        const bandwidth = preset.highFreq - preset.lowFreq;
        const Q = centerFreq / bandwidth;

        const coeffs = this._computeButterworthBPF(centerFreq, Math.max(0.5, Q), this.sampleRate);
        this.fixedBPF.setCoefficients(coeffs);

        this._initialized = true;
    }

    setInstrument(instrumentName) {
        this.currentInstrument = instrumentName;
        this._initializeFixedFilter();
        this.reset();
    }

    setMode(mode) {
        this.mode = mode;
    }

    setSampleRate(sampleRate) {
        if (this.sampleRate !== sampleRate) {
            this.sampleRate = sampleRate;
            this._initializeFixedFilter();
            this.reset();
        }
    }

    _computeButterworthBPF(centerFreq, Q, sampleRate) {
        const omega = 2 * Math.PI * centerFreq / sampleRate;
        const sinOmega = Math.sin(omega);
        const cosOmega = Math.cos(omega);
        const alpha = sinOmega / (2 * Q);

        const b0 = alpha;
        const b1 = 0;
        const b2 = -alpha;
        const a0 = 1 + alpha;
        const a1 = -2 * cosOmega;
        const a2 = 1 - alpha;

        const coeffsNormalized = {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0
        };

        return [coeffsNormalized, coeffsNormalized, coeffsNormalized, coeffsNormalized];
    }

    _computeTrackingBPF(f0, sampleRate) {
        const semitonesDown = 5;
        const lowFreq = f0 * Math.pow(2, -semitonesDown / 12);
        const highFreq = f0 * 2.5;

        const centerFreq = Math.sqrt(lowFreq * highFreq);
        const bandwidth = highFreq - lowFreq;
        const baseQ = centerFreq / bandwidth;
        const Q = this.mode === 'ensemble' ? baseQ * this._ensembleQ / this._soloQ : baseQ;

        return this._computeButterworthBPF(centerFreq, Math.max(0.5, Q), sampleRate);
    }

    updateCoefficients(targetFreq, sampleRate, confidence = 1.0) {
        if (sampleRate !== this.sampleRate) {
            this.setSampleRate(sampleRate);
        }

        if (confidence < this._confidenceThreshold || !targetFreq || targetFreq <= 0) {
            this._bypassed = true;
            return;
        }

        this._bypassed = false;

        if (this._emaFreq <= 0) {
            this._emaFreq = targetFreq;
        } else {
            const adaptiveAlpha = confidence > 0.8 ? this._emaAlpha * 1.5 : this._emaAlpha * 0.5;
            this._emaFreq = this._emaFreq * (1 - adaptiveAlpha) + targetFreq * adaptiveAlpha;
        }

        this._lastValidFreq = this._emaFreq;
        this._targetCoeffs = this._computeTrackingBPF(this._emaFreq, sampleRate);

        if (this._currentCoeffs === null) {
            this._currentCoeffs = this._targetCoeffs.map(c => ({ ...c }));
        } else {
            this._interpolateCoefficients();
        }

        this.trackingBPF.setCoefficients(this._currentCoeffs);
    }

    _interpolateCoefficients() {
        const alpha = this._coeffInterpolationAlpha;

        for (let i = 0; i < this._currentCoeffs.length; i++) {
            const current = this._currentCoeffs[i];
            const target = this._targetCoeffs[i];

            current.b0 = current.b0 * (1 - alpha) + target.b0 * alpha;
            current.b1 = current.b1 * (1 - alpha) + target.b1 * alpha;
            current.b2 = current.b2 * (1 - alpha) + target.b2 * alpha;
            current.a1 = current.a1 * (1 - alpha) + target.a1 * alpha;
            current.a2 = current.a2 * (1 - alpha) + target.a2 * alpha;
        }
    }

    processStage1(inputBuffer) {
        const outputBuffer = new Float32Array(inputBuffer.length);

        for (let i = 0; i < inputBuffer.length; i++) {
            outputBuffer[i] = this.fixedBPF.process(inputBuffer[i]);
        }

        return outputBuffer;
    }

    processStage2(inputBuffer) {
        if (this._bypassed) {
            return this.processStage1(inputBuffer);
        }

        const outputBuffer = new Float32Array(inputBuffer.length);

        for (let i = 0; i < inputBuffer.length; i++) {
            outputBuffer[i] = this.trackingBPF.process(inputBuffer[i]);
        }

        return outputBuffer;
    }

    processFullPipeline(inputBuffer, coarseFreq = null, confidence = 0) {
        const stage1Output = this.processStage1(inputBuffer);

        if (coarseFreq && confidence > this._confidenceThreshold) {
            this.updateCoefficients(coarseFreq, this.sampleRate, confidence);
            return this.processStage2(inputBuffer);
        }

        return stage1Output;
    }

    getCoarseEstimate(buffer, sampleRate) {
        const filtered = this.processStage1(buffer);
        return this._fastACF(filtered, sampleRate);
    }

    _fastACF(buffer, sampleRate) {
        const n = buffer.length;
        const halfN = Math.floor(n / 2);

        const preset = this.instrumentPresets[this.currentInstrument] || this.instrumentPresets.default;
        const minPeriod = Math.floor(sampleRate / preset.highFreq);
        const maxPeriod = Math.min(Math.floor(sampleRate / preset.lowFreq), halfN - 1);

        let bestPeriod = minPeriod;
        let bestNSDF = -Infinity;

        for (let tau = minPeriod; tau <= maxPeriod; tau++) {
            let acf = 0;
            let m = 0;

            for (let i = 0; i < halfN - tau; i++) {
                acf += buffer[i] * buffer[i + tau];
                m += buffer[i] * buffer[i] + buffer[i + tau] * buffer[i + tau];
            }

            const nsdf = m > 0 ? 2 * acf / m : 0;

            if (nsdf > bestNSDF && nsdf > 0.3) {
                bestNSDF = nsdf;
                bestPeriod = tau;
            }
        }

        if (bestNSDF < 0.3) {
            return { freq: null, confidence: 0 };
        }

        let refinedPeriod = bestPeriod;
        if (bestPeriod > minPeriod && bestPeriod < maxPeriod) {
            const y0 = this._nsdfAtTau(buffer, halfN, bestPeriod - 1);
            const y1 = bestNSDF;
            const y2 = this._nsdfAtTau(buffer, halfN, bestPeriod + 1);
            const denom = y0 - 2 * y1 + y2;
            if (Math.abs(denom) > 1e-10) {
                const delta = 0.5 * (y0 - y2) / denom;
                refinedPeriod = bestPeriod + Math.max(-1, Math.min(1, delta));
            }
        }

        const freq = sampleRate / refinedPeriod;
        const confidence = Math.min(1, bestNSDF);

        return { freq, confidence };
    }

    _nsdfAtTau(buffer, halfN, tau) {
        let acf = 0;
        let m = 0;

        for (let i = 0; i < halfN - tau; i++) {
            acf += buffer[i] * buffer[i + tau];
            m += buffer[i] * buffer[i] + buffer[i + tau] * buffer[i + tau];
        }

        return m > 0 ? 2 * acf / m : 0;
    }

    isBypassed() {
        return this._bypassed;
    }

    getTrackingFrequency() {
        return this._emaFreq;
    }

    reset() {
        this.fixedBPF.reset();
        this.trackingBPF.reset();
        this._targetCoeffs = null;
        this._currentCoeffs = null;
        this._emaFreq = 0;
        this._lastValidFreq = 0;
        this._bypassed = true;
    }
}

/**
 * BiquadCascade - 4次バターワースフィルタ用カスケード双二次フィルタ
 */
class BiquadCascade {
    constructor(numStages = 4) {
        this.numStages = numStages;
        this.coefficients = [];
        this.states = [];

        for (let i = 0; i < numStages; i++) {
            this.coefficients.push({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });
            this.states.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
        }
    }

    setCoefficients(coeffsArray) {
        for (let i = 0; i < Math.min(coeffsArray.length, this.numStages); i++) {
            const c = coeffsArray[i];
            this.coefficients[i].b0 = c.b0;
            this.coefficients[i].b1 = c.b1;
            this.coefficients[i].b2 = c.b2;
            this.coefficients[i].a1 = c.a1;
            this.coefficients[i].a2 = c.a2;
        }
    }

    process(sample) {
        let x = sample;

        for (let i = 0; i < this.numStages; i++) {
            const c = this.coefficients[i];
            const s = this.states[i];

            const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;

            s.x2 = s.x1;
            s.x1 = x;
            s.y2 = s.y1;
            s.y1 = y;

            x = y;
        }

        return x;
    }

    reset() {
        for (let i = 0; i < this.numStages; i++) {
            this.states[i].x1 = 0;
            this.states[i].x2 = 0;
            this.states[i].y1 = 0;
            this.states[i].y2 = 0;
        }
    }
}

/**
 * TwoStageAnalyzer - 2段階解析統合クラス
 */
class TwoStageAnalyzer {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate ?? 48000;
        this.mode = options.mode ?? 'solo';

        this.atf = new AdaptiveTrackingFilter({
            sampleRate: this.sampleRate,
            mode: this.mode,
            instrument: options.instrument ?? 'default'
        });

        this._lastCoarseResult = null;
        this._lastFineResult = null;
    }

    setSampleRate(sampleRate) {
        this.sampleRate = sampleRate;
        this.atf.setSampleRate(sampleRate);
    }

    setMode(mode) {
        this.mode = mode;
        this.atf.setMode(mode);
    }

    setInstrument(instrument) {
        this.atf.setInstrument(instrument);
    }

    analyze(inputBuffer, sampleRate) {
        if (sampleRate !== this.sampleRate) {
            this.setSampleRate(sampleRate);
        }

        const coarse = this.atf.getCoarseEstimate(inputBuffer, sampleRate);
        this._lastCoarseResult = coarse;

        if (coarse.freq && coarse.confidence > 0.3) {
            this.atf.updateCoefficients(coarse.freq, sampleRate, coarse.confidence);
            const refinedBuffer = this.atf.processStage2(inputBuffer);

            return {
                buffer: refinedBuffer,
                coarseFreq: coarse.freq,
                coarseConfidence: coarse.confidence,
                trackingFreq: this.atf.getTrackingFrequency(),
                bypassed: this.atf.isBypassed()
            };
        }

        const stage1Buffer = this.atf.processStage1(inputBuffer);

        return {
            buffer: stage1Buffer,
            coarseFreq: null,
            coarseConfidence: 0,
            trackingFreq: null,
            bypassed: true
        };
    }

    reset() {
        this.atf.reset();
        this._lastCoarseResult = null;
        this._lastFineResult = null;
    }
}

if (typeof window !== 'undefined') {
    window.AdaptiveTrackingFilter = AdaptiveTrackingFilter;
    window.BiquadCascade = BiquadCascade;
    window.TwoStageAnalyzer = TwoStageAnalyzer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AdaptiveTrackingFilter, BiquadCascade, TwoStageAnalyzer };
}
