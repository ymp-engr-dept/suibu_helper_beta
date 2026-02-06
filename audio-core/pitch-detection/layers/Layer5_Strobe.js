/**
 * Layer 5: Strobe Engine
 * 
 * マイクロ・ストロボ描画
 * 推定ピッチとターゲットの位相差を回転速度として表現
 * 1セント以下の微細なズレを視覚的に「止まって見える」まで追い込めるUI
 */

class StrobeEngine {
    constructor(options = {}) {
        this.a4 = options.a4 ?? 440;
        this.strobeResolution = options.strobeResolution ?? 0.1;  // セント解像度

        // ストロボ回転状態
        this._phase = 0;
        this._angularVelocity = 0;

        // 時間追跡
        this._lastTimestamp = null;

        // スムージング
        this._velocitySmoother = new ExponentialSmoother(0.85);

        // TARGET: 最も近い音階
        this._targetNote = null;
        this._targetFreq = null;
        this._targetCents = 0;

        // 音階テーブル
        this._noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    }

    /**
     * ストロボデータを計算
     * @param {number} freq - 検出周波数
     * @param {number} a4 - A4基準周波数
     * @returns {Object} ストロボ描画データ
     */
    calculate(freq, a4 = null) {
        if (!freq || freq <= 0) {
            return this._createEmptyResult();
        }

        if (a4) this.a4 = a4;

        const now = performance.now();
        const dt = this._lastTimestamp ? (now - this._lastTimestamp) / 1000 : 0;
        this._lastTimestamp = now;

        // 最も近い音階を特定
        const noteInfo = this._getNoteInfo(freq);
        this._targetNote = noteInfo.note;
        this._targetFreq = noteInfo.targetFreq;
        this._targetCents = noteInfo.cents;

        // ===== 角速度計算 =====
        // セント偏差から回転速度を計算
        // 0セント = 停止、50セント = 最大速度
        const centsDeviation = noteInfo.preciseCents;
        const rawVelocity = this._centsToAngularVelocity(centsDeviation);

        // スムージング
        this._angularVelocity = this._velocitySmoother.smooth(rawVelocity);

        // 位相更新
        if (dt > 0 && dt < 0.1) {  // 100ms以上の間隔は無視
            this._phase += this._angularVelocity * dt;
            this._phase = this._phase % (2 * Math.PI);
        }

        // ===== ストロボパターン計算 =====
        const strobePattern = this._calculateStrobePattern(this._phase, centsDeviation);

        return {
            // 基本情報
            freq,
            targetNote: noteInfo.note,
            targetOctave: noteInfo.octave,
            targetFreq: noteInfo.targetFreq,

            // セント偏差
            cents: noteInfo.cents,
            preciseCents: noteInfo.preciseCents,

            // ストロボ回転
            phase: this._phase,
            angularVelocity: this._angularVelocity,
            rotationDirection: centsDeviation >= 0 ? 'clockwise' : 'counterclockwise',

            // 視覚化データ
            strobePattern,

            // チューニング状態
            inTune: Math.abs(centsDeviation) < 1,  // ±1セント以内
            closeToTune: Math.abs(centsDeviation) < 5,  // ±5セント以内

            // 補助情報
            stabilityIndex: this._calculateStabilityIndex(),
            timestamp: now
        };
    }

    _getNoteInfo(freq) {
        // A4からのセミトーン数
        const semitones = 12 * Math.log2(freq / this.a4);
        const roundedSemitones = Math.round(semitones);

        // セント偏差（0.1セント精度）
        const centsRaw = (semitones - roundedSemitones) * 100;
        const preciseCents = Math.round(centsRaw * 10) / 10;
        const cents = Math.round(centsRaw);

        // 音名とオクターブ
        const noteIndex = ((roundedSemitones % 12) + 12 + 9) % 12;  // Aを基準に調整
        const octave = Math.floor((roundedSemitones + 9) / 12) + 4;

        // ターゲット周波数
        const targetFreq = this.a4 * Math.pow(2, roundedSemitones / 12);

        return {
            note: this._noteNames[noteIndex],
            octave,
            targetFreq,
            cents,
            preciseCents
        };
    }

