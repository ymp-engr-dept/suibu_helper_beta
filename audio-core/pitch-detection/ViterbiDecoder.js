/**
 * ViterbiDecoder - 動的計画法によるピッチ軌跡最適化
 * 
 * 高ノイズ環境でも「物理的に連続性のあるパス」を選択し、
 * ピッチの跳ねを完全に排除する
 * 
 * 特徴:
 * - 連続性制約: 音楽的に不可能なピッチジャンプにペナルティ
 * - 確率的状態遷移: CREPE/NSDFの信頼度を観測確率として統合
 * - リアルタイム対応: フレーム単位のオンライン処理
 */

class ViterbiDecoder {
    constructor(options = {}) {
        // 状態空間の設定
        this.minFreq = options.minFreq ?? 50;      // Hz
        this.maxFreq = options.maxFreq ?? 2000;    // Hz
        this.centsPerState = options.centsPerState ?? 10;  // 各状態の幅（セント）

        // 状態数を計算
        this.totalCents = Math.round(1200 * Math.log2(this.maxFreq / this.minFreq));
        this.numStates = Math.ceil(this.totalCents / this.centsPerState);

        // 遷移コスト設定
        this.maxTransitionCents = options.maxTransitionCents ?? 100;  // 最大許容遷移（セント/フレーム）
        this.transitionCostFactor = options.transitionCostFactor ?? 0.1;

        // 速いパッセージ対応
        this.fastPassageThreshold = options.fastPassageThreshold ?? 50;  // セント/フレーム
        this.fastPassagePenalty = options.fastPassagePenalty ?? 0.5;

        // Viterbi状態
        // プリアロケート（GC回避）
        this._prevProb = new Float64Array(this.numStates);
        this._currProb = new Float64Array(this.numStates);
        this._backPointer = new Int32Array(this.numStates);
        this._pathBuffer = new Int32Array(64);  // 最大64フレーム分の履歴

        // 遷移確率テーブル（事前計算）
        this._transitionCost = this._buildTransitionCostTable();

        // 状態→周波数 変換テーブル
        this._stateToFreq = new Float64Array(this.numStates);
        for (let i = 0; i < this.numStates; i++) {
            const cents = i * this.centsPerState;
            this._stateToFreq[i] = this.minFreq * Math.pow(2, cents / 1200);
        }

        // 初期化フラグ
        this._initialized = false;
        this._frameCount = 0;
        this._lastState = -1;
        this._lastFreq = 0;

        // スムージング
        this._smoothingAlpha = options.smoothingAlpha ?? 0.7;
        this._smoothedFreq = 0;

        // 履歴（平滑化用）
        this._historySize = 8;
        this._freqHistory = new Float64Array(this._historySize);
        this._historyIndex = 0;
    }

    /**
     * 遷移コストテーブルを構築
     * 各状態間の遷移コストを事前計算
     */
    _buildTransitionCostTable() {
        // 効率化: 差分のみ保存
        const maxDiff = Math.ceil(this.maxTransitionCents / this.centsPerState);
        const table = new Float64Array(maxDiff * 2 + 1);

        for (let d = -maxDiff; d <= maxDiff; d++) {
            const cents = Math.abs(d * this.centsPerState);
            let cost;

            if (cents <= this.fastPassageThreshold) {
                // 許容範囲: 低コスト
                cost = cents * this.transitionCostFactor * 0.01;
            } else if (cents <= this.maxTransitionCents) {
                // 速いパッセージ: 中コスト
                cost = this.fastPassageThreshold * this.transitionCostFactor * 0.01 +
                    (cents - this.fastPassageThreshold) * this.fastPassagePenalty * 0.1;
            } else {
                // 不可能なジャンプ: 非常に高いコスト
                cost = 1e6;
            }

            table[d + maxDiff] = cost;
        }

        return { table, maxDiff };
    }

    /**
     * 周波数を状態インデックスに変換
     */
    _freqToState(freq) {
        if (freq < this.minFreq) return 0;
        if (freq > this.maxFreq) return this.numStates - 1;

        const cents = 1200 * Math.log2(freq / this.minFreq);
        return Math.round(cents / this.centsPerState);
    }

    /**
     * フレームを処理し、最適化されたピッチを返す
     * @param {number} observedFreq - 観測周波数
     * @param {number} confidence - 信頼度 (0-1)
     * @param {Array} candidates - 候補リスト（オプション）
     * @returns {number} 最適化された周波数
     */
    process(observedFreq, confidence, candidates = null) {
        if (!observedFreq || observedFreq <= 0 || confidence < 0.1) {
            // 無効な観測: 前回の状態を維持
            return this._smoothedFreq || null;
        }

        this._frameCount++;

        // 初回フレーム
        if (!this._initialized) {
            this._initializeWithObservation(observedFreq, confidence);
            return this._smoothedFreq;
        }

        // 観測確率を計算
        const observationProb = this._computeObservationProbability(
            observedFreq, confidence, candidates
        );

        // Viterbiステップ
        this._viterbiStep(observationProb);

        // 最適状態を取得
        const bestState = this._getBestState();
        const bestFreq = this._stateToFreq[bestState];

        // スムージング
        this._updateSmoothedFreq(bestFreq);

        // 状態更新
        this._lastState = bestState;
        this._lastFreq = bestFreq;

        // 確率配列をスワップ
        const temp = this._prevProb;
        this._prevProb = this._currProb;
        this._currProb = temp;

        return this._smoothedFreq;
    }

