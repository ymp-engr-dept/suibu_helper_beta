/**
 * UnifiedPitchEngine - 高精度ピッチ推定エンジン
 * 
 * コンセンサスベース統合で最高精度を実現:
 * - YIN + NSDF + FFT倍音解析の3アルゴリズム
 * - 外れ値に強いコンセンサス統合
 * - リアルタイム処理に最適化
 */

class UnifiedPitchEngine {
    constructor(options = {}) {
        this.config = {
            minFreq: options.minFreq ?? 50,
            maxFreq: options.maxFreq ?? 2000,
            a4: options.a4 ?? 440,
            mode: options.mode ?? 'precision',
            instrument: options.instrument ?? 'default',

            // アルゴリズム重み（YIN/NSDFを重視）
            weights: {
                yin: 1.5,
                nsdf: 1.5,
                spectral: 1.0,
                cqt: 0.8,
            },

            yinThreshold: 0.12,  // 感度向上
            historySize: 5,
            minDurationMs: 10,
            minConfidence: 0.1,
            rmsThreshold: 0.003,

            // ビブラート検出
            vibratoMinRate: 3,
            vibratoMaxRate: 10,
            vibratoMinDepth: 5,

            // スムージング無効（生の精度優先）
            smoothingLevel: 'none',
        };

        // Layer 1: CQT & Noise
        this._cqtAnalyzer = null;
        this._noiseCalibrator = null;
        this._cqtAvailable = false;
        this._noiseAvailable = false;

        // Layer 2: ATF
        this._adaptiveFilter = null;
        this._atfAvailable = false;

        // Layer 3: Ensemble
        this._crepeEngine = null;
        this._crepeAvailable = false;
        this._harmonicAnalyzer = null;
        this._harmonicAvailable = false;

        // Layer 4: Post-processing
        this._viterbiDecoder = null;
        this._kalmanFilter = null;
        this._phaseVocoder = null;
        this._inharmonicityCorrector = null;
        this._viterbiAvailable = false;
        this._kalmanAvailable = false;
        this._phaseVocoderAvailable = false;
        this._inharmonicityAvailable = false;

        // Layer 5: Strobe
        this._strobeEngine = null;
        this._strobeAvailable = false;

        // 状態
        this._initialized = false;
        this._history = [];
        this._lastResult = null;
        this._lastAlgorithmResults = null;

        // ビブラート検出
        this.vibratoHistory = [];
        this.vibratoState = { detected: false, rate: 0, depth: 0 };

        // 遍及描画用: 音の立ち上がり検出
        this._onsetDetection = {
            pendingOnsets: [],    // ピッチ未確定のonsetデータ
            lastRms: 0,
            onsetThreshold: 3.0,  // RMSが急上昇したとみなす倍率
            maxPendingMs: 200,    // 最大ペンディング時間
            confirmedData: [],    // 確定した遍及データ
        };

        // フィルター状態（既存PitchEngine互換）
        this.filters = {
            tuner: {
                history: [],
                lastStableFreq: 0,
                outlierCount: 0,
                maxOutlierCents: 80,
            },
            graph: {
                history: [],
                lastValidFreq: 0,
                lastValidNote: -1,
                lastValidTime: 0,
                stableCount: 0,
                transitionMode: false,
                transitionStartTime: 0,
            }
        };

        // プリアロケート配列
        this._yinBuffer = null;
        this._nsdfBuffer = null;

        // 音名テーブル
        this._noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    }

