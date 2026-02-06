/**
 * EnhancedYIN - pYIN互換の確率的YINアルゴリズム
 * 累積平均正規化差関数（CMNDF）を使用
 */
class EnhancedYIN {
    constructor(options = {}) {
        this.threshold = options.threshold ?? 0.1;
        this.minFreq = options.minFreq ?? 50;
        this.maxFreq = options.maxFreq ?? 2000;
        this.probabilityThreshold = options.probabilityThreshold ?? 0.01;

        this._buffer = null;
        this._probabilityBuffer = null;
    }

    _ensureBuffers(size) {
        const halfSize = Math.floor(size / 2);
        if (!this._buffer || this._buffer.length !== halfSize) {
            this._buffer = new Float32Array(halfSize);
            this._probabilityBuffer = new Float32Array(halfSize);
        }
    }

    _differenceFunction(signal, tau) {
        const halfSize = Math.floor(signal.length / 2);
        let sum = 0;
        for (let i = 0; i < halfSize; i++) {
            const delta = signal[i] - signal[i + tau];
            sum += delta * delta;
        }
        return sum;
    }

    _cumulativeMeanNormalizedDifference(signal) {
        const halfSize = Math.floor(signal.length / 2);
        this._ensureBuffers(signal.length);

        this._buffer[0] = 1;
        let runningSum = 0;

        for (let tau = 1; tau < halfSize; tau++) {
            const diff = this._differenceFunction(signal, tau);
            runningSum += diff;
            this._buffer[tau] = runningSum > 0 ? diff * tau / runningSum : 1;
        }

        return this._buffer;
    }

    _absoluteThreshold(cmndf, sampleRate) {
        const minPeriod = Math.floor(sampleRate / this.maxFreq);
        const maxPeriod = Math.min(Math.floor(sampleRate / this.minFreq), cmndf.length - 1);

        let bestTau = -1;
        let bestValue = Infinity;

        for (let tau = minPeriod; tau <= maxPeriod; tau++) {
            if (cmndf[tau] < this.threshold) {
                while (tau + 1 <= maxPeriod && cmndf[tau + 1] < cmndf[tau]) {
                    tau++;
                }
                if (cmndf[tau] < bestValue) {
                    bestValue = cmndf[tau];
                    bestTau = tau;
                }
                break;
            }
        }

        if (bestTau < 0) {
            for (let tau = minPeriod; tau <= maxPeriod; tau++) {
                if (cmndf[tau] < bestValue) {
                    bestValue = cmndf[tau];
                    bestTau = tau;
                }
            }
        }

        return { tau: bestTau, value: bestValue };
    }

    _parabolicInterpolation(array, x) {
        if (x <= 0 || x >= array.length - 1) return x;

        const s0 = array[x - 1];
        const s1 = array[x];
        const s2 = array[x + 1];

        const denominator = s0 - 2 * s1 + s2;
        if (Math.abs(denominator) < 1e-10) return x;

        const delta = 0.5 * (s0 - s2) / denominator;
        return x + delta;
    }

    _computeProbabilities(cmndf, sampleRate) {
        const minPeriod = Math.floor(sampleRate / this.maxFreq);
        const maxPeriod = Math.min(Math.floor(sampleRate / this.minFreq), cmndf.length - 1);

        this._probabilityBuffer.fill(0);

        for (let tau = minPeriod; tau <= maxPeriod; tau++) {
            if (tau > 0 && tau < cmndf.length - 1) {
                if (cmndf[tau] < cmndf[tau - 1] && cmndf[tau] < cmndf[tau + 1]) {
                    const prob = 1 - cmndf[tau];
                    if (prob > this.probabilityThreshold) {
                        this._probabilityBuffer[tau] = prob;
                    }
                }
            }
        }

        return this._probabilityBuffer;
    }

    analyze(signal, sampleRate) {
        const cmndf = this._cumulativeMeanNormalizedDifference(signal);
        const result = this._absoluteThreshold(cmndf, sampleRate);

        if (result.tau < 0) {
            return { freq: null, confidence: 0, candidates: [] };
        }

        const refinedTau = this._parabolicInterpolation(cmndf, result.tau);
        const freq = sampleRate / refinedTau;
        const confidence = 1 - result.value;

        const probabilities = this._computeProbabilities(cmndf, sampleRate);
        const candidates = [];
        for (let tau = 0; tau < probabilities.length; tau++) {
            if (probabilities[tau] > this.probabilityThreshold) {
                const refinedTau = this._parabolicInterpolation(cmndf, tau);
                candidates.push({
                    freq: sampleRate / refinedTau,
                    probability: probabilities[tau]
                });
            }
        }
        candidates.sort((a, b) => b.probability - a.probability);

        return {
            freq,
            confidence,
            candidates: candidates.slice(0, 5)
        };
    }
}

