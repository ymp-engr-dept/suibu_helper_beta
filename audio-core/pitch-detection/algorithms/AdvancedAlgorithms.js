/**
 * PEFAC - Pitch Estimation Filter with Amplitude Compression
 * 対数周波数領域での振幅圧縮によりSNRがマイナスの環境にも対応
 * 
 * Reference: Gonzalez, S., & Brookes, M. (2014). PEFAC - A Pitch Estimation Algorithm 
 * Robust to High Levels of Noise. IEEE/ACM Transactions on Audio, Speech, and Language Processing.
 */
class PEFAC {
    constructor(options = {}) {
        this.minFreq = options.minFreq ?? 50;
        this.maxFreq = options.maxFreq ?? 500;
        this.numFilters = options.numFilters ?? 128;
        this.compressionFactor = options.compressionFactor ?? 0.33;

        this._filterBank = null;
        this._lastSampleRate = 0;
        this._logFreqSpectrum = null;
        this._cueFunction = null;
    }

    _createLogFilterBank(fftSize, sampleRate) {
        if (this._filterBank && this._lastSampleRate === sampleRate) {
            return this._filterBank;
        }

        this._lastSampleRate = sampleRate;
        const binSize = sampleRate / fftSize;
        const numBins = fftSize / 2;

        const minLogFreq = Math.log(this.minFreq);
        const maxLogFreq = Math.log(this.maxFreq * 4);
        const logStep = (maxLogFreq - minLogFreq) / this.numFilters;

        this._filterBank = [];

        for (let i = 0; i < this.numFilters; i++) {
            const centerLogFreq = minLogFreq + (i + 0.5) * logStep;
            const centerFreq = Math.exp(centerLogFreq);
            const lowFreq = Math.exp(centerLogFreq - logStep / 2);
            const highFreq = Math.exp(centerLogFreq + logStep / 2);

            const lowBin = Math.floor(lowFreq / binSize);
            const centerBin = Math.round(centerFreq / binSize);
            const highBin = Math.ceil(highFreq / binSize);

            const filter = {
                centerFreq,
                lowBin: Math.max(0, lowBin),
                centerBin: Math.min(numBins - 1, centerBin),
                highBin: Math.min(numBins - 1, highBin)
            };

            this._filterBank.push(filter);
        }

        this._logFreqSpectrum = new Float32Array(this.numFilters);
        this._cueFunction = new Float32Array(this.numFilters);

        return this._filterBank;
    }

    _applyFilterBank(magnitude, filterBank) {
        for (let i = 0; i < filterBank.length; i++) {
            const filter = filterBank[i];
            let sum = 0;
            let count = 0;

            for (let bin = filter.lowBin; bin <= filter.highBin; bin++) {
                if (bin >= 0 && bin < magnitude.length) {
                    sum += magnitude[bin];
                    count++;
                }
            }

            this._logFreqSpectrum[i] = count > 0 ? sum / count : 0;
        }

        return this._logFreqSpectrum;
    }

    _applyAmplitudeCompression(spectrum) {
        for (let i = 0; i < spectrum.length; i++) {
            if (spectrum[i] > 0) {
                spectrum[i] = Math.pow(spectrum[i], this.compressionFactor);
            }
        }
    }

    _computeCueFunction(spectrum) {
        const n = spectrum.length;

        for (let lag = 0; lag < n; lag++) {
            let sum = 0;
            let count = 0;

            for (let i = 0; i < n - lag; i++) {
                sum += spectrum[i] * spectrum[i + lag];
                count++;
            }

            this._cueFunction[lag] = count > 0 ? sum / count : 0;
        }

        const maxCue = Math.max(...this._cueFunction);
        if (maxCue > 0) {
            for (let i = 0; i < n; i++) {
                this._cueFunction[i] /= maxCue;
            }
        }

        return this._cueFunction;
    }

    _findF0Candidates(cueFunction, filterBank) {
        const candidates = [];

        const minLogFreq = Math.log(this.minFreq);
        const maxLogFreq = Math.log(this.maxFreq * 4);
        const logStep = (maxLogFreq - minLogFreq) / this.numFilters;

        const minLag = Math.floor((Math.log(this.maxFreq) - minLogFreq) / logStep);
        const maxLag = Math.ceil((Math.log(this.minFreq * 4) - minLogFreq) / logStep);

        for (let lag = Math.max(1, minLag); lag < Math.min(maxLag, cueFunction.length - 1); lag++) {
            if (cueFunction[lag] > cueFunction[lag - 1] &&
                cueFunction[lag] >= cueFunction[lag + 1] &&
                cueFunction[lag] > 0.3) {

                const logPeriod = lag * logStep;
                const period = Math.exp(logPeriod);
                const freq = 1 / period * 1000;

                if (freq >= this.minFreq && freq <= this.maxFreq) {
                    candidates.push({
                        freq,
                        confidence: cueFunction[lag],
                        lag
                    });
                }
            }
        }

        candidates.sort((a, b) => b.confidence - a.confidence);
        return candidates.slice(0, 5);
    }

    analyze(magnitude, sampleRate) {
        const fftSize = magnitude.length * 2;
        const filterBank = this._createLogFilterBank(fftSize, sampleRate);

        const logSpectrum = this._applyFilterBank(magnitude, filterBank);
        this._applyAmplitudeCompression(logSpectrum);

        const cueFunction = this._computeCueFunction(logSpectrum);
        const candidates = this._findF0Candidates(cueFunction, filterBank);

        if (candidates.length === 0) {
            return { freq: null, confidence: 0, candidates: [] };
        }

        return {
            freq: candidates[0].freq,
            confidence: candidates[0].confidence,
            candidates
        };
    }
}

