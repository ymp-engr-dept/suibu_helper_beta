/**
 * PitchEngine - 統一音程判定システム
 * 
 * 特徴:
 * - 複数アルゴリズム（YIN + MPM + FFT倍音解析）
 * - 信頼度ベースの判定
 * - ビブラート・音程揺れのリアルタイム検出
 * - 時間的安定化（信頼度低い場合のみ）
 * - 2種類の出力（リアルタイム / 安定版）
 */
class PitchEngine {
    constructor() {
        // === 設定 ===
        this.config = {
            // ピッチ検出範囲
            minFreq: 50,
            maxFreq: 2000,

            // YINパラメータ
            yinThreshold: 0.15,

            // 信頼度閾値
            highConfidence: 0.8,
            mediumConfidence: 0.5,
            lowConfidence: 0.3,

            // 安定化パラメータ
            historySize: 5,
            minDurationMs: 30,

            // ビブラート検出
            vibratoMinRate: 4,   // Hz
            vibratoMaxRate: 8,   // Hz
            vibratoMinDepth: 10, // cents

            // Ghost Fundamental (Spectral Series)
            spectralEnabled: true,
            spectralThreshold: 0.15, // Peak threshold (relative to max)

            // Breath/Attack Diagnostics
            breathWindowMs: 500,
            attackWindowMs: 150,

            // Predictive Pitch System
            predictionWindowMs: 500,      // How far ahead to predict
            predictionHistoryMs: 300,     // History used for trend analysis
            predictionWeight: 0.15,       // Weight of prediction in final result (Reduced to favor actual input)
            trendSmoothingFactor: 0.7,    // Smoothing for trend calculation

            // Optimization: Adaptive Fusion
            fusionAdaptive: true,         // Enable adaptive algorithm weighting
            outlierThresholdCents: 40,    // Reject if > 40 cents from consensus (Stricter)
        };

        // === 状態 ===
        this.history = [];
        this.lastValidPitch = null;
        this.lastValidTime = 0;
        this.pitchStartTime = 0;
        this.currentNoteStart = 0;
        this.attackHistory = [];
        this.breathHistory = []; // RMS history

        // === ビブラート検出 ===
        this.vibratoHistory = [];
        this.vibratoState = {
            detected: false,
            rate: 0,
            depth: 0,
        };

        // === 基準周波数 ===
        this.a4 = 440;

        // === 音名テーブル ===
        this.noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        this.noteNamesFlat = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

        // === プリアロケート配列 ===
        this._yinBuffer = null;
        this._nsdfBuffer = null;

        // === 予測システム状態 ===
        this.predictionState = {
            trendHistory: [],      // {freq, rms, timestamp}
            currentTrend: 0,       // cents per 100ms
            predictedFreq: null,
            lastPrediction: null,
        };
    }

    /**
     * 基準周波数を設定
     */
    setA4(freq) {
        this.a4 = freq;
    }

    /**
     * メイン解析関数
     * @returns {PitchResult} 解析結果
     */
    analyze(audioData, sampleRate, frequencyData = null) {
        const timestamp = performance.now();

        // RMS計算
        const rms = this._calculateRMS(audioData);

        // 音量が小さすぎる場合
        if (rms < 0.01) {
            this._lastAlgorithmResults = null;
            return this._createResult(null, 0, timestamp, rms);
        }

        // 各アルゴリズムで検出
        const yinResult = this._runYIN(audioData, sampleRate);
        const mpmResult = this._runMPM(audioData, sampleRate);

        // スペクトル解析 (Ghost Fundamental)
        const spectralResult = this._runSpectralSeries(frequencyData, sampleRate);
        const fftResult = spectralResult || this._runFFTHarmonic(audioData, sampleRate);

        // 知覚音程を計算（倍音構造から）
        const perceivedResult = this._calculatePerceivedPitch(yinResult, mpmResult, rms);

        // アルゴリズム結果を保存（Tuner用）
        this._lastAlgorithmResults = {
            yin: yinResult,
            mpm: mpmResult,
            fft: fftResult,
            perceived: perceivedResult,
            timestamp,
        };

        // 信頼度計算
        const confidence = this._calculateConfidence(yinResult, mpmResult, fftResult, rms);

        // 最良候補を選択（初期値）
        let bestFreq = this._selectBestCandidate(yinResult, mpmResult, fftResult, confidence);

        // === 予測システム統合 ===
        const prediction = this._runPredictiveAnalysis(bestFreq, rms, timestamp);

        // 予測と現在値を融合して最適化
        if (bestFreq && prediction.predictedFreq) {
            bestFreq = this._fusePredictionWithCurrent(bestFreq, prediction, confidence.total);
        }

        // 結果を履歴に追加
        if (bestFreq && confidence.total > this.config.lowConfidence) {
            this._addToHistory(bestFreq, timestamp, confidence.total);
        }

        // ビブラート検出
        this._detectVibrato(bestFreq, timestamp);

        // 呼気・アンブシュア診断
        const diagnostics = this._analyzeDiagnostics(bestFreq, rms, timestamp);

        // 結果を作成
        const result = this._createResult(bestFreq, confidence.total, timestamp, rms);
        result.algorithmResults = this._lastAlgorithmResults;
        result.diagnostics = diagnostics;
        result.prediction = prediction;
        return result;
    }

