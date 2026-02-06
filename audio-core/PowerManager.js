/**
 * PowerManager - 統一電力管理システム v2.0
 * 
 * 機能:
 * - 無音検出による処理レート制御
 * - Page Visibility APIによるスリープ制御
 * - モジュール可視性監視
 * - 端末スペック検出と適応型処理
 * - フレーム補間によるスムーズ表示
 * - 精度を落とさずに省電力化
 */
class PowerManager {
    constructor() {
        // === 状態 ===
        this.isPageVisible = true;
        this.isSilent = false;
        this.silentStartTime = 0;
        this.lastRMS = 0;
        this.lowPowerMode = false;

        // === 端末スペック ===
        this.deviceCapability = this._detectDeviceCapability();
        this.optimalFftSize = this._calculateOptimalFftSize();

        // === パフォーマンス監視 ===
        this.frameTimeHistory = [];
        this.avgFrameTime = 16.67;
        this.performanceScore = 1.0; // 0.0〜1.0
        this._lastFrameTime = 0;

        // === 設定 ===
        this.config = {
            // 無音判定
            silenceThreshold: 0.01,
            silenceDelayMs: 2000,

            // 処理レート（必要時は全端末60fps）
            normalFps: 60,
            lowPowerFps: 10,
            sleepFps: 2,

            // フレーム間隔（ms）
            normalInterval: 1000 / 60,
            lowPowerInterval: 100,
            sleepInterval: 500,

            // パフォーマンス監視
            frameHistorySize: 30,
            performanceCheckInterval: 1000,
        };

        // === 補間データ ===
        this.interpolationData = new Map();

        // === 登録モジュール ===
        this.modules = new Map();
        this.visibilityObservers = new Map();

        // === イベントリスナー ===
        this._setupVisibilityListener();
        this._startPerformanceMonitoring();
    }

    // ============================================
    //  端末スペック検出
    // ============================================

    /**
     * 端末の処理能力を検出
     */
    _detectDeviceCapability() {
        const capability = {
            cores: navigator.hardwareConcurrency || 2,
            memory: navigator.deviceMemory || 4,
            isMobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
            isIOS: /iPhone|iPad|iPod/i.test(navigator.userAgent),
            isLowEnd: false,
            score: 1.0,
        };

        // スコア計算（0.0〜1.0）
        let score = 0;

        // コア数（2〜16を想定）
        score += Math.min(capability.cores / 8, 1) * 0.3;

        // メモリ（1〜16GBを想定）
        score += Math.min(capability.memory / 8, 1) * 0.3;

        // デバイスタイプ
        if (!capability.isMobile) {
            score += 0.4; // デスクトップボーナス
        } else if (capability.isIOS) {
            score += 0.2; // iOS中程度
        } else {
            score += 0.1; // Android低め
        }

        capability.score = Math.min(1.0, score);
        capability.isLowEnd = capability.score < 0.4;

        return capability;
    }

    /**
     * 端末に最適なFFTサイズを計算
     */
    _calculateOptimalFftSize() {
        const score = this.deviceCapability.score;

        // スコアに応じて連続的にFFTサイズを決定
        // score 1.0 → 4096, score 0.5 → 2048, score 0.25 → 1024
        if (score >= 0.8) return 4096;
        if (score >= 0.5) return 2048;
        if (score >= 0.3) return 1024;
        return 512;
    }

    /**
     * 最適なFFTサイズを取得
     */
    getOptimalFftSize() {
        // パフォーマンスに応じて動的調整
        const adjusted = this.optimalFftSize * this.performanceScore;

        // 2のべき乗に丸める
        if (adjusted >= 3000) return 4096;
        if (adjusted >= 1500) return 2048;
        if (adjusted >= 750) return 1024;
        return 512;
    }

    // ============================================
    //  パフォーマンス監視
    // ============================================

    /**
     * パフォーマンス監視を開始
     */
    _startPerformanceMonitoring() {
        const monitor = () => {
            const now = performance.now();

            if (this._lastFrameTime > 0) {
                const frameTime = now - this._lastFrameTime;
                this.frameTimeHistory.push(frameTime);

                // 履歴サイズ制限
                if (this.frameTimeHistory.length > this.config.frameHistorySize) {
                    this.frameTimeHistory.shift();
                }

                // 平均フレームタイム計算
                if (this.frameTimeHistory.length >= 10) {
                    this.avgFrameTime = this.frameTimeHistory.reduce((a, b) => a + b, 0)
                        / this.frameTimeHistory.length;

                    // パフォーマンススコア更新
                    // 16.67ms = 1.0, 33ms = 0.5, 50ms = 0.33
                    this.performanceScore = Math.min(1.0, 16.67 / this.avgFrameTime);
                }
            }

            this._lastFrameTime = now;
            requestAnimationFrame(monitor);
        };

        requestAnimationFrame(monitor);
    }