/**
 * SalienceMap - 2D確率マップ生成（時間×周波数）
 * 調波カーネル畳み込みとピーク追跡
 */
class SalienceMap {
    constructor(options = {}) {
        this.minFreq = options.minFreq ?? 50;
        this.maxFreq = options.maxFreq ?? 2000;
        this.binsPerOctave = options.binsPerOctave ?? 60;
        this.numHarmonics = options.numHarmonics ?? 8;
        this.harmonicWeights = options.harmonicWeights ?? [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2];

        this._freqBins = null;
        this._salienceBuffer = null;
        this._history = [];
        this._maxHistory = options.maxHistory ?? 30;
    }

    _createFreqBins() {
        if (this._freqBins) return this._freqBins;

        const numOctaves = Math.log2(this.maxFreq / this.minFreq);
        const numBins = Math.ceil(numOctaves * this.binsPerOctave);

        this._freqBins = new Float32Array(numBins);
        this._salienceBuffer = new Float32Array(numBins);

        for (let i = 0; i < numBins; i++) {
            const cents = i * (1200 / this.binsPerOctave);
            this._freqBins[i] = this.minFreq * Math.pow(2, cents / 1200);
        }

        return this._freqBins;
    }

    _freqToBin(freq) {
        if (freq < this.minFreq) return 0;
        if (freq > this._freqBins[this._freqBins.length - 1]) return this._freqBins.length - 1;

        const cents = 1200 * Math.log2(freq / this.minFreq);
        return Math.round(cents / (1200 / this.binsPerOctave));
    }

    _computeSalience(magnitude, sampleRate) {
        const freqBins = this._createFreqBins();
        const binSize = sampleRate / (magnitude.length * 2);

        this._salienceBuffer.fill(0);

        const maxMag = Math.max(...magnitude);
        if (maxMag === 0) return this._salienceBuffer;

        for (let i = 0; i < freqBins.length; i++) {
            const f0 = freqBins[i];
            let salience = 0;

            for (let h = 1; h <= this.numHarmonics; h++) {
                const harmonicFreq = f0 * h;
                const spectralBin = Math.round(harmonicFreq / binSize);

                if (spectralBin >= 0 && spectralBin < magnitude.length) {
                    const weight = this.harmonicWeights[h - 1] || (1 / h);
                    const magValue = magnitude[spectralBin] / maxMag;
                    salience += weight * magValue;
                }
            }

            this._salienceBuffer[i] = salience;
        }

        const maxSalience = Math.max(...this._salienceBuffer);
        if (maxSalience > 0) {
            for (let i = 0; i < this._salienceBuffer.length; i++) {
                this._salienceBuffer[i] /= maxSalience;
            }
        }

        return this._salienceBuffer;
    }

    _findPeaks(salience, threshold = 0.3) {
        const peaks = [];

        for (let i = 1; i < salience.length - 1; i++) {
            if (salience[i] > salience[i - 1] &&
                salience[i] >= salience[i + 1] &&
                salience[i] > threshold) {

                peaks.push({
                    bin: i,
                    freq: this._freqBins[i],
                    salience: salience[i]
                });
            }
        }

        peaks.sort((a, b) => b.salience - a.salience);
        return peaks;
    }

    update(magnitude, sampleRate, timestamp) {
        const salience = this._computeSalience(magnitude, sampleRate);
        const peaks = this._findPeaks(salience);

        this._history.push({
            timestamp,
            salience: new Float32Array(salience),
            peaks
        });

        if (this._history.length > this._maxHistory) {
            this._history.shift();
        }

        return { salience, peaks };
    }

    getBestPath(numFrames = 5) {
        if (this._history.length < numFrames) {
            const lastFrame = this._history[this._history.length - 1];
            if (lastFrame && lastFrame.peaks.length > 0) {
                return {
                    freq: lastFrame.peaks[0].freq,
                    confidence: lastFrame.peaks[0].salience
                };
            }
            return { freq: null, confidence: 0 };
        }

        const recentFrames = this._history.slice(-numFrames);

        const trackScores = new Map();

        for (const frame of recentFrames) {
            for (const peak of frame.peaks.slice(0, 3)) {
                const binKey = Math.round(peak.bin / 2) * 2;
                const current = trackScores.get(binKey) || { count: 0, totalSalience: 0, freq: peak.freq };
                current.count++;
                current.totalSalience += peak.salience;
                current.freq = (current.freq + peak.freq) / 2;
                trackScores.set(binKey, current);
            }
        }

        let bestTrack = null;
        let bestScore = 0;

        for (const [, track] of trackScores) {
            const continuityBonus = track.count / numFrames;
            const avgSalience = track.totalSalience / track.count;
            const score = continuityBonus * avgSalience;

            if (score > bestScore) {
                bestScore = score;
                bestTrack = track;
            }
        }

        if (!bestTrack) {
            return { freq: null, confidence: 0 };
        }

        return {
            freq: bestTrack.freq,
            confidence: Math.min(1, bestScore)
        };
    }

    clear() {
        this._history = [];
    }
}

if (typeof window !== 'undefined') {
    window.PEFAC = PEFAC;
    window.SalienceMap = SalienceMap;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PEFAC, SalienceMap };
}