    /**
     * 知覚音程を計算（人間が聞こえる音）
     */
    _calculatePerceivedPitch(yinResult, mpmResult, rms) {
        // 基本的には最も信頼度の高いアルゴリズムの結果を使用
        // 倍音構造がある場合は基本周波数を強調
        const candidates = [yinResult, mpmResult].filter(r => r.freq !== null);

        if (candidates.length === 0) {
            return { freq: null, confidence: 0 };
        }

        // 信頼度で重み付け平均
        let totalWeight = 0;
        let weightedFreq = 0;

        candidates.forEach(c => {
            const weight = c.confidence * c.confidence; // 信頼度の2乗で重み付け
            weightedFreq += c.freq * weight;
            totalWeight += weight;
        });

        const freq = totalWeight > 0 ? weightedFreq / totalWeight : null;
        const avgConfidence = candidates.reduce((sum, c) => sum + c.confidence, 0) / candidates.length;

        return { freq, confidence: avgConfidence };
    }

    /**
     * 各アルゴリズムの個別結果を取得（Tuner表示用）
     */
    getAlgorithmResults() {
        return this._lastAlgorithmResults || null;
    }

    /**
     * リアルタイムピッチを取得（低遅延、ビブラート対応）
     */
    getRealtimePitch() {
        if (this.history.length === 0) return null;

        const latest = this.history[this.history.length - 1];

        // 信頼度が高い場合はそのまま返す（ビブラートも反映）
        if (latest.confidence > this.config.mediumConfidence) {
            return this._enrichResult(latest);
        }

        // 信頼度が低い場合は前回の有効値を維持
        if (this.lastValidPitch && latest.confidence < this.config.lowConfidence) {
            return this._enrichResult({
                freq: this.lastValidPitch,
                confidence: latest.confidence,
                timestamp: latest.timestamp,
            });
        }

        return this._enrichResult(latest);
    }

    /**
     * 安定化ピッチを取得（メディアンフィルタ適用）
     */
    getStablePitch() {
        if (this.history.length < 3) {
            return this.getRealtimePitch();
        }

        // 直近5フレームのメディアン
        const recent = this.history.slice(-this.config.historySize);
        const validFreqs = recent
            .filter(h => h.confidence > this.config.lowConfidence)
            .map(h => h.freq)
            .sort((a, b) => a - b);

        if (validFreqs.length === 0) {
            return this.getRealtimePitch();
        }

        const medianFreq = validFreqs[Math.floor(validFreqs.length / 2)];
        const avgConfidence = recent.reduce((sum, h) => sum + h.confidence, 0) / recent.length;

        return this._enrichResult({
            freq: medianFreq,
            confidence: avgConfidence,
            timestamp: performance.now(),
            stable: true,
        });
    }

    /**
     * ビブラート情報を取得
     */
    getVibratoState() {
        return { ...this.vibratoState };
    }

    // ============================
    // === 内部メソッド ===
    // ============================

