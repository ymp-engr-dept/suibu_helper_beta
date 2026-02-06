/**
 * UnifiedPitchFrame - 統一ピッチ配信オブジェクト
 * 
 * 全UIモジュールへの単一真実源（Single Source of Truth）
 * F1マシンのテレメトリのように、精密かつ無駄のないデータ構造
 * 
 * @typedef {Object} UnifiedPitchFrame
 * @property {number|null} freq - 推定周波数 (Hz)、0.01Hz精度
 * @property {number} confidence - 信頼度 (0.0-1.0)
 * @property {number} rms - 入力信号のRMS振幅
 * @property {number} timestamp - フレームタイムスタンプ (performance.now())
 * @property {string|null} note - 音名 ('C', 'C#', 'D', ...)
 * @property {number|null} octave - オクターブ番号 (0-8)
 * @property {number|null} cents - ピッチ偏差 (-50 to +50)
 * @property {number|null} preciseCents - 高精度ピッチ偏差 (0.1セント精度)
 * @property {number} phaseVelocity - 瞬時位相速度 (Hz/sec、ビブラート/音程変動用)
 * @property {number} inharmonicityFactor - 不調和性補正係数
 * @property {StrobeData|null} strobe - ストロボビジュアライザ用データ
 * @property {VibratoState} vibrato - ビブラート検出状態
 * @property {LayerDiagnostics} layers - 各層の診断情報（デバッグ用、本番では省略可）
 */

/**
 * @typedef {Object} StrobeData
 * @property {number} rotation - ストロボ回転角度 (radians)
 * @property {number} velocity - ストロボ回転速度 (cents/sec)
 * @property {number} targetNote - ターゲット音名インデックス
 */

/**
 * @typedef {Object} VibratoState
 * @property {boolean} detected - ビブラート検出フラグ
 * @property {number} rate - ビブラート周波数 (Hz)
 * @property {number} depth - ビブラート深度 (cents)
 */

/**
 * @typedef {Object} LayerDiagnostics
 * @property {Object|null} cqt - CQT解析情報
 * @property {Object|null} atf - 適応型フィルタ情報
 * @property {Object|null} ensemble - アンサンブル統合情報
 * @property {Object|null} superResolution - 超解像情報
 * @property {Object|null} inharmonicity - 不調和性補正情報
 */

/**
 * UnifiedPitchDispatcher - 統一ピッチ配信マネージャ
 * 
 * 各エンジンの結果を統合し、単一のUnifiedPitchFrameとして配信
 */
class UnifiedPitchDispatcher {
    constructor() {
        this._subscribers = new Set();
        this._lastFrame = null;
        this._a4 = 440;
        this._noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    }

    /**
     * 購読者を登録
     * @param {function(UnifiedPitchFrame): void} callback
     * @returns {function} 解除関数
     */
    subscribe(callback) {
        this._subscribers.add(callback);
        return () => this._subscribers.delete(callback);
    }

    /**
     * 基準周波数を設定
     */
    setA4(freq) {
        this._a4 = freq;
    }

    /**
     * フレームを配信
     * @param {Object} engineResult - エンジンからの生結果
     */
    dispatch(engineResult) {
        const frame = this._buildFrame(engineResult);
        this._lastFrame = frame;

        for (const callback of this._subscribers) {
            try {
                callback(frame);
            } catch (e) {
                // 購読者のエラーは無視
            }
        }
    }

    /**
     * 最新フレームを取得
     * @returns {UnifiedPitchFrame|null}
     */
    getLastFrame() {
        return this._lastFrame;
    }

    /**
     * エンジン結果からUnifiedPitchFrameを構築
     */
    _buildFrame(result) {
        if (!result) {
            return this._createEmptyFrame();
        }

        const freq = result.freq;
        const pitchInfo = freq ? this._getPitchInfo(freq) : null;

        return {
            // 基本ピッチ情報
            freq: freq || null,
            confidence: result.confidence ?? 0,
            rms: result.rms ?? 0,
            timestamp: result.timestamp ?? performance.now(),

            // 音名情報
            note: pitchInfo?.note ?? null,
            octave: pitchInfo?.octave ?? null,
            cents: pitchInfo?.cents ?? null,
            preciseCents: pitchInfo?.preciseCents ?? null,

            // 高度な解析情報
            phaseVelocity: result.instantaneousInfo?.phaseVelocity ?? 0,
            inharmonicityFactor: result.inharmonicityOffset ?? 0,

            // ストロボ
            strobe: result.strobeData ?? result.layers?.strobe ?? null,

            // ビブラート
            vibrato: result.vibrato ?? { detected: false, rate: 0, depth: 0 },

            // 診断情報（必要に応じて）
            layers: result.layers ?? null
        };
    }

    _getPitchInfo(freq) {
        const semitones = 12 * Math.log2(freq / this._a4);
        const roundedSemitones = Math.round(semitones);
        const centsRaw = (semitones - roundedSemitones) * 100;

        const noteIndex = ((roundedSemitones % 12) + 12 + 9) % 12;
        const octave = Math.floor((roundedSemitones + 9) / 12) + 4;

        return {
            note: this._noteNames[noteIndex],
            octave,
            cents: Math.round(centsRaw),
            preciseCents: Math.round(centsRaw * 10) / 10
        };
    }

    _createEmptyFrame() {
        return {
            freq: null,
            confidence: 0,
            rms: 0,
            timestamp: performance.now(),
            note: null,
            octave: null,
            cents: null,
            preciseCents: null,
            phaseVelocity: 0,
            inharmonicityFactor: 0,
            strobe: null,
            vibrato: { detected: false, rate: 0, depth: 0 },
            layers: null
        };
    }
}

// グローバルインスタンス
const unifiedPitchDispatcher = new UnifiedPitchDispatcher();

// Export
if (typeof window !== 'undefined') {
    window.UnifiedPitchDispatcher = UnifiedPitchDispatcher;
    window.unifiedPitchDispatcher = unifiedPitchDispatcher;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UnifiedPitchDispatcher, unifiedPitchDispatcher };
}
