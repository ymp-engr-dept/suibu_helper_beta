/**
 * Metronome Module v5
 * 脳科学的に最適化されたメトロノーム
 * - 聴覚心理学に基づく最適な周波数帯 (3000Hz)
 * - 1拍目（拍頭）の明確な区別
 * - 視覚的な拍インジケータ
 * - 準備カウント機能
 * - 拍子分母に基づく正確なテンポ計算
 * - 細分化（三連符、八分音符など）
 * - タップテンポ
 * - 音量調節
 */
class MetronomeModule {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.audioContext = null;

        // 状態管理
        this.isPlaying = false;
        this.tempo = 120;           // BPM（基準は4分音符）
        this.beatsPerMeasure = 4;   // 拍子の分子（1小節あたりの拍数）
        this.beatUnit = 4;          // 拍子の分母（4=4分音符、8=8分音符）
        this.subdivision = 1;       // 細分化（1拍に何回カウントするか）
        this.currentBeat = 0;       // 現在の拍（0 = 停止中、1〜beatsPerMeasure = 拍番号）
        this.currentMeasure = 1;    // 現在の小節
        this.currentSubdivision = 0; // 現在の細分化位置

        // 準備カウント関連
        this.countInEnabled = false;    // 準備カウント有効
        this.isCountingIn = false;      // 準備カウント中
        this.countInBeat = 0;           // 準備カウントの現在拍

        // タイミング管理
        this.schedulerTimer = null;
        this.nextNoteTime = 0;
        this.scheduleAheadTime = 0.1;  // 100ms先までスケジュール
        this.lookAhead = 25;           // スケジューラーの呼び出し間隔（ms）

        // 次に鳴らす拍（schedulerが先読みするため、表示とは別管理）
        this.nextBeatToPlay = 1;
        this.nextMeasureToPlay = 1;
        this.nextSubdivisionToPlay = 1; // 細分化の位置（1〜subdivision）

        // 視覚的更新用のキュー（音と表示を同期させる）
        this.beatQueue = [];

        // 視覚的更新用
        this.animationFrame = null;

        // 保存用（一時停止からの再開用）
        this.savedMeasure = 1;
        this.isPaused = false;  // 一時停止状態かどうか

        // タップテンポ関連
        this.tapTimes = [];
        this.tapTimeout = null;
        this.TAP_RESET_TIME = 2000;  // 2秒間タップがないとリセット
        this.MIN_TEMPO = 20;
        this.MAX_TEMPO = 300;

        // 音量（0〜1、内部的に指数カーブを適用）
        this.volume = 0.5;
        this.volumeMultiplier = 1.0; // 実際の音量倍率

