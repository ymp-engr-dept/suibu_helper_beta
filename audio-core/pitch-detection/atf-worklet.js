/**
 * ATFWorkletProcessor - AudioWorklet版2段階動的フィルタリング
 * 
 * 低遅延リアルタイム処理を実現
 * リングバッファ管理による追加レイテンシなし
 */

class ATFWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        const processorOptions = options.processorOptions ?? {};

        this.sampleRate = sampleRate;
        this.mode = processorOptions.mode ?? 'solo';
        this.instrument = processorOptions.instrument ?? 'default';

        this.instrumentPresets = {
            guitar: { lowFreq: 70, highFreq: 1500 },
            bass: { lowFreq: 30, highFreq: 400 },
            violin: { lowFreq: 180, highFreq: 3500 },
            cello: { lowFreq: 60, highFreq: 1000 },
            flute: { lowFreq: 250, highFreq: 2500 },
            clarinet: { lowFreq: 130, highFreq: 1500 },
            trumpet: { lowFreq: 160, highFreq: 1000 },
            saxophone: { lowFreq: 100, highFreq: 900 },
            voice: { lowFreq: 80, highFreq: 1100 },
            piano: { lowFreq: 27, highFreq: 4200 },
            default: { lowFreq: 50, highFreq: 2000 }
        };

        this.fixedBPF = this._createBiquadStages(4);
        this.trackingBPF = this._createBiquadStages(4);

        this._targetCoeffs = null;
        this._currentCoeffs = null;
        this._coeffAlpha = 0.15;

        this._emaFreq = 0;
        this._emaAlpha = 0.2;

        this._bypassed = true;
        this._confidenceThreshold = 0.3;

        this._soloQ = 2.0;
        this._ensembleQ = 4.0;

        this._ringBuffer = new Float32Array(2048);
        this._ringWriteIndex = 0;
        this._analysisBuffer = new Float32Array(1024);

        this._initializeFixedFilter();

        this.port.onmessage = (event) => this._handleMessage(event.data);
    }

    _createBiquadStages(numStages) {
        const stages = [];
        for (let i = 0; i < numStages; i++) {
            stages.push({
                b0: 1, b1: 0, b2: 0, a1: 0, a2: 0,
                x1: 0, x2: 0, y1: 0, y2: 0
            });
        }
        return stages;
    }

    _initializeFixedFilter() {
        const preset = this.instrumentPresets[this.instrument] || this.instrumentPresets.default;
        const centerFreq = Math.sqrt(preset.lowFreq * preset.highFreq);
        const bandwidth = preset.highFreq - preset.lowFreq;
        const Q = Math.max(0.5, centerFreq / bandwidth);

        const coeffs = this._computeBPFCoeffs(centerFreq, Q);
        this._applyCoeffsToStages(this.fixedBPF, coeffs);
    }

    _computeBPFCoeffs(centerFreq, Q) {
        const omega = 2 * Math.PI * centerFreq / this.sampleRate;
        const sinOmega = Math.sin(omega);
        const cosOmega = Math.cos(omega);
        const alpha = sinOmega / (2 * Q);

        const b0 = alpha;
        const b1 = 0;
        const b2 = -alpha;
        const a0 = 1 + alpha;
        const a1 = -2 * cosOmega;
        const a2 = 1 - alpha;

        return {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0
        };
    }

    _applyCoeffsToStages(stages, coeffs) {
        for (const stage of stages) {
            stage.b0 = coeffs.b0;
            stage.b1 = coeffs.b1;
            stage.b2 = coeffs.b2;
            stage.a1 = coeffs.a1;
            stage.a2 = coeffs.a2;
        }
    }

    _computeTrackingCoeffs(f0) {
        const semitonesDown = 5;
        const lowFreq = f0 * Math.pow(2, -semitonesDown / 12);
        const highFreq = f0 * 2.5;

        const centerFreq = Math.sqrt(lowFreq * highFreq);
        const bandwidth = highFreq - lowFreq;
        const baseQ = centerFreq / bandwidth;
        const Q = this.mode === 'ensemble'
            ? baseQ * this._ensembleQ / this._soloQ
            : baseQ;

        return this._computeBPFCoeffs(centerFreq, Math.max(0.5, Q));
    }

    _updateTrackingFilter(freq, confidence) {
        if (confidence < this._confidenceThreshold || !freq || freq <= 0) {
            this._bypassed = true;
            return;
        }

        this._bypassed = false;

        if (this._emaFreq <= 0) {
            this._emaFreq = freq;
        } else {
            const adaptiveAlpha = confidence > 0.8 ? this._emaAlpha * 1.5 : this._emaAlpha * 0.5;
            this._emaFreq = this._emaFreq * (1 - adaptiveAlpha) + freq * adaptiveAlpha;
        }

        this._targetCoeffs = this._computeTrackingCoeffs(this._emaFreq);

        if (this._currentCoeffs === null) {
            this._currentCoeffs = { ...this._targetCoeffs };
        } else {
            this._interpolateCoeffs();
        }

        this._applyCoeffsToStages(this.trackingBPF, this._currentCoeffs);
    }

    _interpolateCoeffs() {
        const a = this._coeffAlpha;
        const c = this._currentCoeffs;
        const t = this._targetCoeffs;

        c.b0 = c.b0 * (1 - a) + t.b0 * a;
        c.b1 = c.b1 * (1 - a) + t.b1 * a;
        c.b2 = c.b2 * (1 - a) + t.b2 * a;
        c.a1 = c.a1 * (1 - a) + t.a1 * a;
        c.a2 = c.a2 * (1 - a) + t.a2 * a;
    }

    _processBiquad(sample, stage) {
        const y = stage.b0 * sample + stage.b1 * stage.x1 + stage.b2 * stage.x2
            - stage.a1 * stage.y1 - stage.a2 * stage.y2;

        stage.x2 = stage.x1;
        stage.x1 = sample;
        stage.y2 = stage.y1;
        stage.y1 = y;

        return y;
    }

    _processFilterCascade(sample, stages) {
        let x = sample;
        for (const stage of stages) {
            x = this._processBiquad(x, stage);
        }
        return x;
    }

    _fastACF() {
        const buffer = this._analysisBuffer;
        const n = buffer.length;
        const halfN = Math.floor(n / 2);

        const preset = this.instrumentPresets[this.instrument] || this.instrumentPresets.default;
        const minPeriod = Math.floor(this.sampleRate / preset.highFreq);
        const maxPeriod = Math.min(Math.floor(this.sampleRate / preset.lowFreq), halfN - 1);

        let bestPeriod = minPeriod;
        let bestNSDF = -Infinity;

        for (let tau = minPeriod; tau <= maxPeriod; tau += 2) {
            let acf = 0;
            let m = 0;

            for (let i = 0; i < halfN - tau; i += 2) {
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

        const freq = this.sampleRate / bestPeriod;
        return { freq, confidence: Math.min(1, bestNSDF) };
    }

    _handleMessage(data) {
        switch (data.type) {
            case 'setMode':
                this.mode = data.value;
                break;

            case 'setInstrument':
                this.instrument = data.value;
                this._initializeFixedFilter();
                break;

            case 'updatePitch':
                this._updateTrackingFilter(data.freq, data.confidence);
                break;

            case 'reset':
                this._reset();
                break;
        }
    }

    _reset() {
        for (const stage of this.fixedBPF) {
            stage.x1 = stage.x2 = stage.y1 = stage.y2 = 0;
        }
        for (const stage of this.trackingBPF) {
            stage.x1 = stage.x2 = stage.y1 = stage.y2 = 0;
        }
        this._emaFreq = 0;
        this._bypassed = true;
        this._targetCoeffs = null;
        this._currentCoeffs = null;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0] || input[0].length === 0) {
            return true;
        }

        const inputChannel = input[0];
        const outputChannel = output[0];
        const blockSize = inputChannel.length;

        for (let i = 0; i < blockSize; i++) {
            this._ringBuffer[this._ringWriteIndex] = inputChannel[i];
            this._ringWriteIndex = (this._ringWriteIndex + 1) % this._ringBuffer.length;
        }

        if (this._ringWriteIndex % 128 === 0) {
            const startIdx = (this._ringWriteIndex - this._analysisBuffer.length + this._ringBuffer.length) % this._ringBuffer.length;
            for (let i = 0; i < this._analysisBuffer.length; i++) {
                const idx = (startIdx + i) % this._ringBuffer.length;
                this._analysisBuffer[i] = this._processFilterCascade(this._ringBuffer[idx], this.fixedBPF);
            }

            const coarse = this._fastACF();
            if (coarse.freq) {
                this._updateTrackingFilter(coarse.freq, coarse.confidence);
            }

            this.port.postMessage({
                type: 'coarseEstimate',
                freq: coarse.freq,
                confidence: coarse.confidence,
                trackingFreq: this._emaFreq,
                bypassed: this._bypassed
            });
        }

        for (let i = 0; i < blockSize; i++) {
            let sample = inputChannel[i];

            if (this._bypassed) {
                sample = this._processFilterCascade(sample, this.fixedBPF);
            } else {
                sample = this._processFilterCascade(sample, this.trackingBPF);
            }

            outputChannel[i] = sample;
        }

        return true;
    }
}

registerProcessor('atf-worklet-processor', ATFWorkletProcessor);
