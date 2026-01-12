/**
 * Performance Graph Module
 * 演奏中の音程・音量・リズムの時間的変化を可視化するモジュール
 * 
 * 特徴:
 * - 音量を波形として中央から上下に表示
 * - 音程を色付き線グラフで表示（緑=正確、赤=ズレ）
 * - メトロノームの拍を補助線として表示（リズム可視化）
 * - 時間スケールの調整機能
 * 
 * グラフの見方:
 * - 画面右側が「過去」、赤い縦線が「現在」、画面左側が「未来」
 * - グラフは右から左へ流れていく（新しいデータが現在位置に追加される）
 */
class PerformanceGraphModule {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) throw new Error(`Container #${containerId} not found.`);

        // --- Configuration ---
        this.config = {
            bufferSize: 4096,
            downsampleRate: 4,
            confidenceThreshold: 0.85,

            // グラフ設定
            currentTimePosition: 0.85,  // 現在位置（左端から85%の位置 = 右寄り）
            volumeAmplitude: 0.35,      // 音量波形の高さ（グラフ高さの35%）
            pitchLineWidth: 2.5,        // 音程ラインの太さ
            gridLineAlpha: 0.3,         // グリッド線の透明度

            // 音程の色設定（セント差に応じて）
            pitchColorOk: { r: 0, g: 229, b: 204 },      // 緑 (#00e5cc)
            pitchColorWarn: { r: 255, g: 179, b: 71 },   // オレンジ (#ffb347)
            pitchColorError: { r: 255, g: 107, b: 107 }, // 赤 (#ff6b6b)

            // 閾値
            centsOk: 5,      // 正確と判定するセント差
            centsWarn: 15,   // 警告レベルのセント差
            centsMax: 50,    // 最大表示セント差

            // ノイズフィルタリング
            harmonicMinCount: 2,
            harmonicTolerance: 0.06,
            harmonicMinStrength: 0.15,
            minPitchDurationMs: 50,
        };

        // --- State ---
        this.audioContext = null;
        this.analyser = null;
        this.micSource = null;
        this.filter = null;
        this.isRunning = false;
        this.animationId = null;
        this.resizeObserver = null;
        this.currentSourceMode = null;

        // Buffers
        this.timeBuf = null;
        this.freqBuf = null;
        this.yinBuffer = null;
        this.mpmNsdf = null;

        // --- Data History ---
        this.dataHistory = [];
        this.maxHistorySize = 1800;  // 30秒 × 60fps
        this.timeScale = 10;         // 表示秒数（デフォルト10秒）
        this.lastTimestamp = 0;

        // --- Constants ---
        this.NOTES_EN = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

        // --- DOM Elements ---
        this.bindDOMElements();
    }

    bindDOMElements() {
        const q = (sel) => this.container.querySelector(sel);
        this.els = {
            canvas: q('#performanceCanvas'),
            timeScaleSelect: q('#timeScaleSelect'),
        };
        this.ctx = this.els.canvas?.getContext('2d');
    }

    // ============================================
    //  Lifecycle Methods
    // ============================================

    mount() {
        this.handleResize();

        // Canvasのリサイズ監視
        this.resizeObserver = new ResizeObserver(() => this.handleResize());
        const canvasParent = this.els.canvas?.parentElement;
        if (canvasParent) this.resizeObserver.observe(canvasParent);

        // 時間スケール設定イベント
        if (this.els.timeScaleSelect) {
            this.els.timeScaleSelect.addEventListener('change', (e) => {
                this.timeScale = parseInt(e.target.value) || 10;
                console.log('⏱️ Time scale changed to:', this.timeScale, 'seconds');
            });
            // 初期値を同期
            this.timeScale = parseInt(this.els.timeScaleSelect.value) || 10;
        }

        // 処理ループ開始
        this.startProcessing();
    }

    dispose() {
        this.stop();
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }

    handleResize() {
        const parent = this.els.canvas?.parentElement;
        if (parent && this.els.canvas) {
            const rect = parent.getBoundingClientRect();
            // ピクセル密度を考慮してCanvas解像度を設定
            const dpr = window.devicePixelRatio || 1;
            this.els.canvas.width = Math.floor(rect.width * dpr);
            this.els.canvas.height = Math.floor(rect.height * dpr);
            // CSS上のサイズは親要素に合わせる
            this.els.canvas.style.width = rect.width + 'px';
            this.els.canvas.style.height = rect.height + 'px';
            // コンテキストのスケールを設定
            if (this.ctx) {
                this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }
        }
    }

    // ============================================
    //  Audio Setup (GlobalAudioManager連携)
    // ============================================

    startProcessing() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.processLoop();
    }

    setupAudioIfNeeded() {
        if (this.analyser) return true;

        const gam = window.globalAudioManager;
        if (!gam || !gam.audioContext) {
            return false;
        }

        try {
            this.audioContext = gam.audioContext;

            this.timeBuf = new Float32Array(this.config.bufferSize);
            this.freqBuf = new Uint8Array(this.config.bufferSize / 2);
            this.yinBuffer = new Float32Array(this.config.bufferSize / 2);
            this.mpmNsdf = new Float32Array(this.config.bufferSize);

            this.filter = this.audioContext.createBiquadFilter();
            this.filter.type = "bandpass";
            this.filter.frequency.value = 800;
            this.filter.Q.value = 0.3;

            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = this.config.bufferSize;

            this.filter.connect(this.analyser);

            this.setupAudioSource();

            return true;
        } catch (e) {
            console.error("PerformanceGraph Audio Init Failed:", e);
            return false;
        }
    }

    setupAudioSource() {
        const gam = window.globalAudioManager;
        if (!gam || !this.filter) return;

        const isFileMode = gam.isFileMode;

        if (isFileMode) {
            if (this.currentSourceMode !== 'file') {
                try { if (this.micSource) this.micSource.disconnect(); } catch (e) { }
                this.micSource = null;
                this.currentSourceMode = 'file';
            }
        } else {
            const stream = gam.getMicStream();

            if (stream) {
                if (!this.micSource) {
                    this.micSource = this.audioContext.createMediaStreamSource(stream);
                    this.micSource.connect(this.filter);
                    this.currentSourceMode = 'mic';
                }
            } else {
                if (this.currentSourceMode === 'file') {
                    this.currentSourceMode = null;
                }
            }
        }
    }

    stop() {
        this.isRunning = false;
        if (this.animationId) cancelAnimationFrame(this.animationId);
    }

    // ============================================
    //  Global Settings Access
    // ============================================

    getA4() {
        const gam = window.globalAudioManager;
        return gam ? gam.getA4() : 442;
    }

    getGain() {
        const gam = window.globalAudioManager;
        return gam ? gam.getGain() : 1;
    }

    getMinRMS() {
        const gain = this.getGain();
        return 0.012 / gain;
    }

    isFileMode() {
        const gam = window.globalAudioManager;
        return gam ? gam.isFileMode : false;
    }

    // ============================================
    //  Processing Loop
    // ============================================

    processLoop() {
        if (!this.isRunning) return;
        this.animationId = requestAnimationFrame(() => this.processLoop());

        const now = performance.now();

        // AudioContextが利用可能になったらセットアップを試みる
        this.setupAudioIfNeeded();
        this.setupAudioSource();

        const gam = window.globalAudioManager;

        // ファイルモードの場合はGlobalAudioManagerのAnalyserを使用
        let analyserToUse = this.analyser;
        if (this.isFileMode() && gam && gam.analyser) {
            analyserToUse = gam.analyser;
        }

        // Analyserがまだ無い場合はグリッドのみ描画
        if (!analyserToUse) {
            this.draw();
            return;
        }

        analyserToUse.getFloatTimeDomainData(this.timeBuf);
        analyserToUse.getByteFrequencyData(this.freqBuf);

        // RMS計算
        const rms = this.calculateRMS(this.timeBuf);
        const minRMS = this.getMinRMS();

        let freq = 0;
        let cents = 0;

        // 音量が閾値を超えている場合のみ音程解析
        if (rms >= minRMS) {
            const sr = this.audioContext.sampleRate;
            const yinRes = this.runYIN(this.timeBuf, sr);
            const mpmRes = this.runMPM(this.timeBuf, sr);
            const fftRes = this.runFFT_Harmonic(this.freqBuf, sr);

            // 最も信頼性の高い周波数を選択
            freq = this.selectBestFrequency(yinRes, mpmRes, fftRes);

            if (freq > 0) {
                const pitchInfo = this.getPitchInfo(freq);
                cents = pitchInfo.cents;
            }
        }

        // データをプッシュ
        this.pushDataPoint(now, rms, freq, cents);

        // 描画
        this.draw();
    }

    pushDataPoint(timestamp, rms, freq, cents) {
        this.dataHistory.push({ timestamp, rms, freq, cents });

        // 履歴サイズを制限（表示秒数の1.5倍を保持）
        const maxSamples = Math.ceil(this.timeScale * 60 * 1.5);
        while (this.dataHistory.length > Math.min(this.maxHistorySize, maxSamples)) {
            this.dataHistory.shift();
        }

        this.lastTimestamp = timestamp;
    }

    // ============================================
    //  Pitch Detection (TunerModuleと同じアルゴリズム)
    // ============================================

    calculateRMS(buf) {
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return Math.sqrt(sum / buf.length);
    }

    runYIN(buffer, sr) {
        const dr = this.config.downsampleRate;
        const len = Math.floor(buffer.length / dr);
        const yb = this.yinBuffer;
        const threshold = 0.15;

        for (let t = 1; t < len; t++) {
            let sum = 0;
            for (let i = 0; i < len - t; i++) {
                const d = buffer[i * dr] - buffer[(i + t) * dr];
                sum += d * d;
            }
            yb[t] = sum;
        }

        yb[0] = 1;
        let runningSum = 0;
        for (let t = 1; t < len; t++) {
            runningSum += yb[t];
            yb[t] = yb[t] * t / runningSum;
        }

        let tauEstimate = -1;
        for (let t = 2; t < len - 1; t++) {
            if (yb[t] < threshold && yb[t] < yb[t - 1] && yb[t] <= yb[t + 1]) {
                tauEstimate = t;
                break;
            }
        }

        if (tauEstimate < 0) return { freq: 0, prob: 0 };

        const betterTau = this.parabolicInterpolation(yb, tauEstimate);
        const freq = (sr / dr) / betterTau;
        const prob = 1 - yb[tauEstimate];

        return { freq: freq > 50 && freq < 2000 ? freq : 0, prob };
    }

    runMPM(buffer, sr) {
        const dr = this.config.downsampleRate;
        const len = Math.floor(buffer.length / dr);
        const nsdf = this.mpmNsdf;

        for (let t = 0; t < len; t++) {
            let acf = 0, m = 0;
            for (let i = 0; i < len - t; i++) {
                const s1 = buffer[i * dr], s2 = buffer[(i + t) * dr];
                acf += s1 * s2;
                m += s1 * s1 + s2 * s2;
            }
            nsdf[t] = m > 0 ? 2 * acf / m : 0;
        }

        const peaks = [];
        for (let i = 1; i < len - 1; i++) {
            if (nsdf[i] > nsdf[i - 1] && nsdf[i] > nsdf[i + 1] && nsdf[i] > 0) {
                peaks.push({ tau: i, val: nsdf[i] });
            }
        }

        if (peaks.length === 0) return { freq: 0, prob: 0 };

        const threshold = 0.8 * Math.max(...peaks.map(p => p.val));
        const firstGood = peaks.find(p => p.val >= threshold);
        if (!firstGood) return { freq: 0, prob: 0 };

        const tau = this.parabolicInterpolation(nsdf, firstGood.tau);
        const freq = (sr / dr) / tau;

        return { freq: freq > 50 && freq < 2000 ? freq : 0, prob: firstGood.val };
    }

    runFFT_Harmonic(freqData, sr) {
        const binSize = sr / (freqData.length * 2);
        let maxVal = 0, maxBin = 0;

        for (let i = 1; i < freqData.length / 2; i++) {
            if (freqData[i] > maxVal) {
                maxVal = freqData[i];
                maxBin = i;
            }
        }

        const freq = maxBin * binSize;
        const prob = maxVal / 255;

        return { freq: freq > 50 && freq < 2000 ? freq : 0, prob };
    }

    parabolicInterpolation(arr, x) {
        const x0 = x > 0 ? arr[x - 1] : arr[x];
        const x1 = arr[x];
        const x2 = x < arr.length - 1 ? arr[x + 1] : arr[x];
        const denom = x0 - 2 * x1 + x2;
        return denom !== 0 ? x + (x0 - x2) / (2 * denom) : x;
    }

    selectBestFrequency(yinRes, mpmRes, fftRes) {
        const candidates = [
            { freq: yinRes.freq, prob: yinRes.prob, name: 'yin' },
            { freq: mpmRes.freq, prob: mpmRes.prob, name: 'mpm' },
            { freq: fftRes.freq, prob: fftRes.prob * 0.7, name: 'fft' }
        ].filter(c => c.freq > 0 && c.prob > 0.3);

        if (candidates.length === 0) return 0;

        // 最も確信度の高い候補を選択
        candidates.sort((a, b) => b.prob - a.prob);
        return candidates[0].freq;
    }

    getPitchInfo(f) {
        if (!f || f <= 0) return { note: '--', oct: '', cents: 0, rawMidi: 0 };

        const a4 = this.getA4();
        const rawMidi = 69 + 12 * Math.log2(f / a4);
        const roundedMidi = Math.round(rawMidi);
        const cents = (rawMidi - roundedMidi) * 100;

        const noteIndex = ((roundedMidi % 12) + 12) % 12;
        const octave = Math.floor(roundedMidi / 12) - 1;

        return {
            note: this.NOTES_EN[noteIndex],
            oct: octave,
            cents,
            rawMidi
        };
    }

    // ============================================
    //  Metronome Integration
    // ============================================

    /**
     * メトロノームモジュールのインスタンスを取得
     */
    getMetronomeInstance() {
        const layoutManager = window.layoutManager;
        if (!layoutManager || !layoutManager.panels) return null;

        for (const [panelId, panelData] of layoutManager.panels) {
            if (panelData.instance && panelData.instance.constructor.name === 'MetronomeModule') {
                return panelData.instance;
            }
        }
        return null;
    }

    /**
     * メトロノームの拍タイミング情報を取得
     */
    getMetronomeTiming() {
        const metronome = this.getMetronomeInstance();
        if (!metronome || !metronome.isPlaying) {
            return null;
        }

        const secondsPerBeat = metronome.getSecondsPerBeat();
        const audioContext = metronome.audioContext;

        if (!audioContext || !secondsPerBeat) return null;

        const currentTime = audioContext.currentTime;
        const nextNoteTime = metronome.nextNoteTime;

        return {
            secondsPerBeat,
            currentTime,
            nextNoteTime,
            isPlaying: true
        };
    }

    // ============================================
    //  Drawing
    // ============================================

    draw() {
        const canvas = this.els.canvas;
        if (!canvas || !this.ctx) return;

        const ctx = this.ctx;
        // CSS上のサイズを使用（devicePixelRatioはsetTransformで対応済み）
        const w = canvas.clientWidth || canvas.width;
        const h = canvas.clientHeight || canvas.height;

        // 背景クリア
        ctx.fillStyle = '#0a1214';
        ctx.fillRect(0, 0, w, h);

        if (w === 0 || h === 0) return;

        // クリッピング領域を設定（画面外への描画を防止）
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();

        const currentX = w * this.config.currentTimePosition;  // 現在位置のX座標（右側85%）
        const centerY = h / 2;                                  // グラフの中央Y座標

        // グリッド線を描画
        this.drawGridLines(ctx, w, h, centerY);

        // メトロノームの拍線を描画
        this.drawMetronomeBars(ctx, w, h, currentX);

        // データがある場合のみグラフを描画
        if (this.dataHistory.length > 1) {
            // 音量波形を描画（過去のデータ：現在位置から左へ）
            this.drawVolumeWaveform(ctx, w, h, currentX, centerY);

            // 音程ラインを描画（過去のデータ：現在位置から左へ）
            this.drawPitchLine(ctx, w, h, currentX, centerY);
        }

        // 現在位置の赤い縦線を描画
        this.drawCurrentTimeLine(ctx, currentX, h);

        ctx.restore();
    }

    drawGridLines(ctx, w, h, centerY) {
        const alpha = this.config.gridLineAlpha;

        // 中央の水平線（0線）
        ctx.beginPath();
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth = 1;
        ctx.moveTo(0, centerY);
        ctx.lineTo(w, centerY);
        ctx.stroke();

        // 音程のガイドライン（±25セント、±50セント）
        const centsLines = [25, 50];
        const maxCents = this.config.centsMax;
        const heightPerCent = (h * 0.4) / maxCents;

        centsLines.forEach(cents => {
            const offset = cents * heightPerCent;

            ctx.beginPath();
            ctx.strokeStyle = `rgba(100, 100, 100, ${alpha * 0.5})`;
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;

            // 上（高い音程）
            ctx.moveTo(0, centerY - offset);
            ctx.lineTo(w, centerY - offset);
            ctx.stroke();

            // 下（低い音程）
            ctx.moveTo(0, centerY + offset);
            ctx.lineTo(w, centerY + offset);
            ctx.stroke();

            ctx.setLineDash([]);
        });

        // セント表示ラベル（右端）
        ctx.fillStyle = 'rgba(150, 150, 150, 0.5)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';

        ctx.fillText('+50¢', w - 4, centerY - 50 * heightPerCent + 4);
        ctx.fillText('+25¢', w - 4, centerY - 25 * heightPerCent + 4);
        ctx.fillText('0¢', w - 4, centerY + 4);
        ctx.fillText('-25¢', w - 4, centerY + 25 * heightPerCent + 4);
        ctx.fillText('-50¢', w - 4, centerY + 50 * heightPerCent + 4);
    }

    drawMetronomeBars(ctx, w, h, currentX) {
        const timing = this.getMetronomeTiming();
        if (!timing) return;

        const { secondsPerBeat, currentTime, nextNoteTime } = timing;

        // 過去の表示範囲（現在位置から左への表示秒数）
        const pastDisplaySeconds = this.timeScale;
        const pastWidth = currentX;  // 現在位置の左側の幅
        const pixelsPerSecondPast = pastWidth / pastDisplaySeconds;

        // 未来の表示範囲（現在位置から右への表示秒数）
        const futureWidth = w - currentX;
        const futureDisplaySeconds = this.timeScale * 0.2;  // 未来は20%程度
        const pixelsPerSecondFuture = futureWidth / futureDisplaySeconds;

        ctx.strokeStyle = 'rgba(150, 150, 150, 0.4)';
        ctx.lineWidth = 1;

        // 次の拍までの時間
        const timeToNextBeat = nextNoteTime - currentTime;

        // 未来の拍（右側）
        for (let i = 0; i < 10; i++) {
            const beatTime = timeToNextBeat + i * secondsPerBeat;
            if (beatTime > futureDisplaySeconds || beatTime < 0) {
                if (beatTime > futureDisplaySeconds) break;
                continue;
            }

            const x = currentX + beatTime * pixelsPerSecondFuture;
            if (x >= currentX && x <= w) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
        }

        // 過去の拍（左側）
        // 現在時刻から逆算して過去の拍位置を計算
        const timeSinceLastBeat = secondsPerBeat - (timeToNextBeat % secondsPerBeat);

        for (let i = 0; i < 30; i++) {
            const timePast = timeSinceLastBeat + i * secondsPerBeat;
            if (timePast > pastDisplaySeconds) break;

            const x = currentX - timePast * pixelsPerSecondPast;
            if (x >= 0 && x <= currentX) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
        }
    }

    drawVolumeWaveform(ctx, w, h, currentX, centerY) {
        if (this.dataHistory.length < 2) return;

        const now = this.lastTimestamp;
        const displayMs = this.timeScale * 1000;  // 過去の表示範囲（ミリ秒）
        const pixelsPerMs = currentX / displayMs;

        // 最大音量を計算（正規化用）
        let maxRMS = 0.1;
        for (let i = this.dataHistory.length - 1; i >= 0; i--) {
            const point = this.dataHistory[i];
            if (now - point.timestamp > displayMs) break;
            if (point.rms > maxRMS) maxRMS = point.rms;
        }
        const amplitudeScale = h * this.config.volumeAmplitude / maxRMS;

        // 波形パスを構築
        ctx.beginPath();
        ctx.moveTo(currentX, centerY);

        // 過去のデータを描画（現在位置から左へ）
        let lastX = currentX;
        for (let i = this.dataHistory.length - 1; i >= 0; i--) {
            const point = this.dataHistory[i];
            const age = now - point.timestamp;

            if (age > displayMs) break;

            const x = currentX - age * pixelsPerMs;
            if (x < 0) break;

            const amplitude = point.rms * amplitudeScale;
            ctx.lineTo(x, centerY - amplitude);
            lastX = x;
        }

        // 左端まで延長
        ctx.lineTo(Math.max(0, lastX), centerY);

        // 下半分（対称）- 逆順で描画
        for (let i = 0; i < this.dataHistory.length; i++) {
            const point = this.dataHistory[i];
            const age = now - point.timestamp;

            if (age > displayMs) continue;

            const x = currentX - age * pixelsPerMs;
            if (x < 0) continue;

            const amplitude = point.rms * amplitudeScale;
            ctx.lineTo(x, centerY + amplitude);
        }

        ctx.closePath();

        // グラデーション塗りつぶし
        const gradient = ctx.createLinearGradient(0, centerY - h * this.config.volumeAmplitude, 0, centerY + h * this.config.volumeAmplitude);
        gradient.addColorStop(0, 'rgba(78, 205, 196, 0.5)');
        gradient.addColorStop(0.5, 'rgba(78, 205, 196, 0.1)');
        gradient.addColorStop(1, 'rgba(78, 205, 196, 0.5)');

        ctx.fillStyle = gradient;
        ctx.fill();

        // 外枠線
        ctx.strokeStyle = 'rgba(78, 205, 196, 0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    drawPitchLine(ctx, w, h, currentX, centerY) {
        if (this.dataHistory.length < 2) return;

        const now = this.lastTimestamp;
        const displayMs = this.timeScale * 1000;
        const pixelsPerMs = currentX / displayMs;
        const maxCents = this.config.centsMax;
        const heightPerCent = (h * 0.4) / maxCents;

        ctx.lineWidth = this.config.pitchLineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        let prevX = null;
        let prevY = null;

        // 過去のデータを描画（新しいデータから古いデータへ）
        for (let i = this.dataHistory.length - 1; i >= 0; i--) {
            const point = this.dataHistory[i];
            const age = now - point.timestamp;

            if (age > displayMs) break;
            if (point.freq <= 0) {
                prevX = null;
                prevY = null;
                continue;
            }

            const x = currentX - age * pixelsPerMs;
            if (x < 0) break;

            const clampedCents = Math.max(-maxCents, Math.min(maxCents, point.cents));
            const y = centerY - clampedCents * heightPerCent;

            if (prevX !== null && prevY !== null) {
                // セグメントを描画
                ctx.beginPath();
                ctx.moveTo(prevX, prevY);
                ctx.lineTo(x, y);

                // 色をセント差に応じて設定
                const color = this.getPitchColor(Math.abs(point.cents));
                ctx.strokeStyle = color;
                ctx.stroke();
            }

            prevX = x;
            prevY = y;
        }
    }

    getPitchColor(absCents) {
        const { centsOk, centsWarn, pitchColorOk, pitchColorWarn, pitchColorError } = this.config;

        if (absCents <= centsOk) {
            return `rgb(${pitchColorOk.r}, ${pitchColorOk.g}, ${pitchColorOk.b})`;
        } else if (absCents <= centsWarn) {
            // OKからWarnへのグラデーション
            const t = (absCents - centsOk) / (centsWarn - centsOk);
            const r = Math.round(pitchColorOk.r + (pitchColorWarn.r - pitchColorOk.r) * t);
            const g = Math.round(pitchColorOk.g + (pitchColorWarn.g - pitchColorOk.g) * t);
            const b = Math.round(pitchColorOk.b + (pitchColorWarn.b - pitchColorOk.b) * t);
            return `rgb(${r}, ${g}, ${b})`;
        } else {
            // WarnからErrorへのグラデーション
            const t = Math.min(1, (absCents - centsWarn) / (50 - centsWarn));
            const r = Math.round(pitchColorWarn.r + (pitchColorError.r - pitchColorWarn.r) * t);
            const g = Math.round(pitchColorWarn.g + (pitchColorError.g - pitchColorWarn.g) * t);
            const b = Math.round(pitchColorWarn.b + (pitchColorError.b - pitchColorWarn.b) * t);
            return `rgb(${r}, ${g}, ${b})`;
        }
    }

    drawCurrentTimeLine(ctx, x, h) {
        // 現在位置を示す赤い縦線
        ctx.beginPath();
        ctx.strokeStyle = '#ff1744';
        ctx.lineWidth = 2;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();

        // 「NOW」ラベル
        ctx.fillStyle = '#ff1744';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('NOW', x, 14);
    }
}

// グローバルに公開
if (typeof window !== 'undefined' && !window.PerformanceGraphModule) {
    window.PerformanceGraphModule = PerformanceGraphModule;
}