    /**
     * 現在の端末パフォーマンスを取得
     */
    getPerformanceInfo() {
        return {
            capability: this.deviceCapability,
            avgFrameTime: this.avgFrameTime,
            performanceScore: this.performanceScore,
            optimalFftSize: this.getOptimalFftSize(),
        };
    }

    // ============================================
    //  フレーム補間
    // ============================================

    /**
     * 補間データを更新
     */
    updateInterpolationData(moduleId, key, value) {
        if (!this.interpolationData.has(moduleId)) {
            this.interpolationData.set(moduleId, new Map());
        }

        const moduleData = this.interpolationData.get(moduleId);
        const existing = moduleData.get(key);

        if (existing) {
            // 前回値を保存
            existing.previous = existing.current;
            existing.current = value;
            existing.updateTime = performance.now();
        } else {
            moduleData.set(key, {
                previous: value,
                current: value,
                updateTime: performance.now(),
            });
        }
    }

    /**
     * 補間された値を取得
     */
    getInterpolatedValue(moduleId, key, defaultValue = 0) {
        const moduleData = this.interpolationData.get(moduleId);
        if (!moduleData) return defaultValue;

        const data = moduleData.get(key);
        if (!data) return defaultValue;

        // 補間不要の場合
        if (!this.lowPowerMode && this.isPageVisible) {
            return data.current;
        }

        // 線形補間
        const now = performance.now();
        const elapsed = now - data.updateTime;
        const interval = this.lowPowerMode ? this.config.lowPowerInterval : this.config.sleepInterval;
        const t = Math.min(1, elapsed / interval);

        return this._lerp(data.previous, data.current, t);
    }

    /**
     * 配列の補間
     */
    getInterpolatedArray(moduleId, key, defaultArray = null) {
        const moduleData = this.interpolationData.get(moduleId);
        if (!moduleData) return defaultArray;

        const data = moduleData.get(key);
        if (!data) return defaultArray;

        if (!this.lowPowerMode && this.isPageVisible) {
            return data.current;
        }

        // 配列の線形補間
        const now = performance.now();
        const elapsed = now - data.updateTime;
        const interval = this.lowPowerMode ? this.config.lowPowerInterval : this.config.sleepInterval;
        const t = Math.min(1, elapsed / interval);

        if (!Array.isArray(data.previous) || !Array.isArray(data.current)) {
            return data.current;
        }

        const result = new Float32Array(data.current.length);
        for (let i = 0; i < data.current.length; i++) {
            result[i] = this._lerp(
                data.previous[i] || 0,
                data.current[i] || 0,
                t
            );
        }
        return result;
    }

    /**
     * 線形補間
     */
    _lerp(a, b, t) {
        return a + (b - a) * t;
    }

    /**
     * 補間用のスムージング係数を取得
     */
    getSmoothingFactor() {
        if (!this.lowPowerMode && this.isPageVisible) {
            return 1.0; // 通常モード: 即時反映
        }
        return 0.15; // 低電力モード: スムーズ補間
    }

    // ============================================
    //  Page Visibility
    // ============================================

    _setupVisibilityListener() {
        document.addEventListener('visibilitychange', () => {
            this.isPageVisible = !document.hidden;

            if (this.isPageVisible) {
                this._wakeUp();
            } else {
                this._sleep();
            }
        });
    }

    _sleep() {
        this.modules.forEach((moduleData, id) => {
            if (moduleData.onSleep) {
                moduleData.onSleep();
            }
        });
    }

    _wakeUp() {
        this.lowPowerMode = false;
        this.silentStartTime = 0;

        this.modules.forEach((moduleData, id) => {
            if (moduleData.onWakeUp) {
                moduleData.onWakeUp();
            }
        });
    }

    // ============================================
    //  モジュール管理
    // ============================================