/**
 * NSDF - 正規化二乗差関数（McLeod Pitch Method改良版）
 */
class NSDF {
    constructor(options = {}) {
        this.threshold = options.threshold ?? 0.8;
        this.minFreq = options.minFreq ?? 50;
        this.maxFreq = options.maxFreq ?? 2000;

        this._nsdfBuffer = null;
    }

    _ensureBuffer(size) {
        const halfSize = Math.floor(size / 2);
        if (!this._nsdfBuffer || this._nsdfBuffer.length !== halfSize) {
            this._nsdfBuffer = new Float32Array(halfSize);
        }
    }

    _computeNSDF(signal) {
        const n = signal.length;
        const halfSize = Math.floor(n / 2);
        this._ensureBuffer(n);

        for (let tau = 0; tau < halfSize; tau++) {
            let acf = 0;
            let m = 0;
            for (let i = 0; i < halfSize; i++) {
                acf += signal[i] * signal[i + tau];
                m += signal[i] * signal[i] + signal[i + tau] * signal[i + tau];
            }
            this._nsdfBuffer[tau] = m > 0 ? 2 * acf / m : 0;
        }

        return this._nsdfBuffer;
    }

    _findPeaks(nsdf, sampleRate) {
        const minPeriod = Math.floor(sampleRate / this.maxFreq);
        const maxPeriod = Math.min(Math.floor(sampleRate / this.minFreq), nsdf.length - 1);

        const peaks = [];

        for (let tau = minPeriod; tau <= maxPeriod - 1; tau++) {
            if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1]) {
                if (nsdf[tau] > 0) {
                    peaks.push({ tau, value: nsdf[tau] });
                }
            }
        }

        return peaks;
    }

    _parabolicInterpolation(array, x) {
        if (x <= 0 || x >= array.length - 1) return { index: x, value: array[x] };

        const y0 = array[x - 1];
        const y1 = array[x];
        const y2 = array[x + 1];

        const denominator = y0 - 2 * y1 + y2;
        if (Math.abs(denominator) < 1e-10) return { index: x, value: y1 };

        const delta = 0.5 * (y0 - y2) / denominator;
        const refinedValue = y1 - 0.25 * (y0 - y2) * delta;

        return { index: x + delta, value: refinedValue };
    }

    analyze(signal, sampleRate) {
        const nsdf = this._computeNSDF(signal);
        const peaks = this._findPeaks(nsdf, sampleRate);

        if (peaks.length === 0) {
            return { freq: null, confidence: 0 };
        }

        let maxValue = 0;
        for (const peak of peaks) {
            if (peak.value > maxValue) maxValue = peak.value;
        }

        const thresholdValue = maxValue * this.threshold;
        let bestPeak = null;

        for (const peak of peaks) {
            if (peak.value >= thresholdValue) {
                bestPeak = peak;
                break;
            }
        }

        if (!bestPeak) {
            bestPeak = peaks.reduce((a, b) => a.value > b.value ? a : b);
        }

        const refined = this._parabolicInterpolation(nsdf, bestPeak.tau);
        const freq = sampleRate / refined.index;
        const confidence = refined.value;

        return { freq, confidence };
    }
}

/**
 * HarmonicAnalyzer - 調波構造解析（HarmoF0代替）
 * オクターブエラー検出・補正、倍音エネルギー分布解析
 */
class HarmonicAnalyzer {
    constructor(options = {}) {
        this.numHarmonics = options.numHarmonics ?? 8;
        this.tolerance = options.tolerance ?? 0.05;
        this.minFreq = options.minFreq ?? 50;
        this.maxFreq = options.maxFreq ?? 2000;

        this._fft = null;
        this._fftSize = 0;
        this._realBuffer = null;
        this._imagBuffer = null;
        this._magnitudeBuffer = null;
    }

    _ensureFFT(size) {
        if (this._fftSize !== size) {
            this._fftSize = size;
            this._fft = new (window.FFT || FFT)(size);
            this._realBuffer = new Float32Array(size);
            this._imagBuffer = new Float32Array(size);
            this._magnitudeBuffer = new Float32Array(size / 2);
        }
    }

    _computeSpectrum(signal) {
        const size = signal.length;
        this._ensureFFT(size);

        this._realBuffer.set(signal);
        this._imagBuffer.fill(0);

        this._fft.forward(this._realBuffer, this._imagBuffer);
        this._fft.getMagnitude(this._realBuffer, this._imagBuffer, this._magnitudeBuffer);

        return this._magnitudeBuffer;
    }

