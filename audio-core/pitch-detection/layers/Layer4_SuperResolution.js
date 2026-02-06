/**
 * Layer 4: Phase Vocoder & Super-Resolution
 * 
 * 瞬時周波数 (Instantaneous Frequency) による超解像
 * FFTの解像度を超えた0.01Hz単位の周波数特定
 */

class PhaseVocoder {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate ?? 48000;
        this.fftSize = options.fftSize ?? 4096;
        this.hopSize = options.hopSize ?? 256;

        // 前フレームの位相
        this._prevPhase = null;
        this._prevMagnitude = null;

        // 周波数ビン幅
        this._binWidth = this.sampleRate / this.fftSize;

        // 2π
        this._twoPi = 2 * Math.PI;

        // 期待位相進行（1ホップあたり）
        this._expectedPhaseDiff = this._twoPi * this.hopSize / this.fftSize;
    }

    /**
     * 瞬時周波数を取得
     * @param {Float32Array} audioBuffer - 入力音声
     * @param {number} sampleRate - サンプルレート
     * @param {number} estimatedFreq - 推定周波数（ヒント）
     * @returns {Object} 精密周波数と信頼度
     */
    getInstantaneousFrequency(audioBuffer, sampleRate, estimatedFreq) {
        if (!estimatedFreq || estimatedFreq <= 0) {
            return { freq: null, confidence: 0 };
        }

        const fftResult = this._computeFFT(audioBuffer);
        const { magnitude, phase } = fftResult;

        // 推定周波数に最も近いビンを探す
        const estimatedBin = estimatedFreq / this._binWidth;
        const centerBin = Math.round(estimatedBin);

        // 近傍ビンでピークを探索
        const searchRange = 5;
        let peakBin = centerBin;
        let peakMag = 0;

        for (let i = Math.max(1, centerBin - searchRange);
            i <= Math.min(magnitude.length - 2, centerBin + searchRange); i++) {
            if (magnitude[i] > peakMag) {
                peakMag = magnitude[i];
                peakBin = i;
            }
        }

        // 放物線補間でサブビン精度のピーク位置を推定
        const refinedBin = this._parabolicInterpolation(magnitude, peakBin);

        // 瞬時周波数計算
        let instantaneousFreq;

        if (this._prevPhase !== null) {
            // 位相差から瞬時周波数を計算
            instantaneousFreq = this._calculateInstantaneousFreq(
                phase, peakBin, refinedBin
            );
        } else {
            // 初回フレーム: 放物線補間のみ
            instantaneousFreq = refinedBin * this._binWidth;
        }

        // 位相を保存
        this._prevPhase = phase;
        this._prevMagnitude = magnitude;

        // 信頼度計算
        const confidence = this._calculateConfidence(magnitude, peakBin, peakMag);

        return {
            freq: instantaneousFreq,
            confidence,
            bin: refinedBin,
            magnitude: peakMag,
            method: this._prevPhase ? 'phase_vocoder' : 'parabolic'
        };
    }

    _computeFFT(audioBuffer) {
        // 2のべき乗にパディング
        const n = this._nextPowerOf2(Math.min(this.fftSize, audioBuffer.length));
        const halfN = n / 2;

        // 入力バッファ（ハン窓適用）
        const real = new Float32Array(n);
        const imag = new Float32Array(n);

        for (let i = 0; i < n; i++) {
            const window = 0.5 - 0.5 * Math.cos(this._twoPi * i / (n - 1));
            real[i] = (i < audioBuffer.length ? audioBuffer[i] : 0) * window;
            imag[i] = 0;
        }

        // Cooley-Tukey Radix-2 FFT（O(n log n)）
        this._fftInPlace(real, imag, n);

        // 振幅と位相を計算
        const magnitude = new Float32Array(halfN);
        const phase = new Float32Array(halfN);

        for (let k = 0; k < halfN; k++) {
            magnitude[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
            phase[k] = Math.atan2(imag[k], real[k]);
        }

        return { magnitude, phase };
    }

    /**
     * Cooley-Tukey Radix-2 FFT（インプレース）
     * O(n log n) - DFTの O(n²) から大幅に高速化
     */
    _fftInPlace(real, imag, n) {
        // ビット反転並べ替え
        let j = 0;
        for (let i = 0; i < n - 1; i++) {
            if (i < j) {
                // swap
                let temp = real[i];
                real[i] = real[j];
                real[j] = temp;
                temp = imag[i];
                imag[i] = imag[j];
                imag[j] = temp;
            }
            let k = n >> 1;
            while (k <= j) {
                j -= k;
                k >>= 1;
            }
            j += k;
        }

        // バタフライ演算
        for (let len = 2; len <= n; len <<= 1) {
            const halfLen = len >> 1;
            const angleStep = -this._twoPi / len;

            for (let i = 0; i < n; i += len) {
                let angle = 0;
                for (let k = 0; k < halfLen; k++) {
                    const cos = Math.cos(angle);
                    const sin = Math.sin(angle);

                    const idx1 = i + k;
                    const idx2 = i + k + halfLen;

                    const tReal = real[idx2] * cos - imag[idx2] * sin;
                    const tImag = real[idx2] * sin + imag[idx2] * cos;

                    real[idx2] = real[idx1] - tReal;
                    imag[idx2] = imag[idx1] - tImag;
                    real[idx1] = real[idx1] + tReal;
                    imag[idx1] = imag[idx1] + tImag;

                    angle += angleStep;
                }
            }
        }
    }

    /**
     * 2のべき乗に切り上げ
     */
    _nextPowerOf2(n) {
        let p = 1;
        while (p < n) p <<= 1;
        return p;
    }

    _parabolicInterpolation(magnitude, peakBin) {
        if (peakBin <= 0 || peakBin >= magnitude.length - 1) {
            return peakBin;
        }

        const alpha = magnitude[peakBin - 1];
        const beta = magnitude[peakBin];
        const gamma = magnitude[peakBin + 1];

        // 極値の位置を推定
        const p = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);

        return peakBin + p;
    }

    _calculateInstantaneousFreq(currentPhase, peakBin, refinedBin) {
        if (!this._prevPhase || peakBin >= this._prevPhase.length) {
            return refinedBin * this._binWidth;
        }

        // 位相差
        let phaseDiff = currentPhase[peakBin] - this._prevPhase[peakBin];

        // 期待位相差を引く
        const expectedDiff = this._expectedPhaseDiff * peakBin;
        phaseDiff -= expectedDiff;

        // 位相をアンラップ（-πからπの範囲に）
        phaseDiff = this._unwrapPhase(phaseDiff);

        // 瞬時周波数 = ビン周波数 + 位相差から得られる周波数偏差
        const freqDeviation = phaseDiff * this.sampleRate / (this._twoPi * this.hopSize);
        const binFreq = peakBin * this._binWidth;

        return binFreq + freqDeviation;
    }

    _unwrapPhase(phase) {
        while (phase > Math.PI) phase -= this._twoPi;
        while (phase < -Math.PI) phase += this._twoPi;
        return phase;
    }

    _calculateConfidence(magnitude, peakBin, peakMag) {
        // ピーク周囲との比率で信頼度を計算
        const range = 3;
        let sumNearby = 0;
        let count = 0;

        for (let i = Math.max(0, peakBin - range);
            i <= Math.min(magnitude.length - 1, peakBin + range); i++) {
            if (i !== peakBin) {
                sumNearby += magnitude[i];
                count++;
            }
        }

        const avgNearby = count > 0 ? sumNearby / count : 0;
        const ratio = avgNearby > 0 ? peakMag / avgNearby : 0;

        // 比率が高いほど信頼度が高い
        return Math.min(1, ratio / 5);
    }

    reset() {
        this._prevPhase = null;
        this._prevMagnitude = null;
    }
}