    registerModule(id, callbacks) {
        this.modules.set(id, {
            onSleep: callbacks.onSleep || null,
            onWakeUp: callbacks.onWakeUp || null,
            onLowPower: callbacks.onLowPower || null,
            onNormalPower: callbacks.onNormalPower || null,
            element: callbacks.element || null,
            isVisible: true,
        });

        if (callbacks.element) {
            this._setupVisibilityObserver(id, callbacks.element);
        }
    }

    unregisterModule(id) {
        const observer = this.visibilityObservers.get(id);
        if (observer) {
            observer.disconnect();
            this.visibilityObservers.delete(id);
        }
        this.modules.delete(id);
        this.interpolationData.delete(id);
    }

    _setupVisibilityObserver(id, element) {
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    const moduleData = this.modules.get(id);
                    if (moduleData) {
                        moduleData.isVisible = entry.isIntersecting;
                    }
                });
            },
            { threshold: 0.1 }
        );

        observer.observe(element);
        this.visibilityObservers.set(id, observer);
    }

    // ============================================
    //  RMS・電力モード
    // ============================================

    updateRMS(rms) {
        this.lastRMS = rms;
        const now = performance.now();

        if (rms < this.config.silenceThreshold) {
            if (!this.isSilent) {
                this.isSilent = true;
                this.silentStartTime = now;
            } else if (!this.lowPowerMode &&
                now - this.silentStartTime > this.config.silenceDelayMs) {
                this._enterLowPowerMode();
            }
        } else {
            if (this.isSilent || this.lowPowerMode) {
                this._exitLowPowerMode();
            }
            this.isSilent = false;
            this.silentStartTime = 0;
        }
    }

    _enterLowPowerMode() {
        if (this.lowPowerMode) return;
        this.lowPowerMode = true;

        this.modules.forEach((moduleData, id) => {
            if (moduleData.onLowPower) {
                moduleData.onLowPower();
            }
        });
    }

    _exitLowPowerMode() {
        if (!this.lowPowerMode) return;
        this.lowPowerMode = false;

        this.modules.forEach((moduleData, id) => {
            if (moduleData.onNormalPower) {
                moduleData.onNormalPower();
            }
        });
    }

    // ============================================
    //  フレームスキップ判定
    // ============================================

    /**
     * 処理をスキップすべきかチェック（処理用）
     */
    shouldSkipProcessing(moduleId, lastProcessTime) {
        const now = performance.now();

        // ページ非表示
        if (!this.isPageVisible) {
            return now - lastProcessTime < this.config.sleepInterval;
        }

        // モジュール非表示
        const moduleData = this.modules.get(moduleId);
        if (moduleData && !moduleData.isVisible) {
            return now - lastProcessTime < this.config.sleepInterval;
        }

        // 低電力モード
        if (this.lowPowerMode) {
            return now - lastProcessTime < this.config.lowPowerInterval;
        }

        return false;
    }

    /**
     * 描画をスキップすべきかチェック（描画用）
     * 注: 描画は常に60fpsでスムーズに行う
     */
    shouldSkipDrawing(moduleId) {
        // ページ非表示時のみスキップ
        if (!this.isPageVisible) {
            return true;
        }

        // モジュール非表示時はスキップ
        const moduleData = this.modules.get(moduleId);
        if (moduleData && !moduleData.isVisible) {
            return true;
        }

        // 低電力モードでも描画は継続（補間で滑らか表示）
        return false;
    }

    // 旧API互換
    shouldSkipFrame(moduleId, lastProcessTime) {
        return this.shouldSkipProcessing(moduleId, lastProcessTime);
    }

    // ============================================
    //  ユーティリティ
    // ============================================

    getCurrentFps() {
        if (!this.isPageVisible) return this.config.sleepFps;
        if (this.lowPowerMode) return this.config.lowPowerFps;
        return this.config.normalFps;
    }

    getMode() {
        if (!this.isPageVisible) return 'sleep';
        if (this.lowPowerMode) return 'lowPower';
        return 'normal';
    }

    isModuleVisible(moduleId) {
        const moduleData = this.modules.get(moduleId);
        return moduleData ? moduleData.isVisible : true;
    }

    hasAudioActivity() {
        return !this.isSilent || this.lastRMS > this.config.silenceThreshold;
    }
}

// グローバルシングルトン
window.PowerManager = PowerManager;
window.powerManager = new PowerManager();