    /**
     * RMS計算
     */
    _calculateRMS(buffer) {
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            sum += buffer[i] * buffer[i];
        }
        return Math.sqrt(sum / buffer.length);
    }

    /**
     * YINアルゴリズム
     */
    _runYIN(buffer, sampleRate) {
        const bufferSize = buffer.length;
        const halfSize = Math.floor(bufferSize / 2);

        // バッファ再利用
        if (!this._yinBuffer || this._yinBuffer.length !== halfSize) {
            this._yinBuffer = new Float32Array(halfSize);
        }
        const yinBuffer = this._yinBuffer;

        // 差分関数
        yinBuffer[0] = 1;
        let runningSum = 0;

        for (let tau = 1; tau < halfSize; tau++) {
            let diff = 0;
            for (let i = 0; i < halfSize; i++) {
                const delta = buffer[i] - buffer[i + tau];
                diff += delta * delta;
            }
            runningSum += diff;
            yinBuffer[tau] = diff * tau / runningSum || 1;
        }

        // 閾値以下の最初の谷を探す
        const minPeriod = Math.floor(sampleRate / this.config.maxFreq);
        const maxPeriod = Math.floor(sampleRate / this.config.minFreq);

        let bestTau = -1;
        let bestVal = 1;

        for (let tau = minPeriod; tau < Math.min(maxPeriod, halfSize); tau++) {
            if (yinBuffer[tau] < this.config.yinThreshold) {
                while (tau + 1 < halfSize && yinBuffer[tau + 1] < yinBuffer[tau]) {
                    tau++;
                }
                if (yinBuffer[tau] < bestVal) {
                    bestVal = yinBuffer[tau];
                    bestTau = tau;
                }
                break;
            }
        }

        if (bestTau === -1) {
            // 閾値以下がなければ最小値を探す
            for (let tau = minPeriod; tau < Math.min(maxPeriod, halfSize); tau++) {
                if (yinBuffer[tau] < bestVal) {
                    bestVal = yinBuffer[tau];
                    bestTau = tau;
                }
            }
        }

        if (bestTau === -1) {
            return { freq: null, confidence: 0 };
        }

        // パラボリック補間
        const betterTau = this._parabolicInterpolation(yinBuffer, bestTau);
        const freq = sampleRate / betterTau;
        const confidence = 1 - bestVal;

        return { freq, confidence };
    }

    /**
     * MPMアルゴリズム（改良版）
     */
    _runMPM(buffer, sampleRate) {
        const bufferSize = buffer.length;
        const halfSize = Math.floor(bufferSize / 2);

        // NSDF計算
        if (!this._nsdfBuffer || this._nsdfBuffer.length !== halfSize) {
            this._nsdfBuffer = new Float32Array(halfSize);
        }
        const nsdf = this._nsdfBuffer;

        for (let tau = 0; tau < halfSize; tau++) {
            let acf = 0;
            let m = 0;
            for (let i = 0; i < halfSize; i++) {
                acf += buffer[i] * buffer[i + tau];
                m += buffer[i] * buffer[i] + buffer[i + tau] * buffer[i + tau];
            }
            nsdf[tau] = m > 0 ? 2 * acf / m : 0;
        }

        // ピーク検出
        const minPeriod = Math.floor(sampleRate / this.config.maxFreq);
        const maxPeriod = Math.floor(sampleRate / this.config.minFreq);

        let maxCorr = 0;
        let bestTau = -1;

        for (let tau = minPeriod; tau < Math.min(maxPeriod, halfSize - 1); tau++) {
            if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1]) {
                if (nsdf[tau] > maxCorr) {
                    maxCorr = nsdf[tau];
                    bestTau = tau;
                }
            }
        }

        if (bestTau === -1 || maxCorr < 0.5) {
            return { freq: null, confidence: 0 };
        }

        const betterTau = this._parabolicInterpolation(nsdf, bestTau);
        const freq = sampleRate / betterTau;

        return { freq, confidence: maxCorr };
    }

    /**
     * FFT倍音解析
     */
    _runFFTHarmonic(buffer, sampleRate) {
        const fftSize = buffer.length;

        // 簡易FFT（ピーク検出のみ）
        const freqPerBin = sampleRate / fftSize;
        // Legacy FFT call - placeholder
        return { freq: null, confidence: 0 };
    }

    /**
     * Ghost Fundamental: Spectral Series Locking
     * @param {Uint8Array} freqData - Frequency data from AnalyserNode
     */
    _runSpectralSeries(freqData, sampleRate) {
        if (!this.config.spectralEnabled || !freqData) return null;

        const binCount = freqData.length;
        const fftSize = binCount * 2;
        const binSize = sampleRate / fftSize;

        // 1. Peak Detection
        const peaks = [];
        const threshold = 50; // Minimum energy (0-255)

        for (let i = 2; i < binCount - 2; i++) {
            const mag = freqData[i];
            if (mag < threshold) continue;

            if (mag > freqData[i - 1] && mag >= freqData[i + 1]) {
                // Parabolic interpolation for better freq precision
                const alpha = freqData[i - 1];
                const beta = freqData[i];
                const gamma = freqData[i + 1];
                const p = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);

                const refinedBin = i + p;
                const freq = refinedBin * binSize;

                peaks.push({ freq, mag, bin: refinedBin });
            }
        }

        // Sort by magnitude
        peaks.sort((a, b) => b.mag - a.mag);

        // Take top 8 peaks
        const topPeaks = peaks.slice(0, 8);
        if (topPeaks.length === 0) return { freq: null, confidence: 0 };

        // 2. Harmonic Series Matching
        // Try to find a fundamental f0 such that peaks are integer multiples (harmonics)

        const candidateF0s = [];

        // Strongest peak might be 1st, 2nd, 3rd, or 4th harmonic
        const strongest = topPeaks[0];
        const maxDiv = 5;

        for (let div = 1; div <= maxDiv; div++) {
            const f0_hypothesis = strongest.freq / div;
            if (f0_hypothesis < this.config.minFreq) continue;

            // Score this hypothesis
            let score = 0;
            let hits = 0;
            let totalMag = 0;

            topPeaks.forEach(p => {
                const ratio = p.freq / f0_hypothesis;
                const harmonicN = Math.round(ratio);
                const deviation = Math.abs(ratio - harmonicN);

                // Tolerance: 6% deviation allowed (inharmonicity or resolution error)
                if (deviation < 0.06) {
                    const weight = p.mag / 255;
                    score += weight;
                    hits++;
                    totalMag += weight;
                } else {
                    score -= (p.mag / 255) * 0.2; // Penalty
                }
            });

            // Adjust score by harmonic count
            if (hits >= 2) { // Must explain at least 2 peaks to be valid
                candidateF0s.push({ freq: f0_hypothesis, score, hits, confidence: Math.min(1.0, totalMag / 2) });
            }
        }

        if (candidateF0s.length === 0) return { freq: null, confidence: 0 };

        // Sort candidates
        candidateF0s.sort((a, b) => b.score - a.score);
        const best = candidateF0s[0];

        return { freq: best.freq, confidence: best.confidence };
    }

    /**
     * パラボリック補間
     */
    _parabolicInterpolation(arr, x) {
        if (x <= 0 || x >= arr.length - 1) return x;

        const s0 = arr[x - 1];
        const s1 = arr[x];
        const s2 = arr[x + 1];

        const a = (s0 + s2 - 2 * s1) / 2;
        if (Math.abs(a) < 1e-10) return x;

        const b = (s2 - s0) / 2;
        return x - b / (2 * a);
    }

    /**
     * 信頼度計算
     */
    _calculateConfidence(yinResult, mpmResult, fftResult, rms) {
        const results = [yinResult, mpmResult].filter(r => r.freq !== null);

        if (results.length === 0) {
            return { total: 0, algorithm: 0, agreement: 0, volume: 0 };
        }

        // アルゴリズム信頼度の平均
        const algorithmConf = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

        // アルゴリズム間一致度
        let agreementConf = 0;
        if (results.length >= 2) {
            const freqs = results.map(r => r.freq);
            const maxDiff = Math.abs(freqs[0] - freqs[1]) / Math.min(freqs[0], freqs[1]);
            agreementConf = maxDiff < 0.02 ? 1.0 : maxDiff < 0.05 ? 0.7 : maxDiff < 0.1 ? 0.4 : 0;
        } else {
            agreementConf = 0.5;
        }

        // 音量による信頼度
        const volumeConf = Math.min(1, rms * 10);

        // 総合信頼度
        const total = algorithmConf * 0.4 + agreementConf * 0.4 + volumeConf * 0.2;

        return { total, algorithm: algorithmConf, agreement: agreementConf, volume: volumeConf };
    }

    /**
     * 最良候補を選択
     */
    _selectBestCandidate(yinResult, mpmResult, fftResult, confidence) {
        const candidates = [yinResult, mpmResult]
            .filter(r => r.freq !== null && r.freq >= this.config.minFreq && r.freq <= this.config.maxFreq);

        if (candidates.length === 0) return null;

        // 信頼度順にソート
        candidates.sort((a, b) => b.confidence - a.confidence);

        return candidates[0].freq;
    }

    /**
     * 予測分析システム
     * 過去のピッチ・RMS傾向から500ms先のピッチを予測
     */
    _runPredictiveAnalysis(currentFreq, rms, timestamp) {
        const ps = this.predictionState;
        const cfg = this.config;

        // 履歴に追加
        if (currentFreq) {
            ps.trendHistory.push({ freq: currentFreq, rms, timestamp });
        }

        // 履歴を制限（predictionHistoryMs分のみ保持）
        const cutoff = timestamp - cfg.predictionHistoryMs;
        ps.trendHistory = ps.trendHistory.filter(h => h.timestamp > cutoff);

        // 履歴が足りない場合は予測不可
        if (ps.trendHistory.length < 5) {
            return { predictedFreq: null, trend: 0, confidence: 0 };
        }

        // === トレンド計算（線形回帰の傾き） ===
        const n = ps.trendHistory.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        const baseTime = ps.trendHistory[0].timestamp;

        ps.trendHistory.forEach(h => {
            const x = (h.timestamp - baseTime) / 100; // 100ms単位
            const y = 1200 * Math.log2(h.freq / this.a4); // セントに変換
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumX2 += x * x;
        });

        const denominator = n * sumX2 - sumX * sumX;
        let slope = 0; // cents per 100ms

        if (Math.abs(denominator) > 0.001) {
            slope = (n * sumXY - sumX * sumY) / denominator;
        }

        // トレンドをスムージング
        ps.currentTrend = ps.currentTrend * cfg.trendSmoothingFactor + slope * (1 - cfg.trendSmoothingFactor);

        // === 予測計算 ===
        // 現在のピッチから500ms先を予測
        const predictionSteps = cfg.predictionWindowMs / 100;
        const predictedCents = (sumY / n) + ps.currentTrend * predictionSteps;
        const predictedFreq = this.a4 * Math.pow(2, predictedCents / 1200);

        // === RMS傾向から信頼度調整 ===
        // RMSが安定していれば予測信頼度が高い
        const rmsValues = ps.trendHistory.map(h => h.rms);
        const meanRMS = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
        const rmsVariance = rmsValues.reduce((a, b) => a + Math.pow(b - meanRMS, 2), 0) / rmsValues.length;
        const rmsStability = Math.max(0, 1 - Math.sqrt(rmsVariance) / (meanRMS + 0.001) * 3);

        // トレンドが急激すぎる場合は信頼度を下げる
        const trendMagnitude = Math.abs(ps.currentTrend);
        const trendConfidence = trendMagnitude < 5 ? 1.0 : trendMagnitude < 15 ? 0.7 : trendMagnitude < 30 ? 0.4 : 0.1;

        const predictionConfidence = Math.min(1.0, rmsStability * trendConfidence);

        ps.predictedFreq = predictedFreq;
        ps.lastPrediction = {
            freq: predictedFreq,
            trend: ps.currentTrend,
            confidence: predictionConfidence,
            timestamp: timestamp
        };

        return {
            predictedFreq,
            trend: ps.currentTrend,
            confidence: predictionConfidence,
            rmsStability,
            trendConfidence
        };
    }

    /**
     * 予測と現在値を融合して最適化
     * 過去履歴、現在値、予測値を比較し最も妥当な値を選択
     */
    _fusePredictionWithCurrent(currentFreq, prediction, currentConfidence) {
        const cfg = this.config;

        // 予測信頼度が低い場合は現在値をそのまま返す
        if (prediction.confidence < 0.3) {
            return currentFreq;
        }

        // セント差を計算
        const diffCents = 1200 * Math.log2(currentFreq / prediction.predictedFreq);

        // 差が大きすぎる場合（50セント以上）は外れ値として予測を無視
        if (Math.abs(diffCents) > cfg.outlierThresholdCents) {
            // ただし、履歴と比較して現在値が外れ値かもしれない
            const historyMedian = this._getHistoryMedianFreq();
            if (historyMedian) {
                const historyDiff = 1200 * Math.log2(currentFreq / historyMedian);
                if (Math.abs(historyDiff) > cfg.outlierThresholdCents) {
                    // 現在値が履歴からも乖離している → 外れ値として履歴メディアンを返す
                    return historyMedian;
                }
            }
            return currentFreq;
        }

        // 重み付け融合
        // 現在信頼度が高ければ現在値を重視、予測信頼度が高ければ予測を加味
        const predWeight = cfg.predictionWeight * prediction.confidence;
        const currentWeight = 1 - predWeight;

        // 対数領域で融合（音楽的に正しい補間）
        const fusedCents = currentWeight * 1200 * Math.log2(currentFreq / this.a4)
            + predWeight * 1200 * Math.log2(prediction.predictedFreq / this.a4);

        return this.a4 * Math.pow(2, fusedCents / 1200);
    }

    /**
     * 履歴のメディアン周波数を取得
     */
    _getHistoryMedianFreq() {
        if (this.history.length < 3) return null;

        const recent = this.history.slice(-7);
        const freqs = recent.map(h => h.freq).sort((a, b) => a - b);
        return freqs[Math.floor(freqs.length / 2)];
    }

    /**
     * 履歴に追加
     */
    _addToHistory(freq, timestamp, confidence) {
        this.history.push({ freq, timestamp, confidence });

        // 履歴サイズを制限
        if (this.history.length > 20) {
            this.history.shift();
        }

        // 有効なピッチを記録
        if (confidence > this.config.mediumConfidence) {
            this.lastValidPitch = freq;
            this.lastValidTime = timestamp;
        }
    }

    /**
     * ビブラート検出
     */
    _detectVibrato(freq, timestamp) {
        if (!freq) {
            this.vibratoHistory = [];
            this.vibratoState = { detected: false, rate: 0, depth: 0 };
            return;
        }

        // ビブラート履歴に追加
        this.vibratoHistory.push({ freq, timestamp });

        // 500ms分のみ保持
        const cutoff = timestamp - 500;
        this.vibratoHistory = this.vibratoHistory.filter(h => h.timestamp > cutoff);

        if (this.vibratoHistory.length < 10) {
            this.vibratoState = { detected: false, rate: 0, depth: 0 };
            return;
        }

        // 周波数変動を解析
        const freqs = this.vibratoHistory.map(h => h.freq);
        const meanFreq = freqs.reduce((a, b) => a + b, 0) / freqs.length;

        // セント変換
        const centsFromMean = freqs.map(f => 1200 * Math.log2(f / meanFreq));

        // 振幅（深さ）
        const maxCent = Math.max(...centsFromMean);
        const minCent = Math.min(...centsFromMean);
        const depth = (maxCent - minCent) / 2;

        // ゼロクロスからレートを推定
        let zeroCrossCount = 0;
        for (let i = 1; i < centsFromMean.length; i++) {
            if (centsFromMean[i - 1] * centsFromMean[i] < 0) {
                zeroCrossCount++;
            }
        }

        const duration = (this.vibratoHistory[this.vibratoHistory.length - 1].timestamp
            - this.vibratoHistory[0].timestamp) / 1000;
        const rate = duration > 0 ? zeroCrossCount / (2 * duration) : 0;

        // ビブラート判定
        const detected = depth >= this.config.vibratoMinDepth
            && rate >= this.config.vibratoMinRate
            && rate <= this.config.vibratoMaxRate;

        this.vibratoState = { detected, rate, depth };
    }

    /**
     * 呼気・アンブシュア診断 (Diagnostics)
     */
    _analyzeDiagnostics(freq, rms, timestamp) {
        // === Breath Stability (AM) ===
        this.breathHistory.push({ rms, timestamp });
        // Keep 500ms
        const breathCutoff = timestamp - this.config.breathWindowMs;
        this.breathHistory = this.breathHistory.filter(h => h.timestamp > breathCutoff);

        let breathStability = 1.0;
        if (this.breathHistory.length > 5) {
            const rmsValues = this.breathHistory.map(h => h.rms);
            const mean = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
            if (mean > 0.001) {
                const variance = rmsValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rmsValues.length;
                const stdDev = Math.sqrt(variance);
                // Coefficient of Variation
                const cv = stdDev / mean;
                // CV > 0.3 is unstable
                breathStability = Math.max(0, 1 - (cv * 3));
            }
        }

        // === Attack Trajectory ===
        let attackMetrics = { scoop: 0, time: 0 };

        if (freq) {
            // Novelty detector (if silence before)
            // Or if pitch changed significantly (> semitone)
            // Simplified: Check if we just started a note
            if (this.history.length < 5 || (timestamp - this.lastValidTime > 200)) {
                this.currentNoteStart = timestamp;
                this.attackHistory = [];
            }

            if (timestamp - this.currentNoteStart < this.config.attackWindowMs) {
                this.attackHistory.push({ freq, timestamp });

                // Calculate provisional scoop
                const first = this.attackHistory[0].freq;
                const current = freq;
                const centsDiff = 1200 * Math.log2(current / first);
                attackMetrics.scoop = Math.abs(centsDiff);
                attackMetrics.time = timestamp - this.currentNoteStart;
            }
        }

        return {
            breathStability,
            attack: attackMetrics
        };
    }

    /**
     * 結果を作成
     */
    _createResult(freq, confidence, timestamp, rms) {
        if (!freq) {
            return {
                freq: null,
                note: null,
                octave: null,
                cents: null,
                confidence: 0,
                rms,
                timestamp,
                vibrato: this.vibratoState,
            };
        }

        const pitchInfo = this._getPitchInfo(freq);

        return {
            freq,
            note: pitchInfo.note,
            octave: pitchInfo.octave,
            cents: pitchInfo.cents,
            confidence,
            rms,
            timestamp,
            vibrato: this.vibratoState,
        };
    }

    /**
     * 結果を補強
     */
    _enrichResult(historyItem) {
        if (!historyItem || !historyItem.freq) return null;

        const pitchInfo = this._getPitchInfo(historyItem.freq);

        return {
            freq: historyItem.freq,
            note: pitchInfo.note,
            octave: pitchInfo.octave,
            cents: pitchInfo.cents,
            confidence: historyItem.confidence,
            timestamp: historyItem.timestamp,
            stable: historyItem.stable || false,
            vibrato: this.vibratoState,
        };
    }

    /**
     * 音程情報を取得
     */
    _getPitchInfo(freq) {
        const semitones = 12 * Math.log2(freq / this.a4);
        const roundedSemitones = Math.round(semitones);
        const cents = Math.round((semitones - roundedSemitones) * 100);

        const noteIndex = ((roundedSemitones % 12) + 12 + 9) % 12; // A=0 → C=0
        const octave = Math.floor((roundedSemitones + 9) / 12) + 4;

        return {
            note: this.noteNames[noteIndex],
            noteFlat: this.noteNamesFlat[noteIndex],
            octave,
            cents,
            semitones: roundedSemitones,
        };
    }

    /**
     * 履歴をクリア
     */
    clear() {
        this.history = [];
        this.vibratoHistory = [];
        this.lastValidPitch = null;
        this.vibratoState = { detected: false, rate: 0, depth: 0 };
    }
}

window.PitchEngine = PitchEngine;
window.pitchEngine = new PitchEngine();