    /**
     * 初期化（最初の観測で呼ばれる）
     */
    _initializeWithObservation(freq, confidence) {
        const centerState = this._freqToState(freq);

        // ガウス分布で初期確率を設定
        const sigma = 5;  // 状態数単位の標準偏差

        for (let i = 0; i < this.numStates; i++) {
            const diff = Math.abs(i - centerState);
            const prob = Math.exp(-diff * diff / (2 * sigma * sigma)) * confidence;
            this._prevProb[i] = prob;
        }

        this._initialized = true;
        this._lastState = centerState;
        this._lastFreq = freq;
        this._smoothedFreq = freq;
    }

    /**
     * 観測確率を計算
     */
    _computeObservationProbability(observedFreq, confidence, candidates) {
        const prob = new Float64Array(this.numStates);

        // 観測された周波数を中心にガウス分布
        const observedState = this._freqToState(observedFreq);
        const sigma = Math.max(2, (1 - confidence) * 10);  // 信頼度が低いほど広い分布

        for (let i = 0; i < this.numStates; i++) {
            const diff = Math.abs(i - observedState);
            prob[i] = Math.exp(-diff * diff / (2 * sigma * sigma)) * confidence;
        }

        // 候補がある場合、追加の確率を重ねる
        if (candidates && candidates.length > 0) {
            for (const candidate of candidates) {
                if (candidate.freq && candidate.confidence > 0.1) {
                    const state = this._freqToState(candidate.freq);
                    const weight = candidate.confidence * 0.3;  // 補助的な重み
                    const candidateSigma = 3;

                    for (let i = Math.max(0, state - 10);
                        i < Math.min(this.numStates, state + 10); i++) {
                        const diff = Math.abs(i - state);
                        prob[i] += Math.exp(-diff * diff / (2 * candidateSigma * candidateSigma)) * weight;
                    }
                }
            }
        }

        // 正規化
        let sum = 0;
        for (let i = 0; i < this.numStates; i++) {
            sum += prob[i];
        }
        if (sum > 0) {
            for (let i = 0; i < this.numStates; i++) {
                prob[i] /= sum;
            }
        }

        return prob;
    }

    /**
     * Viterbiステップ（動的計画法の1ステップ）
     */
    _viterbiStep(observationProb) {
        const { table, maxDiff } = this._transitionCost;

        // 効率化: 前回の最良状態周辺のみ探索
        const searchRadius = maxDiff + 5;
        const searchStart = Math.max(0, this._lastState - searchRadius);
        const searchEnd = Math.min(this.numStates, this._lastState + searchRadius);

        // 初期化（探索範囲外は-Infinity）
        this._currProb.fill(-Infinity);

        for (let curr = searchStart; curr < searchEnd; curr++) {
            let bestPrevProb = -Infinity;
            let bestPrevState = this._lastState;

            // 前回の状態から遷移可能な範囲を探索
            const prevStart = Math.max(0, curr - maxDiff);
            const prevEnd = Math.min(this.numStates, curr + maxDiff);

            for (let prev = prevStart; prev < prevEnd; prev++) {
                const diff = curr - prev;
                const transitionCost = table[diff + maxDiff];
                const prevProb = this._prevProb[prev] - transitionCost;

                if (prevProb > bestPrevProb) {
                    bestPrevProb = prevProb;
                    bestPrevState = prev;
                }
            }

            // 観測確率を加味
            this._currProb[curr] = bestPrevProb + Math.log(observationProb[curr] + 1e-10);
            this._backPointer[curr] = bestPrevState;
        }
    }

    /**
     * 最良状態を取得
     */
    _getBestState() {
        let bestState = this._lastState;
        let bestProb = -Infinity;

        // 前回の状態周辺で最良を探す
        const searchRadius = 20;
        const start = Math.max(0, this._lastState - searchRadius);
        const end = Math.min(this.numStates, this._lastState + searchRadius);

        for (let i = start; i < end; i++) {
            if (this._currProb[i] > bestProb) {
                bestProb = this._currProb[i];
                bestState = i;
            }
        }

        return bestState;
    }

    /**
     * スムージング（指数移動平均 + 履歴ベース）
     */
    _updateSmoothedFreq(newFreq) {
        // 履歴に追加
        this._freqHistory[this._historyIndex] = newFreq;
        this._historyIndex = (this._historyIndex + 1) % this._historySize;

        // 指数移動平均
        if (this._smoothedFreq === 0) {
            this._smoothedFreq = newFreq;
        } else {
            // 大きなジャンプは抑制
            const cents = Math.abs(1200 * Math.log2(newFreq / this._smoothedFreq));
            const alpha = cents > 50 ? 0.3 : this._smoothingAlpha;

            this._smoothedFreq = this._smoothedFreq * (1 - alpha) + newFreq * alpha;
        }
    }

    /**
     * smooth メソッド（既存コードとの互換性）
     */
    smooth(freq, confidence) {
        return this.process(freq, confidence);
    }

    /**
     * リセット
     */
    reset() {
        this._prevProb.fill(0);
        this._currProb.fill(0);
        this._backPointer.fill(0);
        this._freqHistory.fill(0);
        this._initialized = false;
        this._frameCount = 0;
        this._lastState = -1;
        this._lastFreq = 0;
        this._smoothedFreq = 0;
        this._historyIndex = 0;
    }

    /**
     * 統計情報を取得
     */
    getStats() {
        return {
            numStates: this.numStates,
            totalCents: this.totalCents,
            frameCount: this._frameCount,
            lastState: this._lastState,
            lastFreq: this._lastFreq,
            smoothedFreq: this._smoothedFreq
        };
    }
}

// Export
if (typeof window !== 'undefined') {
    window.ViterbiDecoder = ViterbiDecoder;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ViterbiDecoder };
}