    async initialize() {
        if (this._initialized) return true;

        const status = { layers: {} };

        // Layer 1: CQT Analyzer
        if (window.CQTAnalyzer || typeof CQTAnalyzer !== 'undefined') {
            try {
                this._cqtAnalyzer = new (window.CQTAnalyzer || CQTAnalyzer)({
                    sampleRate: 48000,
                    minFreq: 27.5,
                    maxFreq: 4186,
                    binsPerOctave: 48
                });
                this._cqtAvailable = true;
                status.layers.cqt = true;
            } catch (e) {
                console.warn('CQTAnalyzer initialization failed:', e);
            }
        }

        // Layer 1: Noise Calibrator
        if (window.NoiseCalibrator || typeof NoiseCalibrator !== 'undefined') {
            try {
                this._noiseCalibrator = new (window.NoiseCalibrator || NoiseCalibrator)({
                    sampleRate: 48000,
                    calibrationFrames: 50
                });
                this._noiseAvailable = true;
                status.layers.noise = true;
            } catch (e) {
                console.warn('NoiseCalibrator initialization failed:', e);
            }
        }

        // Layer 2: Adaptive Frontend (ATF)
        if (window.TwoStageAnalyzer || typeof TwoStageAnalyzer !== 'undefined') {
            try {
                this._adaptiveFilter = new (window.TwoStageAnalyzer || TwoStageAnalyzer)({
                    sampleRate: 48000,
                    mode: this.config.mode === 'robust' ? 'ensemble' : 'solo',
                    instrument: this.config.instrument
                });
                this._atfAvailable = true;
                status.layers.atf = true;
            } catch (e) {
                console.warn('TwoStageAnalyzer initialization failed:', e);
            }
        }

        // CREPE削除済み - YIN/NSDF/Spectralのみ使用

        // Layer 3: Harmonic Analyzer
        if (window.HarmonicAnalyzer || typeof HarmonicAnalyzer !== 'undefined') {
            try {
                this._harmonicAnalyzer = new (window.HarmonicAnalyzer || HarmonicAnalyzer)({
                    sampleRate: 48000
                });
                this._harmonicAvailable = true;
                status.layers.harmonic = true;
            } catch (e) {
                console.warn('HarmonicAnalyzer initialization failed:', e);
            }
        }

        // Layer 4: Viterbi Decoder
        if (window.ViterbiDecoder || typeof ViterbiDecoder !== 'undefined') {
            try {
                this._viterbiDecoder = new (window.ViterbiDecoder || ViterbiDecoder)({
                    minFreq: this.config.minFreq,
                    maxFreq: this.config.maxFreq
                });
                this._viterbiAvailable = true;
                status.layers.viterbi = true;
            } catch (e) {
                console.warn('ViterbiDecoder initialization failed:', e);
            }
        }

        // Layer 4: Kalman Filter
        if (window.KalmanFilter || typeof KalmanFilter !== 'undefined') {
            try {
                // 精度優先: processNoiseを高くして変化に追従しやすく
                this._kalmanFilter = new (window.KalmanFilter || KalmanFilter)({
                    processNoise: 0.01,     // 0.0001→0.01: 追従性100倍向上
                    measurementNoise: 0.005  // 0.01→0.005: 測定値をより信頼
                });
                this._kalmanAvailable = true;
                status.layers.kalman = true;
            } catch (e) {
                console.warn('KalmanFilter initialization failed:', e);
            }
        }

        // Layer 4: Phase Vocoder
        if (window.PhaseVocoder || typeof PhaseVocoder !== 'undefined') {
            try {
                this._phaseVocoder = new (window.PhaseVocoder || PhaseVocoder)({
                    sampleRate: 48000,
                    fftSize: 4096,
                    hopSize: 256
                });
                this._phaseVocoderAvailable = true;
                status.layers.phaseVocoder = true;
            } catch (e) {
                console.warn('PhaseVocoder initialization failed:', e);
            }
        }

        // Layer 4: Inharmonicity Corrector
        const InharmClass = window.EnhancedInharmonicityCorrector ||
            window.InharmonicityCorrector ||
            (typeof EnhancedInharmonicityCorrector !== 'undefined' ? EnhancedInharmonicityCorrector : null) ||
            (typeof InharmonicityCorrector !== 'undefined' ? InharmonicityCorrector : null);
        if (InharmClass) {
            try {
                this._inharmonicityCorrector = new InharmClass({
                    instrument: this.config.instrument
                });
                this._inharmonicityAvailable = true;
                status.layers.inharmonicity = true;
            } catch (e) {
                console.warn('InharmonicityCorrector initialization failed:', e);
            }
        }

        // Layer 5: Strobe Engine
        if (window.StrobeEngine || typeof StrobeEngine !== 'undefined') {
            try {
                this._strobeEngine = new (window.StrobeEngine || StrobeEngine)({
                    a4: this.config.a4
                });
                this._strobeAvailable = true;
                status.layers.strobe = true;
            } catch (e) {
                console.warn('StrobeEngine initialization failed:', e);
            }
        }

        this._initialized = true;

        if (window.debugLog) {
            debugLog('UnifiedPitchEngine initialized:', status);
        }

        return true;
    }