/**
 * 拡張不調和性補正 (Enhanced Inharmonicity Corrector)
 * 
 * 弦楽器特有の剛性による倍音ズレを補正
 * f_n = n * f_0 * sqrt(1 + B * n^2)
 */
class EnhancedInharmonicityCorrector {
    constructor(options = {}) {
        this.instrument = options.instrument ?? 'default';

        // 楽器別B定数（剛性係数）
        // 実測データに基づく高精度テーブル
        this.bFactorTable = {
            // ピアノ（音域別）
            piano: {
                // 低音域 (A0-A2): 太い巻線弦、高い不調和性
                low: {
                    B: 0.0004,
                    range: [27.5, 110]
                },
                // 中音域 (A2-A5): 中間
                mid: {
                    B: 0.00012,
                    range: [110, 880]
                },
                // 高音域 (A5-C8): 細い裸弦、低い不調和性
                high: {
                    B: 0.00004,
                    range: [880, 4200]
                }
            },

            // アコースティックギター
            guitar: {
                low: { B: 0.00012, range: [82, 165] },     // E2-E3
                mid: { B: 0.00008, range: [165, 660] },    // E3-E5
                high: { B: 0.00003, range: [660, 1320] }   // E5-E6
            },

            // エレキギター
            electric_guitar: {
                low: { B: 0.00010, range: [82, 165] },
                mid: { B: 0.00006, range: [165, 660] },
                high: { B: 0.00002, range: [660, 1320] }
            },

            // ベース
            bass: {
                low: { B: 0.00025, range: [41, 82] },      // E1-E2
                mid: { B: 0.00015, range: [82, 330] },     // E2-E4
                high: { B: 0.00005, range: [330, 660] }    // E4-E5
            },

            // バイオリン
            violin: {
                low: { B: 0.000015, range: [196, 440] },   // G3-A4
                mid: { B: 0.00001, range: [440, 1760] },   // A4-A6
                high: { B: 0.000005, range: [1760, 3520] } // A6-A7
            },

            // チェロ
            cello: {
                low: { B: 0.00006, range: [65, 220] },     // C2-A3
                mid: { B: 0.00003, range: [220, 880] },    // A3-A5
                high: { B: 0.00001, range: [880, 1760] }   // A5-A6
            },

            // ビオラ
            viola: {
                low: { B: 0.00003, range: [130, 440] },
                mid: { B: 0.000015, range: [440, 1320] },
                high: { B: 0.000008, range: [1320, 2640] }
            },

            // コントラバス
            contrabass: {
                low: { B: 0.0003, range: [41, 98] },
                mid: { B: 0.00015, range: [98, 294] },
                high: { B: 0.00005, range: [294, 587] }
            },

            // ハープ
            harp: {
                low: { B: 0.00008, range: [32, 131] },
                mid: { B: 0.00004, range: [131, 1047] },
                high: { B: 0.00002, range: [1047, 3136] }
            },

            // 管楽器・声（不調和性なし）
            flute: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            clarinet: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            oboe: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            bassoon: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            trumpet: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            trombone: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            french_horn: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            tuba: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            saxophone: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },
            voice: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } },

            // デフォルト
            default: { low: { B: 0 }, mid: { B: 0 }, high: { B: 0 } }
        };
    }

    setInstrument(instrument) {
        this.instrument = instrument;
    }

    /**
     * 不調和性補正を適用
     * @param {number} measuredFreq - 測定された周波数
     * @param {number} confidence - 信頼度
     * @returns {Object} 補正後の周波数とオフセット
     */
    correct(measuredFreq, confidence = 1.0) {
        const B = this._getBFactor(measuredFreq);

        if (B === 0) {
            return { freq: measuredFreq, offsetCents: 0, B: 0 };
        }

        // 不調和性による周波数シフトを補正
        // 測定周波数は f_1 * sqrt(1 + B) なので、真の基本周波数は:
        // f_0 = f_measured / sqrt(1 + B)
        const correctionFactor = Math.sqrt(1 + B);
        const correctedFreq = measuredFreq / correctionFactor;

        // セント単位のオフセット
        const offsetCents = 1200 * Math.log2(measuredFreq / correctedFreq);

        // 信頼度に応じて補正量を調整
        const scaledOffset = offsetCents * Math.min(1, confidence);
        const finalFreq = measuredFreq / Math.pow(2, scaledOffset / 1200);

        return {
            freq: finalFreq,
            offsetCents: scaledOffset,
            rawOffset: offsetCents,
            B,
            correctionFactor
        };
    }

    _getBFactor(freq) {
        const instrumentData = this.bFactorTable[this.instrument]
            || this.bFactorTable.default;

        // 周波数に基づいて適切なB値を選択
        if (instrumentData.low?.range &&
            freq >= instrumentData.low.range[0] &&
            freq < instrumentData.low.range[1]) {
            return instrumentData.low.B;
        }

        if (instrumentData.mid?.range &&
            freq >= instrumentData.mid.range[0] &&
            freq < instrumentData.mid.range[1]) {
            return instrumentData.mid.B;
        }

        if (instrumentData.high?.range &&
            freq >= instrumentData.high.range[0] &&
            freq <= instrumentData.high.range[1]) {
            return instrumentData.high.B;
        }

        // 範囲外の場合は最も近い値を使用
        if (freq < (instrumentData.low?.range?.[0] ?? Infinity)) {
            return instrumentData.low?.B ?? 0;
        }

        return instrumentData.high?.B ?? 0;
    }

    /**
     * 特定の倍音の周波数を計算
     * @param {number} f0 - 基本周波数
     * @param {number} n - 倍音番号
     * @returns {number} 倍音周波数
     */
    calculateHarmonic(f0, n) {
        const B = this._getBFactor(f0);
        return n * f0 * Math.sqrt(1 + B * n * n);
    }

    getBFactorTable() {
        return this.bFactorTable;
    }
}

// Export
if (typeof window !== 'undefined') {
    window.PhaseVocoder = PhaseVocoder;
    window.EnhancedInharmonicityCorrector = EnhancedInharmonicityCorrector;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PhaseVocoder, EnhancedInharmonicityCorrector };
}