    _findSpectralPeaks(magnitude, sampleRate) {
        const binSize = sampleRate / (magnitude.length * 2);
        const minBin = Math.floor(this.minFreq / binSize);
        const maxBin = Math.min(Math.floor(this.maxFreq / binSize), magnitude.length - 2);

        const peaks = [];

        for (let i = Math.max(1, minBin); i <= maxBin; i++) {
            if (magnitude[i] > magnitude[i - 1] && magnitude[i] >= magnitude[i + 1]) {
                const y0 = magnitude[i - 1];
                const y1 = magnitude[i];
                const y2 = magnitude[i + 1];
                const denom = y0 - 2 * y1 + y2;
                let refinedBin = i;
                if (Math.abs(denom) > 1e-10) {
                    refinedBin = i + 0.5 * (y0 - y2) / denom;
                }

                peaks.push({
                    freq: refinedBin * binSize,
                    magnitude: y1,
                    bin: refinedBin
                });
            }
        }

        peaks.sort((a, b) => b.magnitude - a.magnitude);
        return peaks.slice(0, 20);
    }

    _evaluateHarmonicSeries(f0, peaks, maxMagnitude) {
        let score = 0;
        let harmonicCount = 0;
        let totalEnergy = 0;

        for (let h = 1; h <= this.numHarmonics; h++) {
            const expectedFreq = f0 * h;
            if (expectedFreq > this.maxFreq * 2) break;

            let bestMatch = null;
            let bestError = Infinity;

            for (const peak of peaks) {
                const error = Math.abs(peak.freq - expectedFreq) / expectedFreq;
                if (error < this.tolerance && error < bestError) {
                    bestError = error;
                    bestMatch = peak;
                }
            }

            if (bestMatch) {
                const harmonicWeight = 1 / h;
                const magnitudeScore = bestMatch.magnitude / maxMagnitude;
                const errorPenalty = 1 - bestError / this.tolerance;

                score += harmonicWeight * magnitudeScore * errorPenalty;
                harmonicCount++;
                totalEnergy += bestMatch.magnitude;
            }
        }

        return {
            score,
            harmonicCount,
            totalEnergy,
            harmonicIntegrity: harmonicCount / this.numHarmonics
        };
    }

    analyze(signal, sampleRate, candidateFreq = null) {
        const magnitude = this._computeSpectrum(signal);
        const peaks = this._findSpectralPeaks(magnitude, sampleRate);

        if (peaks.length === 0) {
            return { freq: null, confidence: 0, harmonicIntegrity: 0 };
        }

        const maxMagnitude = peaks[0].magnitude;

        const candidates = [];

        if (candidateFreq && candidateFreq >= this.minFreq && candidateFreq <= this.maxFreq) {
            candidates.push(candidateFreq);
            candidates.push(candidateFreq * 2);
            candidates.push(candidateFreq / 2);
        }

        for (const peak of peaks.slice(0, 5)) {
            for (let divisor = 1; divisor <= 4; divisor++) {
                const f0 = peak.freq / divisor;
                if (f0 >= this.minFreq && f0 <= this.maxFreq) {
                    candidates.push(f0);
                }
            }
        }

        let bestResult = null;
        let bestScore = -Infinity;

        for (const f0 of candidates) {
            const result = this._evaluateHarmonicSeries(f0, peaks, maxMagnitude);
            if (result.score > bestScore) {
                bestScore = result.score;
                bestResult = { f0, ...result };
            }
        }

        if (!bestResult || bestResult.harmonicCount < 2) {
            return { freq: null, confidence: 0, harmonicIntegrity: 0 };
        }

        return {
            freq: bestResult.f0,
            confidence: Math.min(1, bestResult.score),
            harmonicIntegrity: bestResult.harmonicIntegrity,
            harmonicCount: bestResult.harmonicCount
        };
    }

    detectOctaveError(yinFreq, nsdfFreq, harmonicFreq) {
        if (!yinFreq || !nsdfFreq) return null;

        const freqs = [yinFreq, nsdfFreq];
        if (harmonicFreq) freqs.push(harmonicFreq);

        freqs.sort((a, b) => a - b);

        for (let i = 0; i < freqs.length - 1; i++) {
            const ratio = freqs[i + 1] / freqs[i];
            if (ratio > 1.9 && ratio < 2.1) {
                return {
                    hasOctaveError: true,
                    correctedFreq: Math.min(...freqs)
                };
            }
        }

        return { hasOctaveError: false, correctedFreq: null };
    }
}

if (typeof window !== 'undefined') {
    window.EnhancedYIN = EnhancedYIN;
    window.NSDF = NSDF;
    window.HarmonicAnalyzer = HarmonicAnalyzer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EnhancedYIN, NSDF, HarmonicAnalyzer };
}
