/**
 * KalmanFilter - ピッチ推定用1次元カルマンフィルタ
 * 
 * 観測ノイズと状態ノイズを分離し、
 * 最適な推定値を出力する
 */

class KalmanFilter {
    constructor(options = {}) {
        // プロセスノイズ（状態の変動）
        this.processNoise = options.processNoise ?? 0.0001;

        // 測定ノイズ（観測の不確かさ）
        this.measurementNoise = options.measurementNoise ?? 0.01;

        // 状態推定値
        this._x = 0;

        // 推定誤差共分散
        this._p = 1.0;

        // 初期化フラグ
        this._initialized = false;
    }

    /**
     * フィルタリング
     * @param {number} measurement - 観測値（周波数）
     * @param {number} confidence - 信頼度 (0-1)
     * @returns {number} フィルタリング後の値
     */
    filter(measurement, confidence = 1.0) {
        if (!measurement || measurement <= 0) {
            return this._x || null;
        }

        // 初回
        if (!this._initialized) {
            this._x = measurement;
            this._initialized = true;
            return this._x;
        }

        // 信頼度に応じて測定ノイズを調整
        const adaptiveMeasurementNoise = this.measurementNoise / Math.max(0.1, confidence);

        // 予測ステップ
        const predictedX = this._x;
        const predictedP = this._p + this.processNoise;

        // 更新ステップ
        const K = predictedP / (predictedP + adaptiveMeasurementNoise);
        this._x = predictedX + K * (measurement - predictedX);
        this._p = (1 - K) * predictedP;

        return this._x;
    }

    /**
     * 現在の推定値を取得
     */
    getValue() {
        return this._x;
    }

    /**
     * リセット
     */
    reset() {
        this._x = 0;
        this._p = 1.0;
        this._initialized = false;
    }
}

// Export
if (typeof window !== 'undefined') {
    window.KalmanFilter = KalmanFilter;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KalmanFilter };
}