    async analyze(audioData, sampleRate, frequencyData = null, timestamp = null) {
        // 外部からタイムスタンプが提供されない場合は現在時刻を使用
        if (timestamp === null) {
            timestamp = performance.now();
        }

        // RMS計算
        const rms = this._calculateRMS(audioData);
        const rmsThreshold = this.config.rmsThreshold ?? 0.005;

        // ===== Onset検出（音の立ち上がり） =====
        this._detectOnset(timestamp, rms, rmsThreshold);

        if (rms < rmsThreshold) {
            this._lastAlgorithmResults = null;
            // 古いペンディングonsetをクリア
            this._cleanupPendingOnsets(timestamp);
            return this._createEmptyResult(timestamp, rms);
        }

        let processedBuffer = audioData;

        // ===== Layer 1: ノイズ除去 =====
        if (this._noiseAvailable && this._noiseCalibrator && this._noiseCalibrator.isCalibrated()) {
            processedBuffer = this._noiseCalibrator.denoise(audioData);
        }

        // ===== Layer 1: CQT解析 =====
        let cqtResult = null;
        if (this._cqtAvailable && this._cqtAnalyzer) {
            cqtResult = this._cqtAnalyzer.analyze(processedBuffer, sampleRate);
        }

        // ===== Layer 2: ATFフィルタリング =====
        let atfInfo = null;
        if (this._atfAvailable && this._adaptiveFilter && this.config.mode === 'robust') {
            const atfResult = this._adaptiveFilter.analyze(processedBuffer, sampleRate);
            if (atfResult && atfResult.buffer) {
                processedBuffer = atfResult.buffer;
                atfInfo = {
                    coarseFreq: atfResult.coarseFreq,
                    trackingFreq: atfResult.trackingFreq,
                    bypassed: atfResult.bypassed
                };
            }
        }

        // ===== マルチアルゴリズム推定（CREPE削除済み） =====
        const candidates = [];

        // YIN (時間領域 - 最も信頼性が高い)
        const yinResult = this._runYIN(processedBuffer, sampleRate);
        if (yinResult.freq && yinResult.confidence > this.config.minConfidence) {
            candidates.push({
                name: 'yin',
                freq: yinResult.freq,
                confidence: yinResult.confidence,
                weight: this.config.weights.yin
            });
        }

        // NSDF/MPM (正規化差分関数 - YINと相補的)
        const nsdfResult = this._runNSDF(processedBuffer, sampleRate);
        if (nsdfResult.freq && nsdfResult.confidence > this.config.minConfidence) {
            candidates.push({
                name: 'nsdf',
                freq: nsdfResult.freq,
                confidence: nsdfResult.confidence,
                weight: this.config.weights.nsdf
            });
        }

        // FFT倍音解析 (Ghost Fundamental)
        const spectralResult = this._runSpectralSeries(frequencyData, sampleRate);
        if (spectralResult && spectralResult.freq && spectralResult.confidence > this.config.minConfidence) {
            candidates.push({
                name: 'spectral',
                freq: spectralResult.freq,
                confidence: spectralResult.confidence,
                weight: this.config.weights.spectral
            });
        }

        // CQT Peak (オプション)
        if (cqtResult && cqtResult.peaks && cqtResult.peaks.length > 0) {
            const topPeak = cqtResult.peaks[0];
            const cqtConf = Math.min(1, topPeak.magnitude / 0.1);
            if (cqtConf > this.config.minConfidence) {
                candidates.push({
                    name: 'cqt',
                    freq: topPeak.freq,
                    confidence: cqtConf,
                    weight: this.config.weights.cqt
                });
            }
        }

        // アルゴリズム結果を保存
        this._lastAlgorithmResults = {
            yin: yinResult,
            nsdf: nsdfResult,
            cqt: cqtResult,
            spectral: spectralResult,
            candidates,
            timestamp
        };

        if (candidates.length === 0) {
            return this._createEmptyResult(timestamp, rms);
        }

        // ===== Layer 3: 調波整合性チェック =====
        if (this._harmonicAvailable && this._harmonicAnalyzer) {
            for (const candidate of candidates) {
                try {
                    const harmonicResult = this._harmonicAnalyzer.analyze(
                        processedBuffer, sampleRate, candidate.freq
                    );
                    if (harmonicResult) {
                        candidate.harmonicScore = harmonicResult.score || 1.0;
                        if (harmonicResult.octaveError && harmonicResult.correctedFreq) {
                            candidate.correctedFreq = harmonicResult.correctedFreq;
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        }

        // ===== Layer 4: MAD統合 =====
        const integrated = this._integrateWithMAD(candidates);
        if (!integrated.freq) {
            return this._createEmptyResult(timestamp, rms);
        }

        let finalFreq = integrated.freq;
        let finalConfidence = integrated.confidence;

        // 生のMAD結果を保持（スムージング前）
        const rawFreq = finalFreq;

        // ===== Layer 4: 後処理（smoothingLevel='none'ならバイパス） =====
        const noSmoothing = this.config.smoothingLevel === 'none';
        let inharmonicityOffset = 0;

        if (!noSmoothing) {
            // ===== Phase Vocoder (超解像) =====
            // 精度向上のため、高信頼度時のみ適用
            if (this._phaseVocoderAvailable && this._phaseVocoder && finalConfidence > 0.6) {
                try {
                    const pvResult = this._phaseVocoder.getInstantaneousFrequency(
                        processedBuffer, sampleRate, finalFreq
                    );
                    if (pvResult && pvResult.freq && pvResult.confidence > 0.5) {
                        // Phase Vocoderの結果を軽く混合（生の値を優先）
                        finalFreq = finalFreq * 0.7 + pvResult.freq * 0.3;
                    }
                } catch (e) { /* ignore */ }
            }

            // ===== Viterbiスムージング =====
            // 精度優先: ビブラート検出中はViterbiをスキップ
            const skipViterbi = this.vibratoState.detected || this.config.smoothingLevel === 'minimal';
            if (this._viterbiAvailable && this._viterbiDecoder && !skipViterbi) {
                try {
                    finalFreq = this._viterbiDecoder.process(finalFreq, finalConfidence, candidates);
                } catch (e) { /* ignore */ }
            }

            // ===== Kalmanフィルタ =====
            // 精度優先: 低信頼度時のみ強くスムージング
            if (this._kalmanAvailable && this._kalmanFilter) {
                try {
                    if (finalConfidence > 0.7) {
                        // 高信頼度: 生の値をほぼそのまま使用
                        finalFreq = finalFreq * 0.9 + this._kalmanFilter.filter(finalFreq, finalConfidence) * 0.1;
                    } else {
                        // 低信頼度: Kalmanで安定化
                        finalFreq = this._kalmanFilter.filter(finalFreq, finalConfidence);
                    }
                } catch (e) { /* ignore */ }
            }

            // ===== 不調和性補正 =====
            if (this._inharmonicityAvailable && this._inharmonicityCorrector) {
                try {
                    const corrected = this._inharmonicityCorrector.correct(finalFreq, finalConfidence);
                    if (corrected && corrected.freq) {
                        finalFreq = corrected.freq;
                        inharmonicityOffset = corrected.offsetCents || 0;
                    }
                } catch (e) { /* ignore */ }
            }
        }
        // noSmoothing = true の場合、MAD統合の結果をそのまま使用

        // ピッチ情報を先に計算
        const pitchInfo = this._getPitchInfo(finalFreq);

        // 履歴に追加（設定の信頼度閾値を使用）
        if (finalConfidence > this.config.minConfidence) {
            this._addToHistory(finalFreq, timestamp, finalConfidence, rms);

            // ピッチ確定時にonsetデータを確定（遡及描画用）
            this._confirmOnsetPitch(timestamp, finalFreq, pitchInfo.cents);
        }

        // ビブラート検出
        this._detectVibrato(finalFreq, timestamp);

        // ===== Layer 5: ストロボ計算 =====
        let strobeData = null;
        if (this._strobeAvailable && this._strobeEngine) {
            try {
                strobeData = this._strobeEngine.calculate(finalFreq, this.config.a4);
            } catch (e) { /* ignore */ }
        }

        // 結果を構築
        const result = {
            freq: finalFreq,
            note: pitchInfo.note,
            octave: pitchInfo.octave,
            cents: pitchInfo.cents,
            preciseCents: pitchInfo.preciseCents,
            confidence: finalConfidence,
            rms,
            timestamp,
            mode: this.config.mode,
            instrument: this.config.instrument,

            algorithmResults: candidates.map(c => ({
                name: c.name,
                freq: c.freq,
                confidence: c.confidence
            })),

            layers: {
                cqt: cqtResult ? { peaks: cqtResult.peaks } : null,
                atf: atfInfo,
                integrated: {
                    rawFreq: integrated.freq,
                    mad: integrated.mad,
                    validCount: integrated.validCount
                },
                inharmonicity: { offsetCents: inharmonicityOffset },
                strobe: strobeData
            },

            vibrato: this.vibratoState,

            engines: {
                crepe: this._crepeAvailable,
                cqt: this._cqtAvailable,
                atf: this._atfAvailable,
                viterbi: this._viterbiAvailable,
                kalman: this._kalmanAvailable,
                phaseVocoder: this._phaseVocoderAvailable,
                inharmonicity: this._inharmonicityAvailable,
                strobe: this._strobeAvailable
            }
        };

        this._lastResult = result;
        return result;
    }

    // ===== コンセンサスベース統合（外れ値に強い） =====
    _integrateWithMAD(candidates) {
        if (candidates.length === 0) {
            return { freq: null, confidence: 0 };
        }

        // 単一候補の場合はそのまま返す
        if (candidates.length === 1) {
            return {
                freq: candidates[0].correctedFreq || candidates[0].freq,
                confidence: candidates[0].confidence
            };
        }

        // YINを優先的に信頼（最も安定）
        const yinCandidate = candidates.find(c => c.name === 'yin');
        const nsdfCandidate = candidates.find(c => c.name === 'nsdf');

        // YINとNSDFが両方あり、近い値（50セント以内）なら平均を採用
        if (yinCandidate && nsdfCandidate) {
            const yinFreq = yinCandidate.correctedFreq || yinCandidate.freq;
            const nsdfFreq = nsdfCandidate.correctedFreq || nsdfCandidate.freq;
            const centsDiff = Math.abs(1200 * Math.log2(yinFreq / nsdfFreq));

            if (centsDiff < 50) {
                // 高い一致度 → 信頼度加重平均
                const yinWeight = yinCandidate.weight * yinCandidate.confidence;
                const nsdfWeight = nsdfCandidate.weight * nsdfCandidate.confidence;
                const totalWeight = yinWeight + nsdfWeight;

                const avgFreq = (yinFreq * yinWeight + nsdfFreq * nsdfWeight) / totalWeight;
                const avgConfidence = Math.max(yinCandidate.confidence, nsdfCandidate.confidence);

                return {
                    freq: avgFreq,
                    confidence: avgConfidence,
                    consensus: 'yin_nsdf'
                };
            }
        }

        // YINのみがある場合、または他と大きく異なる場合
        if (yinCandidate && yinCandidate.confidence > 0.5) {
            return {
                freq: yinCandidate.correctedFreq || yinCandidate.freq,
                confidence: yinCandidate.confidence,
                consensus: 'yin_only'
            };
        }

        // NSDFのみがある場合
        if (nsdfCandidate && nsdfCandidate.confidence > 0.5) {
            return {
                freq: nsdfCandidate.correctedFreq || nsdfCandidate.freq,
                confidence: nsdfCandidate.confidence,
                consensus: 'nsdf_only'
            };
        }

        // 全候補の信頼度加重平均（フォールバック）
        let totalWeight = 0;
        let weightedFreqSum = 0;
        let maxConfidence = 0;

        for (const c of candidates) {
            const freq = c.correctedFreq || c.freq;
            const weight = c.weight * c.confidence;

            weightedFreqSum += freq * weight;
            totalWeight += weight;

            if (c.confidence > maxConfidence) {
                maxConfidence = c.confidence;
            }
        }

        if (totalWeight === 0) {
            // 最高信頼度の候補を使用
            const best = candidates.reduce((a, b) => a.confidence > b.confidence ? a : b);
            return {
                freq: best.correctedFreq || best.freq,
                confidence: best.confidence,
                consensus: 'fallback'
            };
        }

        return {
            freq: weightedFreqSum / totalWeight,
            confidence: maxConfidence,
            consensus: 'weighted_avg'
        };
    }

    // ===== YINアルゴリズム =====
    _runYIN(buffer, sampleRate) {
        const bufferSize = buffer.length;
        const halfSize = Math.floor(bufferSize / 2);

        if (!this._yinBuffer || this._yinBuffer.length !== halfSize) {
            this._yinBuffer = new Float32Array(halfSize);
        }
        const yinBuffer = this._yinBuffer;

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

        const betterTau = this._parabolicInterpolation(yinBuffer, bestTau);
        const freq = sampleRate / betterTau;
        const confidence = 1 - bestVal;

        return { freq, confidence };
    }

    // ===== NSDF/MPMアルゴリズム =====
    _runNSDF(buffer, sampleRate) {
        const bufferSize = buffer.length;
        const halfSize = Math.floor(bufferSize / 2);

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

    // ===== Spectral Series (Ghost Fundamental) =====
    _runSpectralSeries(freqData, sampleRate) {
        if (!freqData) return null;

        const binCount = freqData.length;
        const fftSize = binCount * 2;
        const binSize = sampleRate / fftSize;

        const peaks = [];
        const threshold = 50;

        for (let i = 2; i < binCount - 2; i++) {
            const mag = freqData[i];
            if (mag < threshold) continue;

            if (mag > freqData[i - 1] && mag >= freqData[i + 1]) {
                const alpha = freqData[i - 1];
                const beta = freqData[i];
                const gamma = freqData[i + 1];
                const p = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);
                const refinedBin = i + p;
                const freq = refinedBin * binSize;
                peaks.push({ freq, mag, bin: refinedBin });
            }
        }

        peaks.sort((a, b) => b.mag - a.mag);
        const topPeaks = peaks.slice(0, 8);
        if (topPeaks.length === 0) return { freq: null, confidence: 0 };

        const candidateF0s = [];
        const strongest = topPeaks[0];
        const maxDiv = 5;

        for (let div = 1; div <= maxDiv; div++) {
            const f0_hypothesis = strongest.freq / div;
            if (f0_hypothesis < this.config.minFreq) continue;

            let score = 0;
            let hits = 0;
            let totalMag = 0;

            topPeaks.forEach(p => {
                const ratio = p.freq / f0_hypothesis;
                const harmonicN = Math.round(ratio);
                const deviation = Math.abs(ratio - harmonicN);

                if (deviation < 0.06) {
                    const weight = p.mag / 255;
                    score += weight;
                    hits++;
                    totalMag += weight;
                } else {
                    score -= (p.mag / 255) * 0.2;
                }
            });

            if (hits >= 2) {
                candidateF0s.push({ freq: f0_hypothesis, score, hits, confidence: Math.min(1.0, totalMag / 2) });
            }
        }

        if (candidateF0s.length === 0) return { freq: null, confidence: 0 };

        candidateF0s.sort((a, b) => b.score - a.score);
        const best = candidateF0s[0];

        return { freq: best.freq, confidence: best.confidence };
    }

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

    _calculateRMS(buffer) {
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            sum += buffer[i] * buffer[i];
        }
        return Math.sqrt(sum / buffer.length);
    }

    _getPitchInfo(freq) {
        if (!freq) return { note: null, octave: null, cents: null, preciseCents: null };

        const semitones = 12 * Math.log2(freq / this.config.a4);
        const roundedSemitones = Math.round(semitones);
        const centsRaw = (semitones - roundedSemitones) * 100;

        const preciseCents = Math.round(centsRaw * 10) / 10;
        const cents = Math.round(centsRaw);

        const noteIndex = ((roundedSemitones % 12) + 12 + 9) % 12;
        const octave = Math.floor((roundedSemitones + 9) / 12) + 4;

        return {
            note: this._noteNames[noteIndex],
            octave,
            cents,
            preciseCents
        };
    }

    _addToHistory(freq, timestamp, confidence, rms) {
        this._history.push({ freq, timestamp, confidence, rms });
        if (this._history.length > 50) {
            this._history.shift();
        }
    }

    _detectVibrato(freq, timestamp) {
        if (!freq) return;

        this.vibratoHistory.push({ freq, timestamp });
        if (this.vibratoHistory.length > 30) {
            this.vibratoHistory.shift();
        }

        if (this.vibratoHistory.length < 10) {
            this.vibratoState = { detected: false, rate: 0, depth: 0 };
            return;
        }

        const recent = this.vibratoHistory.slice(-20);
        const freqs = recent.map(h => h.freq);
        const avgFreq = freqs.reduce((a, b) => a + b, 0) / freqs.length;

        const deviations = freqs.map(f => 1200 * Math.log2(f / avgFreq));
        const maxDev = Math.max(...deviations.map(Math.abs));

        if (maxDev >= this.config.vibratoMinDepth) {
            const duration = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000;
            let zeroCrossings = 0;
            for (let i = 1; i < deviations.length; i++) {
                if (deviations[i] * deviations[i - 1] < 0) zeroCrossings++;
            }
            const rate = zeroCrossings / (2 * duration);

            if (rate >= this.config.vibratoMinRate && rate <= this.config.vibratoMaxRate) {
                this.vibratoState = { detected: true, rate, depth: maxDev };
                return;
            }
        }

        this.vibratoState = { detected: false, rate: 0, depth: 0 };
    }

    // ===== Onset検出（音の立ち上がり） =====
    _detectOnset(timestamp, rms, threshold) {
        const od = this._onsetDetection;
        const prevRms = od.lastRms;
        od.lastRms = rms;

        // RMSが急上昇した場合（または無音→有音になった場合）をonsetとして記録
        const isRising = rms > threshold && (prevRms < threshold || rms > prevRms * od.onsetThreshold);

        if (isRising) {
            od.pendingOnsets.push({
                timestamp: timestamp,
                rms: rms,
                confirmed: false,
                freq: null,
                cents: null
            });
        }
    }

    // ===== ペンディングonsetのクリーンアップ =====
    _cleanupPendingOnsets(currentTimestamp) {
        const od = this._onsetDetection;
        const maxAge = od.maxPendingMs;

        // 古いペンディングデータを削除
        od.pendingOnsets = od.pendingOnsets.filter(
            onset => currentTimestamp - onset.timestamp < maxAge
        );

        // 確定データも古いものを削除（1秒以上前）
        od.confirmedData = od.confirmedData.filter(
            data => currentTimestamp - data.timestamp < 1000
        );
    }

    // ===== ピッチ確定時にペンディングonsetを確定 =====
    _confirmOnsetPitch(timestamp, freq, cents) {
        const od = this._onsetDetection;

        // 現在のタイムスタンプから200ms以内の未確定onsetを確定
        for (const onset of od.pendingOnsets) {
            if (!onset.confirmed && timestamp - onset.timestamp < od.maxPendingMs) {
                onset.confirmed = true;
                onset.freq = freq;
                onset.cents = cents;

                // 確定データに追加
                od.confirmedData.push({
                    onsetTimestamp: onset.timestamp,  // 実際に音が鳴った時刻
                    confirmedTimestamp: timestamp,     // ピッチが確定した時刻
                    freq: freq,
                    cents: cents,
                    rms: onset.rms
                });
            }
        }

        // 確定済みのものをペンディングから削除
        od.pendingOnsets = od.pendingOnsets.filter(onset => !onset.confirmed);

        // クリーンアップ
        this._cleanupPendingOnsets(timestamp);
    }

    // ===== 遡及データ取得API =====
    getRetroactiveData() {
        const od = this._onsetDetection;
        const data = [...od.confirmedData];

        // 取得後にクリア
        od.confirmedData = [];

        return data;
    }

    // ===== ペンディングonset情報取得（デバッグ用） =====
    getPendingOnsets() {
        return [...this._onsetDetection.pendingOnsets];
    }

    _createEmptyResult(timestamp, rms = 0) {
        return {
            freq: null,
            note: null,
            octave: null,
            cents: null,
            preciseCents: null,
            confidence: 0,
            rms,
            timestamp,
            mode: this.config.mode,
            algorithmResults: [],
            layers: {},
            vibrato: { detected: false, rate: 0, depth: 0 },
            engines: {
                crepe: this._crepeAvailable,
                cqt: this._cqtAvailable,
                atf: this._atfAvailable,
                viterbi: this._viterbiAvailable,
                kalman: this._kalmanAvailable,
                phaseVocoder: this._phaseVocoderAvailable,
                inharmonicity: this._inharmonicityAvailable,
                strobe: this._strobeAvailable
            }
        };
    }

    // ===== 既存API互換 =====

    getProcessedPitch(mode = 'raw') {
        if (this._history.length === 0) return null;

        const latest = this._history[this._history.length - 1];
        const now = performance.now();

        if (now - latest.timestamp > 200) return null;
        if (latest.rms < 0.015) return null;
        if (latest.confidence < 0.1) return null;

        switch (mode) {
            case 'tuner':
                const tunerFreq = this._applyTunerFilter(latest.freq, latest.confidence, latest.timestamp);
                return {
                    freq: tunerFreq,
                    confidence: latest.confidence,
                    timestamp: latest.timestamp,
                    vibrato: this.vibratoState
                };

            case 'graph':
                const graphFreq = this._applyGraphFilter(latest.freq, latest.confidence, latest.timestamp);
                let deviationCents = 0;
                if (graphFreq > 0) {
                    const info = this._getPitchInfo(graphFreq);
                    deviationCents = info.cents;
                }
                return {
                    freq: graphFreq,
                    confidence: latest.confidence,
                    timestamp: latest.timestamp,
                    cents: deviationCents
                };

            case 'raw':
            default:
                return this.getRealtimePitch();
        }
    }

    getRealtimePitch() {
        if (this._history.length === 0) return null;
        const latest = this._history[this._history.length - 1];
        return this._enrichResult(latest);
    }

    getStablePitch() {
        if (this._history.length < 3) {
            return this.getRealtimePitch();
        }

        const recent = this._history.slice(-this.config.historySize);
        const validFreqs = recent
            .filter(h => h.confidence > 0.3)
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
            stable: true
        });
    }

    _enrichResult(entry) {
        if (!entry || !entry.freq) return null;

        const info = this._getPitchInfo(entry.freq);
        return {
            freq: entry.freq,
            note: info.note,
            octave: info.octave,
            cents: info.cents,
            preciseCents: info.preciseCents,
            confidence: entry.confidence,
            timestamp: entry.timestamp,
            vibrato: this.vibratoState
        };
    }

    getVibratoState() {
        return { ...this.vibratoState };
    }

    getAlgorithmResults() {
        return this._lastAlgorithmResults || null;
    }

    getStrobeData() {
        return this._lastResult?.layers?.strobe ?? null;
    }

    getStatus() {
        return {
            initialized: this._initialized,
            calibrated: this._noiseCalibrator?.isCalibrated() ?? false,
            layers: {
                cqt: this._cqtAvailable,
                noise: this._noiseAvailable,
                atf: this._atfAvailable,
                crepe: this._crepeAvailable,
                harmonic: this._harmonicAvailable,
                viterbi: this._viterbiAvailable,
                kalman: this._kalmanAvailable,
                phaseVocoder: this._phaseVocoderAvailable,
                inharmonicity: this._inharmonicityAvailable,
                strobe: this._strobeAvailable
            }
        };
    }

    // ===== フィルター =====

    _applyTunerFilter(freq, confidence, timestamp) {
        const stab = this.filters.tuner;

        if (stab.history.length > 0) {
            const lastTime = stab.history[stab.history.length - 1].timestamp;
            if (timestamp - lastTime > 200) {
                stab.history = [];
                stab.lastStableFreq = 0;
                stab.outlierCount = 0;
            }
        }

        stab.history.push({ freq, timestamp, confidence });
        if (stab.history.length > 10) stab.history.shift();

        if (confidence > 0.85) {
            stab.lastStableFreq = freq;
            stab.outlierCount = 0;
            return freq;
        }

        if (stab.history.length < 3 || stab.lastStableFreq <= 0) {
            stab.lastStableFreq = freq;
            stab.outlierCount = 0;
            return freq;
        }

        const centsDiff = Math.abs(1200 * Math.log2(freq / stab.lastStableFreq));

        if (centsDiff > stab.maxOutlierCents) {
            stab.outlierCount++;

            if (stab.outlierCount >= 3) {
                const recent = stab.history.slice(-3);
                const recentFreqs = recent.map(h => h.freq);
                const median = recentFreqs.sort((a, b) => a - b)[1];
                const allClose = recent.every(h =>
                    Math.abs(1200 * Math.log2(h.freq / median)) < 20
                );

                if (allClose) {
                    stab.lastStableFreq = median;
                    stab.outlierCount = 0;
                    return median;
                }
            }

            if (stab.outlierCount > 10) {
                stab.lastStableFreq = freq;
                stab.outlierCount = 0;
                return freq;
            }

            return stab.lastStableFreq;
        } else {
            stab.lastStableFreq = freq;
            stab.outlierCount = 0;
            return freq;
        }
    }

    _applyGraphFilter(freq, confidence, timestamp) {
        const stab = this.filters.graph;

        stab.history.push({ freq, time: timestamp });
        if (stab.history.length > 10) stab.history.shift();

        if (!freq || freq <= 0) {
            if (timestamp - stab.lastValidTime > 200) {
                stab.lastValidFreq = 0;
                stab.lastValidNote = -1;
                stab.stableCount = 0;
                stab.transitionMode = false;
            }
            return 0;
        }

        const currentNote = Math.round(12 * Math.log2(freq / this.config.a4));

        if (stab.lastValidFreq <= 0) {
            if (currentNote === stab.lastValidNote) {
                stab.stableCount++;
            } else {
                stab.stableCount = 1;
                stab.lastValidNote = currentNote;
            }
            if (stab.stableCount >= 4) {
                stab.lastValidFreq = freq;
                stab.lastValidTime = timestamp;
                return freq;
            }
            return 0;
        }

        const lastNote = Math.round(12 * Math.log2(stab.lastValidFreq / this.config.a4));
        const noteDiff = Math.abs(currentNote - lastNote);

        if (noteDiff >= 1) {
            if (!stab.transitionMode) {
                stab.transitionMode = true;
                stab.transitionStartTime = timestamp;
                stab.stableCount = 1;
                stab.lastValidNote = currentNote;
            } else {
                if (currentNote === stab.lastValidNote) {
                    stab.stableCount++;
                } else {
                    stab.stableCount = 1;
                    stab.lastValidNote = currentNote;
                    stab.transitionStartTime = timestamp;
                }
            }

            const requiredCount = (confidence > 0.9) ? 3 : 6;
            const requiredTime = (confidence > 0.9) ? 45 : 95;
            const duration = timestamp - stab.transitionStartTime;

            if (stab.stableCount >= requiredCount && duration >= requiredTime && confidence > 0.4) {
                stab.lastValidFreq = freq;
                stab.lastValidTime = timestamp;
                stab.transitionMode = false;
                stab.stableCount = 0;
                return freq;
            }
            return 0;
        }

        const targetCents = 1200 * Math.log2(freq / this.config.a4);
        const lastCents = 1200 * Math.log2(stab.lastValidFreq / this.config.a4);
        const diff = targetCents - lastCents;
        const MAX_CHANGE = 15;

        if (Math.abs(diff) > MAX_CHANGE) {
            const change = diff > 0 ? MAX_CHANGE : -MAX_CHANGE;
            const newFreq = this.config.a4 * Math.pow(2, (lastCents + change) / 1200);
            stab.lastValidFreq = newFreq;
            stab.lastValidTime = timestamp;
            return newFreq;
        }

        stab.lastValidFreq = freq;
        stab.lastValidTime = timestamp;
        stab.transitionMode = false;
        return freq;
    }

    // ===== 設定 =====

    setA4(freq) {
        this.config.a4 = freq;
        if (this._strobeEngine) {
            this._strobeEngine.setA4(freq);
        }
    }

    setMode(mode) {
        this.config.mode = mode;
        if (this._adaptiveFilter) {
            this._adaptiveFilter.setMode(mode === 'robust' ? 'ensemble' : 'solo');
        }
        if (this._viterbiDecoder) this._viterbiDecoder.reset();
        if (this._kalmanFilter) this._kalmanFilter.reset();
    }

    setInstrument(instrument) {
        this.config.instrument = instrument;
        if (this._adaptiveFilter) {
            this._adaptiveFilter.setInstrument(instrument);
        }
        if (this._inharmonicityCorrector) {
            this._inharmonicityCorrector.setInstrument(instrument);
        }
    }

    // ===== キャリブレーション =====

    startCalibration() {
        if (this._noiseCalibrator) {
            this._noiseCalibrator.startCalibration();
        }
    }

    feedCalibration(audioBuffer) {
        if (this._noiseCalibrator) {
            return this._noiseCalibrator.feedSample(audioBuffer);
        }
        return false;
    }

    isCalibrated() {
        return this._noiseCalibrator?.isCalibrated() ?? false;
    }

    getCalibrationProgress() {
        return this._noiseCalibrator?.getCalibrationProgress() ?? 0;
    }

    reset() {
        this._history = [];
        this._lastResult = null;
        this._lastAlgorithmResults = null;
        this.vibratoHistory = [];
        this.vibratoState = { detected: false, rate: 0, depth: 0 };

        this.filters.tuner = {
            history: [],
            lastStableFreq: 0,
            outlierCount: 0,
            maxOutlierCents: 80,
        };
        this.filters.graph = {
            history: [],
            lastValidFreq: 0,
            lastValidNote: -1,
            lastValidTime: 0,
            stableCount: 0,
            transitionMode: false,
            transitionStartTime: 0,
        };

        if (this._viterbiDecoder) this._viterbiDecoder.reset();
        if (this._kalmanFilter) this._kalmanFilter.reset();
        if (this._phaseVocoder) this._phaseVocoder.reset();
        if (this._strobeEngine) this._strobeEngine.reset();
        if (this._crepeEngine) this._crepeEngine.reset();
    }

    dispose() {
        if (this._crepeEngine && this._crepeEngine.dispose) {
            this._crepeEngine.dispose();
        }
        this._initialized = false;
    }
}

// ===== Export =====
if (typeof window !== 'undefined') {
    window.UnifiedPitchEngine = UnifiedPitchEngine;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UnifiedPitchEngine };
}