    _centsToAngularVelocity(cents) {
        // セント偏差を角速度に変換
        // 設計: 1セント = 約0.5 rad/s（チューニング時に見やすい速度）
        // 50セント以上 = 最大速度（約25 rad/s）

        const maxVelocity = 25;  // rad/s
        const sensitivity = 0.5;  // rad/s per cent

        // 非線形マッピング（小さい偏差は拡大、大きい偏差は圧縮）
        const absDeviation = Math.abs(cents);
        let velocity;

        if (absDeviation < 5) {
            // 高精度領域: 線形
            velocity = absDeviation * sensitivity;
        } else if (absDeviation < 20) {
            // 中間領域: 緩やかな増加
            velocity = 5 * sensitivity + (absDeviation - 5) * sensitivity * 0.7;
        } else {
            // 大偏差領域: ほぼ最大
            velocity = 5 * sensitivity + 15 * sensitivity * 0.7 +
                (absDeviation - 20) * sensitivity * 0.3;
        }

        // 方向付け（シャープ=時計回り、フラット=反時計回り）
        velocity = Math.min(velocity, maxVelocity);
        return cents >= 0 ? velocity : -velocity;
    }

    _calculateStrobePattern(phase, centsDeviation) {
        // ストロボパターン（複数のリングで構成）
        const rings = [];
        const numRings = 4;

        for (let i = 0; i < numRings; i++) {
            const ringPhase = phase + i * (Math.PI / numRings);
            const segments = 12;  // 12分割（音階に対応）

            const segmentData = [];
            for (let j = 0; j < segments; j++) {
                const segmentAngle = (j / segments) * 2 * Math.PI;
                const brightness = 0.5 + 0.5 * Math.cos(segmentAngle + ringPhase);
                segmentData.push(brightness);
            }

            rings.push({
                index: i,
                phase: ringPhase,
                segments: segmentData,
                radius: 0.3 + i * 0.15  // 0.3 ~ 0.75
            });
        }

        // センターインジケーター
        const centerBrightness = Math.abs(centsDeviation) < 1 ? 1.0 :
            Math.abs(centsDeviation) < 5 ? 0.7 : 0.3;

        return {
            rings,
            center: {
                brightness: centerBrightness,
                color: this._getDeviationColor(centsDeviation)
            }
        };
    }

    _getDeviationColor(cents) {
        // セント偏差に基づく色
        const absCents = Math.abs(cents);

        if (absCents < 1) {
            return { r: 0, g: 255, b: 100 };  // 緑（完璧）
        } else if (absCents < 5) {
            return { r: 100, g: 255, b: 50 };  // 黄緑（良好）
        } else if (absCents < 15) {
            return { r: 255, g: 200, b: 0 };  // 黄（要調整）
        } else if (absCents < 30) {
            return { r: 255, g: 100, b: 0 };  // オレンジ（大きなズレ）
        } else {
            return { r: 255, g: 50, b: 50 };  // 赤（大幅にズレ）
        }
    }

    _calculateStabilityIndex() {
        // 角速度の安定性（低いほど安定）
        const absVelocity = Math.abs(this._angularVelocity);
        return Math.max(0, 1 - absVelocity / 5);
    }

    _createEmptyResult() {
        return {
            freq: null,
            targetNote: null,
            targetOctave: null,
            targetFreq: null,
            cents: null,
            preciseCents: null,
            phase: this._phase,
            angularVelocity: 0,
            rotationDirection: null,
            strobePattern: null,
            inTune: false,
            closeToTune: false,
            stabilityIndex: 0,
            timestamp: performance.now()
        };
    }

    setA4(freq) {
        this.a4 = freq;
    }

    reset() {
        this._phase = 0;
        this._angularVelocity = 0;
        this._lastTimestamp = null;
        this._velocitySmoother.reset();
    }
}

/**
 * ExponentialSmoother - 指数平滑化
 */
class ExponentialSmoother {
    constructor(alpha = 0.8) {
        this.alpha = alpha;
        this._value = null;
    }

    smooth(value) {
        if (this._value === null) {
            this._value = value;
        } else {
            this._value = this.alpha * this._value + (1 - this.alpha) * value;
        }
        return this._value;
    }

    reset() {
        this._value = null;
    }

    getValue() {
        return this._value;
    }
}

/**
 * StrobeRenderer - Canvas/WebGLストロボ描画
 */
class StrobeRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.width = canvas.width;
        this.height = canvas.height;
        this.centerX = this.width / 2;
        this.centerY = this.height / 2;

        this.options = {
            backgroundColor: options.backgroundColor ?? '#1a1a2e',
            ringColors: options.ringColors ?? ['#4361ee', '#3a0ca3', '#7209b7', '#f72585'],
            textColor: options.textColor ?? '#ffffff',
            ...options
        };
    }

    render(strobeData) {
        if (!strobeData) {
            this._renderEmpty();
            return;
        }

        const ctx = this.ctx;

        // 背景クリア
        ctx.fillStyle = this.options.backgroundColor;
        ctx.fillRect(0, 0, this.width, this.height);

        // ストロボリング描画
        if (strobeData.strobePattern) {
            this._renderRings(strobeData.strobePattern);
        }

        // 中心インジケーター
        this._renderCenterIndicator(strobeData);

        // 音名表示
        this._renderNoteDisplay(strobeData);

        // セント表示
        this._renderCentsDisplay(strobeData);
    }

    _renderRings(pattern) {
        const ctx = this.ctx;
        const maxRadius = Math.min(this.width, this.height) * 0.4;

        for (let i = pattern.rings.length - 1; i >= 0; i--) {
            const ring = pattern.rings[i];
            const radius = maxRadius * ring.radius;
            const innerRadius = radius - maxRadius * 0.1;

            for (let j = 0; j < ring.segments.length; j++) {
                const startAngle = (j / ring.segments.length) * 2 * Math.PI - Math.PI / 2;
                const endAngle = ((j + 1) / ring.segments.length) * 2 * Math.PI - Math.PI / 2;

                const brightness = ring.segments[j];
                const color = this.options.ringColors[i % this.options.ringColors.length];

                ctx.beginPath();
                ctx.arc(this.centerX, this.centerY, radius, startAngle, endAngle);
                ctx.arc(this.centerX, this.centerY, innerRadius, endAngle, startAngle, true);
                ctx.closePath();

                ctx.fillStyle = this._adjustBrightness(color, brightness);
                ctx.fill();
            }
        }
    }

    _renderCenterIndicator(strobeData) {
        const ctx = this.ctx;
        const radius = Math.min(this.width, this.height) * 0.08;

        const color = strobeData.strobePattern?.center?.color ?? { r: 100, g: 100, b: 100 };

        ctx.beginPath();
        ctx.arc(this.centerX, this.centerY, radius, 0, 2 * Math.PI);
        ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
        ctx.fill();

        // グロー効果
        if (strobeData.inTune) {
            ctx.shadowColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
            ctx.shadowBlur = 20;
            ctx.fill();
            ctx.shadowBlur = 0;
        }
    }

    _renderNoteDisplay(strobeData) {
        if (!strobeData.targetNote) return;

        const ctx = this.ctx;
        const noteText = `${strobeData.targetNote}${strobeData.targetOctave}`;

        ctx.font = 'bold 48px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = this.options.textColor;
        ctx.fillText(noteText, this.centerX, this.centerY);
    }

    _renderCentsDisplay(strobeData) {
        if (strobeData.preciseCents === null) return;

        const ctx = this.ctx;
        const centsText = strobeData.preciseCents > 0
            ? `+${strobeData.preciseCents.toFixed(1)}¢`
            : `${strobeData.preciseCents.toFixed(1)}¢`;

        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = this.options.textColor;
        ctx.fillText(centsText, this.centerX, this.centerY + Math.min(this.width, this.height) * 0.25);
    }

    _renderEmpty() {
        const ctx = this.ctx;
        ctx.fillStyle = this.options.backgroundColor;
        ctx.fillRect(0, 0, this.width, this.height);

        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#666';
        ctx.fillText('音を検出中...', this.centerX, this.centerY);
    }

    _adjustBrightness(hexColor, brightness) {
        // HEXをRGBに変換
        const hex = hexColor.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        // 明度調整
        const factor = 0.2 + brightness * 0.8;
        return `rgb(${Math.round(r * factor)}, ${Math.round(g * factor)}, ${Math.round(b * factor)})`;
    }

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.width = width;
        this.height = height;
        this.centerX = width / 2;
        this.centerY = height / 2;
    }
}

// Export
if (typeof window !== 'undefined') {
    window.StrobeEngine = StrobeEngine;
    window.StrobeRenderer = StrobeRenderer;
    window.ExponentialSmoother = ExponentialSmoother;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StrobeEngine, StrobeRenderer, ExponentialSmoother };
}