        this.bindDOMElements();
        this.setupEventListeners();
    }

    bindDOMElements() {
        const q = (sel) => this.container.querySelector(sel);

        this.els = {
            mainDisplay: q('#mainDisplay'),
            beatDisplay: q('#beatDisplay'),
            beatTotal: q('#beatTotal'),
            measureDisplay: q('#measureDisplay'),
            beatIndicators: q('#beatIndicators'),
            subdivisionIndicator: q('#subdivisionIndicator'),
            tempoInput: q('#tempoInput'),
            tempoSlider: q('#tempoSlider'),
            tempoDecrease: q('#tempoDecrease'),
            tempoIncrease: q('#tempoIncrease'),
            tempoDisplay: q('#tempoDisplay'),
            beatsInput: q('#beatsInput'),
            beatUnitInput: q('#beatUnitInput'),
            subdivisionInput: q('#subdivisionInput'),
            countInCheckbox: q('#countInCheckbox'),
            countInOverlay: q('#countInOverlay'),
            countInNumber: q('#countInNumber'),
            tapTempoBtn: q('#tapTempoBtn'),
            volumeSlider: q('#volumeSlider'),
            volumeValue: q('#volumeValue'),
            startBtn: q('#startBtn'),
            startBtnIcon: q('#startBtnIcon'),
            resetBtn: q('#resetBtn'),
            settingsBtn: q('#settingsBtn'),
            settingsPanel: q('#settingsPanel'),
            settingsCloseBtn: q('#settingsCloseBtn'),
        };
    }

    setupEventListeners() {
        // テンポコントロール
        this.els.tempoInput?.addEventListener('change', (e) => {
            this.setTempo(parseInt(e.target.value) || 120);
        });

        this.els.tempoSlider?.addEventListener('input', (e) => {
            const tempo = parseInt(e.target.value);
            this.setTempo(tempo);
            this.els.tempoInput.value = tempo;
        });

        this.els.tempoDecrease?.addEventListener('click', () => {
            this.setTempo(Math.max(this.MIN_TEMPO, this.tempo - 1));
        });

        this.els.tempoIncrease?.addEventListener('click', () => {
            this.setTempo(Math.min(this.MAX_TEMPO, this.tempo + 1));
        });

        // 拍子コントロール（数値入力）
        this.els.beatsInput?.addEventListener('change', (e) => {
            const beats = Math.max(1, Math.min(32, parseInt(e.target.value) || 4));
            this.els.beatsInput.value = beats;
            this.setTimeSignature(beats, this.beatUnit);
        });

        this.els.beatUnitInput?.addEventListener('change', (e) => {
            const unit = Math.max(1, Math.min(16, parseInt(e.target.value) || 4));
            this.els.beatUnitInput.value = unit;
            this.setTimeSignature(this.beatsPerMeasure, unit);
        });

        // 細分化コントロール
        this.els.subdivisionInput?.addEventListener('change', (e) => {
            const sub = Math.max(1, Math.min(8, parseInt(e.target.value) || 1));
            this.els.subdivisionInput.value = sub;
            this.setSubdivision(sub);
        });

        // 準備カウントチェックボックス
        this.els.countInCheckbox?.addEventListener('change', (e) => {
            this.countInEnabled = e.target.checked;
        });

        // タップテンポ
        this.els.tapTempoBtn?.addEventListener('click', () => {
            this.handleTapTempo();
        });

        // 音量調節
        this.els.volumeSlider?.addEventListener('input', (e) => {
            const vol = parseInt(e.target.value);
            this.setVolume(vol / 100);
            if (this.els.volumeValue) {
                this.els.volumeValue.textContent = `${vol}%`;
            }
        });

        // スタート/ストップボタン
        this.els.startBtn?.addEventListener('click', () => {
            if (this.isPlaying || this.isCountingIn) {
                this.stop();
            } else {
                this.start();
            }
        });

        // リセットボタン
        this.els.resetBtn?.addEventListener('click', () => {
            this.reset();
        });

        // 設定パネルを開く
        this.els.settingsBtn?.addEventListener('click', () => {
            this.openSettings();
        });

        // 設定パネルを閉じる
        this.els.settingsCloseBtn?.addEventListener('click', () => {
            this.closeSettings();
        });
    }

    /**
     * 設定パネルを開く
     */
    openSettings() {
        this.els.settingsPanel?.classList.add('open');
    }

    /**
     * 設定パネルを閉じる
     */
    closeSettings() {
        this.els.settingsPanel?.classList.remove('open');
    }

    mount() {
        this.updateBeatIndicators();
        this.updateSubdivisionIndicator();
        this.updateUI();
    }

    dispose() {
        this.stop();
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    /**
     * テンポを設定
     */
    setTempo(bpm) {
        this.tempo = Math.max(this.MIN_TEMPO, Math.min(this.MAX_TEMPO, bpm));
        if (this.els.tempoInput) this.els.tempoInput.value = this.tempo;
        if (this.els.tempoSlider) this.els.tempoSlider.value = this.tempo;
        if (this.els.tempoDisplay) this.els.tempoDisplay.textContent = this.tempo;
    }

    /**
     * 音量を設定（0〜1）
     * 指数カーブを適用: 50%で基準音量、100%で4倍の音量
     */
    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, vol));
        // 指数カーブ: 50%を基準(1.0)、100%で4倍
        // 0% -> 0, 50% -> 1.0, 100% -> 4.0
        if (vol <= 0) {
            this.volumeMultiplier = 0;
        } else {
            // v = 4^(vol - 0.5) = 4^vol / 4^0.5 = 4^vol / 2
            // 50%で1.0、100%で4.0になる
            this.volumeMultiplier = Math.pow(4, vol) / 2;
        }
    }

    /**
     * 拍子を設定
     */
    setTimeSignature(beats, unit) {
        this.beatsPerMeasure = beats;
        this.beatUnit = unit;
        this.updateBeatIndicators();

        if (this.els.beatTotal) {
            this.els.beatTotal.textContent = beats;
        }

        // 現在の拍が新しい拍子を超えている場合はリセット
        if (this.currentBeat > this.beatsPerMeasure) {
            this.currentBeat = 0;
            this.updateUI();
        }
    }

    /**
     * 細分化を設定
     */
    setSubdivision(sub) {
        this.subdivision = sub;
        this.updateSubdivisionIndicator();
    }

    /**
     * 実際のBPMを計算（拍子分母を考慮）
     */
    getActualBPM() {
        return this.tempo * (this.beatUnit / 4);
    }

    /**
     * 1拍の秒数を計算
     */
    getSecondsPerBeat() {
        return 60.0 / this.getActualBPM();
    }

    /**
     * 細分化を考慮した1ノートの秒数
     */
    getSecondsPerNote() {
        return this.getSecondsPerBeat() / this.subdivision;
    }

    /**
     * 拍インジケータを更新（丸の数を拍子に合わせる）
     */
    updateBeatIndicators() {
        if (!this.els.beatIndicators) return;

        this.els.beatIndicators.innerHTML = '';

        for (let i = 1; i <= this.beatsPerMeasure; i++) {
            const dot = document.createElement('div');
            dot.className = 'beat-dot';
            dot.dataset.beat = i;

            // 1拍目（拍頭）は特別なクラスを追加
            if (i === 1) {
                dot.classList.add('downbeat');
            }

            this.els.beatIndicators.appendChild(dot);
        }
    }

    /**
     * 細分化インジケータを更新
     */
    updateSubdivisionIndicator() {
        if (!this.els.subdivisionIndicator) return;

        this.els.subdivisionIndicator.innerHTML = '';

        // 細分化が1の場合は表示しない
        if (this.subdivision <= 1) return;

        for (let i = 1; i <= this.subdivision; i++) {
            const dot = document.createElement('div');
            dot.className = 'subdivision-dot';
            dot.dataset.subdivision = i;
            this.els.subdivisionIndicator.appendChild(dot);
        }
    }

    /**
     * タップテンポを処理
     */
    handleTapTempo() {
        const now = performance.now();

        // ボタンのビジュアルフィードバック
        if (this.els.tapTempoBtn) {
            this.els.tapTempoBtn.classList.add('tapping');
            setTimeout(() => {
                this.els.tapTempoBtn.classList.remove('tapping');
            }, 200);
        }

        // 一定時間経過後のリセット
        if (this.tapTimeout) {
            clearTimeout(this.tapTimeout);
        }
        this.tapTimeout = setTimeout(() => {
            this.tapTimes = [];
        }, this.TAP_RESET_TIME);

        // 前回のタップから長時間経過している場合はリセット
        if (this.tapTimes.length > 0) {
            const lastTap = this.tapTimes[this.tapTimes.length - 1];
            if (now - lastTap > this.TAP_RESET_TIME) {
                this.tapTimes = [];
            }
        }

        this.tapTimes.push(now);

        // 最低2回のタップが必要
        if (this.tapTimes.length < 2) return;

        // 最新の4回のタップのみ使用（平均を安定させる）
        const recentTaps = this.tapTimes.slice(-4);

        // タップ間隔の平均を計算
        let totalInterval = 0;
        for (let i = 1; i < recentTaps.length; i++) {
            totalInterval += recentTaps[i] - recentTaps[i - 1];
        }
        const avgInterval = totalInterval / (recentTaps.length - 1);

        // BPMを計算（ミリ秒から変換）
        let calculatedTempo = Math.round(60000 / avgInterval);

        // 上限下限をチェック
        calculatedTempo = Math.max(this.MIN_TEMPO, Math.min(this.MAX_TEMPO, calculatedTempo));

        this.setTempo(calculatedTempo);
    }

    /**
     * AudioContextを初期化
     */
    initAudio() {
        if (this.audioContext) return;

        const AC = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AC();
    }

    /**
     * メトロノームを開始
     */
    start() {
        if (this.isPlaying || this.isCountingIn) return;

        this.initAudio();

        // AudioContextがsuspended状態なら再開
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        // 準備カウントが有効な場合
        if (this.countInEnabled) {
            this.startCountIn();
        } else {
            // 準備カウントなしで開始
            if (!this.isPaused) {
                // 新規開始
                this.nextBeatToPlay = 1;
                this.nextMeasureToPlay = 1;
                this.nextSubdivisionToPlay = 1;
                this.currentBeat = 0;
                this.currentMeasure = 1;
                this.currentSubdivision = 0;
            } else {
                // 一時停止からの再開：1拍目から、但し小節は保持
                this.nextBeatToPlay = 1;
                this.nextMeasureToPlay = this.savedMeasure;
                this.nextSubdivisionToPlay = 1;
                this.currentBeat = 0;
                this.currentMeasure = this.savedMeasure;
                this.currentSubdivision = 0;
            }
            this.isPaused = false;
            this.startMainLoop();
        }
    }

    /**
     * 準備カウントを開始
     */
    startCountIn() {
        this.isCountingIn = true;
        this.countInBeat = 1;
        this.beatQueue = [];

        // オーバーレイを表示
        if (this.els.countInOverlay) {
            this.els.countInOverlay.classList.add('active');
        }

        // 準備カウント中の表示を初期化
        if (this.els.countInNumber) {
            this.els.countInNumber.textContent = '1';
        }

        this.updateStartButton();

        // スケジューラー開始
        this.nextNoteTime = this.audioContext.currentTime;
        this.schedulerCountIn();
        this.startVisualLoopCountIn();
    }

    /**
     * 準備カウントのスケジューラー
     */
    schedulerCountIn() {
        if (!this.isCountingIn) return;

        const secondsPerBeat = this.getSecondsPerBeat();

        while (this.nextNoteTime < this.audioContext.currentTime + this.scheduleAheadTime) {
            // 準備カウントの音を鳴らす
            this.playCountInClick(this.nextNoteTime);

            // 視覚更新用のキューに追加
            this.beatQueue.push({
                time: this.nextNoteTime,
                beat: this.countInBeat,
                isCountIn: true
            });

            this.countInBeat++;
            this.nextNoteTime += secondsPerBeat;

            // 1小節分終わったらメインループへ
            if (this.countInBeat > this.beatsPerMeasure) {
                // 準備カウント終了をスケジュール
                const transitionTime = this.nextNoteTime;
                setTimeout(() => {
                    this.endCountIn();
                }, Math.max(0, (transitionTime - this.audioContext.currentTime) * 1000 - 50));
                return;
            }
        }

        this.schedulerTimer = setTimeout(() => this.schedulerCountIn(), this.lookAhead);
    }

    /**
     * 準備カウント終了、メインループ開始
     */
    endCountIn() {
        this.isCountingIn = false;
        this.beatQueue = [];

        // オーバーレイを非表示
        if (this.els.countInOverlay) {
            this.els.countInOverlay.classList.remove('active');
        }

        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }

        // メインループを開始（1拍目から、一時停止されていた場合はその小節から）
        if (this.isPaused && this.savedMeasure > 0) {
            this.nextBeatToPlay = 1;
            this.nextMeasureToPlay = this.savedMeasure;
            this.nextSubdivisionToPlay = 1;
            this.currentBeat = 0;
            this.currentMeasure = this.savedMeasure;
            this.currentSubdivision = 0;
        } else {
            this.nextBeatToPlay = 1;
            this.nextMeasureToPlay = 1;
            this.nextSubdivisionToPlay = 1;
            this.currentBeat = 0;
            this.currentMeasure = 1;
            this.currentSubdivision = 0;
        }

        this.isPaused = false;
        this.startMainLoop();
    }

    /**
     * メインループを開始
     */
    startMainLoop() {
        this.isPlaying = true;
        this.beatQueue = [];

        this.updateStartButton();

        // スケジューラー開始
        this.nextNoteTime = this.audioContext.currentTime;
        this.scheduler();
        this.startVisualLoop();
    }

    /**
     * メトロノームを停止（一時停止）
     */
    stop() {
        // 状態を保存（メインループ中のみ）
        if (this.isPlaying) {
            this.savedMeasure = this.currentMeasure;
            this.isPaused = true;
        }

        this.isPlaying = false;
        this.isCountingIn = false;

        if (this.schedulerTimer) {
            clearTimeout(this.schedulerTimer);
            this.schedulerTimer = null;
        }

        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }

        // オーバーレイを非表示
        if (this.els.countInOverlay) {
            this.els.countInOverlay.classList.remove('active');
        }

        this.beatQueue = [];
        this.updateStartButton();
    }

    /**
     * リセット（0拍目に戻る）
     */
    reset() {
        const wasPlaying = this.isPlaying || this.isCountingIn;

        if (wasPlaying) {
            this.stop();
        }

        this.currentBeat = 0;
        this.currentMeasure = 1;
        this.currentSubdivision = 0;
        this.nextBeatToPlay = 1;
        this.nextMeasureToPlay = 1;
        this.nextSubdivisionToPlay = 1;
        this.savedMeasure = 1;
        this.isPaused = false;
        this.beatQueue = [];

        // インジケータをクリア
        this.clearAllIndicators();
        this.updateUI();
    }

    /**
     * スケジューラー - 正確なタイミングで音をスケジュール
     */
    scheduler() {
        if (!this.isPlaying) return;

        const secondsPerNote = this.getSecondsPerNote();

        // 先読み時間内のノートをスケジュール
        while (this.nextNoteTime < this.audioContext.currentTime + this.scheduleAheadTime) {
            this.scheduleNote(this.nextNoteTime);
            this.nextNoteTime += secondsPerNote;
        }

        this.schedulerTimer = setTimeout(() => this.scheduler(), this.lookAhead);
    }

    /**
     * 音をスケジュール
     */
    scheduleNote(time) {
        // 現在スケジュールする拍がダウンビートかどうか
        const isDownbeat = this.nextBeatToPlay === 1 && this.nextSubdivisionToPlay === 1;
        // 拍の頭かどうか（細分化の1番目）
        const isBeatStart = this.nextSubdivisionToPlay === 1;

        // クリック音を生成
        this.playClick(time, isDownbeat, isBeatStart);

        // 視覚更新用のキューに追加
        this.beatQueue.push({
            time: time,
            beat: this.nextBeatToPlay,
            measure: this.nextMeasureToPlay,
            subdivision: this.nextSubdivisionToPlay,
            isDownbeat: isDownbeat,
            isBeatStart: isBeatStart
        });

        // 次のノートに進む
        this.nextSubdivisionToPlay++;
        if (this.nextSubdivisionToPlay > this.subdivision) {
            this.nextSubdivisionToPlay = 1;
            this.nextBeatToPlay++;
            if (this.nextBeatToPlay > this.beatsPerMeasure) {
                this.nextBeatToPlay = 1;
                this.nextMeasureToPlay++;
            }
        }
    }

    /**
     * 準備カウント用のクリック音（脳科学最適化版）
     * 準備カウントは少し控えめだが、同じ構造を使用
     */
    playCountInClick(time) {
        if (!this.audioContext) return;

        // === 音設計書に基づく準備カウント音 ===
        // 通常音より控えめな設定

        const masterGain = this.audioContext.createGain();
        masterGain.gain.value = 0.5 * this.volumeMultiplier; // 準備カウントは控えめ + ユーザー音量
        masterGain.connect(this.audioContext.destination);

        // エンベロープ設定
        const attackTime = 0.008;  // 8ms
        const decayTime = 0.015;   // 15ms
        const totalDuration = attackTime + decayTime + 0.005;

        // 1️⃣ メイン音（2500Hz - 準備カウント用に少し低め）
        const mainOsc = this.audioContext.createOscillator();
        const mainGain = this.audioContext.createGain();
        mainOsc.type = 'sine';
        mainOsc.frequency.value = 2500;

        mainGain.gain.setValueAtTime(0, time);
        mainGain.gain.linearRampToValueAtTime(0.5, time + attackTime);
        mainGain.gain.linearRampToValueAtTime(0, time + attackTime + decayTime);

        mainOsc.connect(mainGain);
        mainGain.connect(masterGain);
        mainOsc.start(time);
        mainOsc.stop(time + totalDuration);

        // 2️⃣ 補助音（900Hz - 重心）
        const subOsc = this.audioContext.createOscillator();
        const subGain = this.audioContext.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.value = 900;

        // -25dB相当（約0.056倍）
        subGain.gain.setValueAtTime(0, time);
        subGain.gain.linearRampToValueAtTime(0.04, time + attackTime);
        subGain.gain.linearRampToValueAtTime(0, time + attackTime + decayTime);

        subOsc.connect(subGain);
        subGain.connect(masterGain);
        subOsc.start(time);
        subOsc.stop(time + totalDuration);
    }

    /**
     * 脳科学的に最適化されたメトロノーム音
     * 
     * 【音設計書に基づく実装】
     * - メイン音: 3000Hz (時間認識に最も敏感な帯域)
     * - 補助音: 1000Hz (拍の重心)
     * - ノイズ: ホワイトノイズ (アタック強調)
     * - エンベロープ: 5-10ms attack, 10-20ms decay, 0 sustain, 0 release
     * - 「カチッ」で終わる非楽器音
     */
    playClick(time, isDownbeat, isBeatStart) {
        if (!this.audioContext) return;

        // === マスターゲイン ===
        const masterGain = this.audioContext.createGain();
        masterGain.gain.value = 0.7 * this.volumeMultiplier; // ユーザー音量適用（50%で1.0、100%で4.0）
        masterGain.connect(this.audioContext.destination);

        // === エンベロープ設定 ===
        // 仕様: アタック 5-10ms, ディケイ 10-20ms, サステイン 0, リリース 0
        const attackTime = 0.007;  // 7ms
        const decayTime = 0.015;   // 15ms
        const totalDuration = attackTime + decayTime + 0.005; // 余裕を持たせる

        // === 音量・周波数の調整（強拍/通常拍/細分化） ===
        let mainFreq = 3000;       // メイン音周波数
        let subFreq = 1000;        // 補助音周波数
        let mainVolume = 0.6;      // メイン音量
        let subVolume = 0.03;      // 補助音量（-25dB相当）
        let useNoise = false;       // ノイズ使用

        if (isDownbeat) {
            // 強拍（1拍目）: 周波数を+200Hz、補助音を+3dB
            mainFreq = 3200;
            subVolume = 0.05;  // +3dB相当
            useNoise = true;
        } else if (isBeatStart) {
            // 通常拍の頭
            mainFreq = 3000;
            subVolume = 0.03;
            useNoise = true;
        } else {
            // 細分化の途中：控えめ
            mainFreq = 2800;
            mainVolume = 0.35;
            subVolume = 0.015;
            useNoise = false;
        }

        // === 1️⃣ メイン音（3000Hz帯域 - 時間認識用） ===
        const mainOsc = this.audioContext.createOscillator();
        const mainGain = this.audioContext.createGain();
        mainOsc.type = 'sine';
        mainOsc.frequency.value = mainFreq;

        // 鋭いエンベロープ（カチッと終わる）
        mainGain.gain.setValueAtTime(0, time);
        mainGain.gain.linearRampToValueAtTime(mainVolume, time + attackTime);
        mainGain.gain.linearRampToValueAtTime(0, time + attackTime + decayTime);

        mainOsc.connect(mainGain);
        mainGain.connect(masterGain);
        mainOsc.start(time);
        mainOsc.stop(time + totalDuration);

        // === 2️⃣ 補助音（1000Hz帯域 - 拍の重心） ===
        const subOsc = this.audioContext.createOscillator();
        const subGain = this.audioContext.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.value = subFreq;

        subGain.gain.setValueAtTime(0, time);
        subGain.gain.linearRampToValueAtTime(subVolume, time + attackTime);
        subGain.gain.linearRampToValueAtTime(0, time + attackTime + decayTime);

        subOsc.connect(subGain);
        subGain.connect(masterGain);
        subOsc.start(time);
        subOsc.stop(time + totalDuration);

        // === 3️⃣ ノイズ成分（アタック強調 - 拍の頭のみ） ===
        if (useNoise) {
            this.playNoiseClick(time, attackTime, masterGain, isDownbeat);
        }
    }

    /**
     * ホワイトノイズによるアタック強調
     * アタック部分のみ極小音量で再生
     */
    playNoiseClick(time, attackTime, destination, isStrong) {
        // ノイズバッファ生成（短時間用）
        const bufferSize = Math.floor(this.audioContext.sampleRate * 0.02); // 20ms分
        const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);

        // ホワイトノイズ生成
        for (let i = 0; i < bufferSize; i++) {
            noiseData[i] = Math.random() * 2 - 1;
        }

        const noiseSource = this.audioContext.createBufferSource();
        noiseSource.buffer = noiseBuffer;

        const noiseGain = this.audioContext.createGain();
        const noiseVolume = isStrong ? 0.04 : 0.025; // 極小音量

        // アタック部分のみ
        noiseGain.gain.setValueAtTime(0, time);
        noiseGain.gain.linearRampToValueAtTime(noiseVolume, time + attackTime * 0.5);
        noiseGain.gain.linearRampToValueAtTime(0, time + attackTime);

        noiseSource.connect(noiseGain);
        noiseGain.connect(destination);
        noiseSource.start(time);
        noiseSource.stop(time + attackTime + 0.005);
    }

    /**
     * 準備カウント用の視覚的更新ループ
     */
    startVisualLoopCountIn() {
        const update = () => {
            if (!this.isCountingIn) return;

            const currentTime = this.audioContext.currentTime;

            // キューから現在時刻に達した拍を処理
            while (this.beatQueue.length > 0 && this.beatQueue[0].time <= currentTime) {
                const beatInfo = this.beatQueue.shift();
                if (this.els.countInNumber) {
                    this.els.countInNumber.textContent = beatInfo.beat;
                }
            }

            this.animationFrame = requestAnimationFrame(update);
        };

        update();
    }

    /**
     * 視覚的更新ループ
     */
    startVisualLoop() {
        const update = () => {
            if (!this.isPlaying) return;

            const currentTime = this.audioContext.currentTime;

            // キューから現在時刻に達した拍を処理（表示を音と同期）
            while (this.beatQueue.length > 0 && this.beatQueue[0].time <= currentTime) {
                const beatInfo = this.beatQueue.shift();
                this.currentBeat = beatInfo.beat;
                this.currentMeasure = beatInfo.measure;
                this.currentSubdivision = beatInfo.subdivision;
                this.updateUI();
            }

            this.animationFrame = requestAnimationFrame(update);
        };

        update();
    }

    /**
     * UIを更新
     */
    updateUI() {
        // 拍表示
        if (this.els.beatDisplay) {
            this.els.beatDisplay.textContent = this.currentBeat;

            // クラスをリセット
            this.els.beatDisplay.classList.remove('downbeat', 'active');

            if (this.currentBeat > 0) {
                if (this.currentBeat === 1) {
                    this.els.beatDisplay.classList.add('downbeat');
                } else {
                    this.els.beatDisplay.classList.add('active');
                }
            }
        }

        // 小節表示
        if (this.els.measureDisplay) {
            this.els.measureDisplay.textContent = this.currentMeasure;
        }

        // 拍インジケータ更新
        this.updateIndicatorHighlight();

        // 細分化インジケータ更新
        this.updateSubdivisionHighlight();
    }

    /**
     * 拍インジケータのハイライトを更新
     */
    updateIndicatorHighlight() {
        if (!this.els.beatIndicators) return;

        const dots = this.els.beatIndicators.querySelectorAll('.beat-dot');

        dots.forEach((dot, index) => {
            const beatNum = index + 1;

            if (beatNum === this.currentBeat && this.currentBeat > 0) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
    }

    /**
     * 細分化インジケータのハイライトを更新
     */
    updateSubdivisionHighlight() {
        if (!this.els.subdivisionIndicator || this.subdivision <= 1) return;

        const dots = this.els.subdivisionIndicator.querySelectorAll('.subdivision-dot');

        dots.forEach((dot, index) => {
            const subNum = index + 1;

            if (subNum === this.currentSubdivision && this.currentSubdivision > 0) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
    }

    /**
     * すべてのインジケータをクリア
     */
    clearAllIndicators() {
        if (this.els.beatIndicators) {
            const dots = this.els.beatIndicators.querySelectorAll('.beat-dot');
            dots.forEach(dot => dot.classList.remove('active'));
        }

        if (this.els.subdivisionIndicator) {
            const subDots = this.els.subdivisionIndicator.querySelectorAll('.subdivision-dot');
            subDots.forEach(dot => dot.classList.remove('active'));
        }
    }

    /**
     * スタートボタンの表示を更新
     */
    updateStartButton() {
        if (!this.els.startBtn) return;

        if (this.isPlaying || this.isCountingIn) {
            this.els.startBtn.classList.add('playing');
            if (this.els.startBtnIcon) this.els.startBtnIcon.textContent = '❚❚';
        } else {
            this.els.startBtn.classList.remove('playing');
            if (this.els.startBtnIcon) this.els.startBtnIcon.textContent = '▶';
        }
    }
}

// グローバルに公開
if (typeof window !== 'undefined') {
    window.MetronomeModule = MetronomeModule;
}
