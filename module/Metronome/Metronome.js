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
        this.scheduleAheadTime = 0.15;  // 150ms先までスケジュール（安定性向上）
        this.lookAhead = 20;           // スケジューラーの呼び出し間隔（20ms、高精度）

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

        // サウンドモード
        this.soundMode = 'default'; // 'default' | 'auto'
        this.autoFrequency = 3000;
        this.autoModeInterval = null;
        this.baseFreqs = {
            main: 3000,
            sub: 1000
        };

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
            soundModeSelect: q('#soundModeSelect'),
            soundModeDescription: q('#soundModeDescription'),
            tempoDisplayInput: q('#tempoDisplayInput'),
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

        // メイン画面のBPM直接入力
        this.els.tempoDisplayInput?.addEventListener('change', (e) => {
            this.setTempo(parseInt(e.target.value) || 120);
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

        // サウンドモード
        this.els.soundModeSelect?.addEventListener('change', (e) => {
            this.setSoundMode(e.target.value);
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

    setSoundMode(mode) {
        this.soundMode = mode;
        if (this.els.soundModeDescription) {
            if (mode === 'auto') {
                this.els.soundModeDescription.textContent = '周囲の音を分析し、最適な音程に自動調整します ※マイク必要';
            } else {
                this.els.soundModeDescription.textContent = '最適化された標準音です';
            }
        }

        // Autoモードなら即座に分析開始
        if (mode === 'auto' && this.isPlaying) {
            this.startAutoFrequencyAnalysis();
        } else {
            this.stopAutoFrequencyAnalysis();
        }
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
        this.stopAutoFrequencyAnalysis();
        // Globalのコンテキストを使用する場合はcloseしない
        if (this.audioContext && !window.audioPipeline) {
            this.audioContext.close();
        }
        this.audioContext = null;
    }

    /**
     * テンポを設定
     */
    setTempo(bpm) {
        this.tempo = Math.max(this.MIN_TEMPO, Math.min(this.MAX_TEMPO, bpm));
        if (this.els.tempoInput) this.els.tempoInput.value = this.tempo;
        if (this.els.tempoSlider) this.els.tempoSlider.value = this.tempo;
        if (this.els.tempoDisplayInput) this.els.tempoDisplayInput.value = this.tempo;
    }

    /**
     * 音量を設定（0〜1）
     * 指数カーブを適用: 50%で基準音量、100%で8倍の音量
     */
    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, vol));
        // 指数カーブ: 50%を基準(1.0)、100%で8倍
        // 0% -> 0, 50% -> 1.0, 100% -> 8.0
        if (vol <= 0) {
            this.volumeMultiplier = 0;
        } else {
            // v = 8^vol / sqrt(8) で 50%=1.0、100%=8.0になる
            this.volumeMultiplier = Math.pow(8, vol) / Math.sqrt(8);
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
     * グローバルなAudioPipelineを使用するように変更
     */
    initAudio() {
        if (this.audioContext) return;

        // Global Audio Pipelineの使用を試みる
        if (window.audioPipeline && window.audioPipeline.getAudioContext()) {
            this.audioContext = window.audioPipeline.getAudioContext();
            console.log('Metronome: Using Global Audio Context');
        } else {
            // フォールバック
            const AC = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AC();
            console.log('Metronome: Using Local Audio Context');
        }
    }

    /**
     * メトロノームを開始
     */
    start() {
        if (this.isPlaying || this.isCountingIn) return;

        this.initAudio();

        if (!this.audioContext) {
            console.error("AudioContext initialization failed");
            return;
        }

        // Resume audio context if suspended
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume().then(() => {
                console.log("AudioContext resumed");
                this._startInternal();
            });
        } else {
            this._startInternal();
        }
    }

    _startInternal() {
        // Autoモードの解析開始
        if (this.soundMode === 'auto') {
            this.startAutoFrequencyAnalysis();
        }

        if (this.countInEnabled) {
            this.startCountIn();
        } else {
            // スケジューリング開始時間を現在時刻より少し先に設定
            // これにより、最初の音が確実にスケジュールされる
            const startTime = this.audioContext.currentTime + 0.1;

            if (!this.isPaused) {
                this.nextBeatToPlay = 1;
                this.nextMeasureToPlay = 1;
                this.nextSubdivisionToPlay = 1;
                this.currentBeat = 0;
                this.currentMeasure = 1;
                this.currentSubdivision = 0;
            } else {
                this.nextBeatToPlay = 1;
                this.nextMeasureToPlay = this.savedMeasure;
                this.nextSubdivisionToPlay = 1;
                this.currentBeat = 0;
                this.currentMeasure = this.savedMeasure;
                this.currentSubdivision = 0;
            }

            this.isPaused = false;
            this.isPlaying = true;
            this.nextNoteTime = startTime;
            this.startMainLoop();
        }
    }

    /**
     * Autoモード: 周波数解析を開始
     */
    startAutoFrequencyAnalysis() {
        if (this.autoModeInterval) clearInterval(this.autoModeInterval);

        // AudioPipelineがない場合は動作しない
        if (!window.audioPipeline) return;

        this.autoModeInterval = setInterval(() => {
            this.detectOptimalFrequency();
        }, 500); // 0.5秒ごとにチェック
    }

    stopAutoFrequencyAnalysis() {
        if (this.autoModeInterval) {
            clearInterval(this.autoModeInterval);
            this.autoModeInterval = null;
        }
    }

    /**
     * 最適な周波数を検出
     */
    detectOptimalFrequency() {
        if (!window.audioPipeline) return;

        const dataArray = window.audioPipeline.getFrequencyData();
        const analyser = window.audioPipeline.getAnalyser();
        if (!dataArray || !analyser) return;

        const bufferLength = analyser.frequencyBinCount;
        const sampleRate = this.audioContext.sampleRate;

        // 1000Hz - 4000Hzの範囲でピークを探す
        // この範囲が時間認識に最も重要
        let maxVal = 0;
        let maxIndex = 0;

        // インデックス範囲計算
        const minIndex = Math.floor(1000 * bufferLength / sampleRate);
        const maxIndexLimit = Math.floor(4000 * bufferLength / sampleRate);

        for (let i = minIndex; i < maxIndexLimit; i++) {
            if (dataArray[i] > maxVal) {
                maxVal = dataArray[i];
                maxIndex = i;
            }
        }

        // ピークが一定以上の場合のみ調整（環境ノイズを無視）
        if (maxVal > 100) { // 閾値を引き上げ
            const peakFreq = maxIndex * sampleRate / bufferLength;

            // ピーク周波数から離す（±800Hz）
            // 3000Hz周辺を目指しつつ干渉を避ける
            let targetFreq = 3000;

            if (Math.abs(peakFreq - 3000) < 800) {
                // 3000Hz付近で鳴っている場合、避ける
                if (peakFreq > 3000) {
                    targetFreq = 2000;
                } else {
                    targetFreq = 4000;
                }
            } else {
                targetFreq = 3000;
            }

            // 滑らかに変化させる（急激な変化を防ぐため平滑化強化）
            this.autoFrequency = this.autoFrequency * 0.9 + targetFreq * 0.1;
        } else {
            // 静かな環境ならデフォルトに戻す
            this.autoFrequency = this.autoFrequency * 0.95 + 3000 * 0.05;
        }
    }



    stop() {
        if (this.isPlaying) {
            this.savedMeasure = this.currentMeasure;
            this.isPaused = true;
        }
        this.isPlaying = false;
        this.isCountingIn = false;
        if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
        if (this.els.countInOverlay) this.els.countInOverlay.classList.remove('active');
        this.beatQueue = [];
        this.updateStartButton();
        this.stopAutoFrequencyAnalysis();
    }

    /**
     * メトロノームをリセット
     */
    reset() {
        // 再生中の場合は停止
        this.stop();

        // 状態を初期化
        this.currentBeat = 0;
        this.currentMeasure = 1;
        this.currentSubdivision = 0;
        this.nextBeatToPlay = 1;
        this.nextMeasureToPlay = 1;
        this.nextSubdivisionToPlay = 1;
        this.savedMeasure = 1;
        this.isPaused = false;
        this.isCountingIn = false;
        this.countInBeat = 0;

        // キューをクリア
        this.beatQueue = [];

        // インジケータをクリア
        this.clearAllIndicators();

        // UI更新
        this.updateUI();
        this.updateStartButton();
    }

    scheduler() {
        if (!this.isPlaying) return;

        const secondsPerNote = this.getSecondsPerNote();
        const currentTime = this.audioContext.currentTime;

        // 先読み時間内のノートをスケジュール
        // 無限ループ防止のため、現在時刻から一定以上遅れている場合はスキップする処理を入れることを検討できるが
        // メトロノームとしては正確さが重要なので、基本は忠実にスケジュールする
        while (this.nextNoteTime < currentTime + this.scheduleAheadTime) {
            this.scheduleNote(this.nextNoteTime);
            this.nextNoteTime += secondsPerNote;
        }

        this.schedulerTimer = setTimeout(() => this.scheduler(), this.lookAhead);
    }

    startMainLoop() {
        this.scheduler();
        this.startVisualLoop();
        this.updateStartButton();
    }

    /**
     * ノートをスケジュールする（音を鳴らすキューに追加）
     */
    scheduleNote(time) {
        // 音を鳴らす
        const isDownbeat = this.nextBeatToPlay === 1 && this.nextSubdivisionToPlay === 1;
        const isBeatStart = this.nextSubdivisionToPlay === 1;

        // 視覚的な更新のためにキューに追加
        this.beatQueue.push({
            time: time,
            beat: this.nextBeatToPlay,
            measure: this.nextMeasureToPlay,
            subdivision: this.nextSubdivisionToPlay,
            isDownbeat: isDownbeat,
            isBeatStart: isBeatStart
        });

        this.playClick(time, isDownbeat, isBeatStart);

        this.nextSubdivision();
    }

    /**
     * 次の細分化単位へ進める
     */
    nextSubdivision() {
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

    // ----------------------------------------------------
    // 準備カウント（Count-In）ロジック
    // ----------------------------------------------------

    startCountIn() {
        this.isCountingIn = true;
        this.countInBeat = 1;

        if (this.els.countInOverlay) {
            this.els.countInOverlay.classList.add('active');
            if (this.els.countInNumber) this.els.countInNumber.textContent = this.beatsPerMeasure;
        }

        // スケジューリング開始
        this.nextNoteTime = this.audioContext.currentTime + 0.1;
        this.schedulerCountIn();
        this.startVisualLoopCountIn();
        this.updateStartButton();
    }

    schedulerCountIn() {
        if (!this.isCountingIn) return;

        const secondsPerBeat = this.getSecondsPerBeat();
        const currentTime = this.audioContext.currentTime;

        // 準備カウント中は拍単位（細分化なし）でスケジュール
        while (this.nextNoteTime < currentTime + this.scheduleAheadTime) {
            // 拍数を超えたらメインループへ
            if (this.countInBeat > this.beatsPerMeasure) {
                this.endCountIn();
                return;
            }

            // キューに追加（表示用）
            this.beatQueue.push({
                time: this.nextNoteTime,
                beat: this.countInBeat, // 表示する数字（残り拍数などが一般的だが、ここでは進行拍数を表示）
                isDownbeat: false
            });

            // Count-Inの音: 全て弱拍扱いまたは、最後の拍だけ変えるなど
            // ここでは全て playClick の強拍以外（通常拍）として鳴らす
            this.playClick(this.nextNoteTime, false, true);

            // カウント更新（画面表示用: 4, 3, 2, 1 とカウントダウンさせる場合はロジック反転が必要だが、
            // 一般的には 1, 2, 3, 4 と進むか、クリック音だけでガイドする。
            // ここでは countInBeat (1..4) をキューに入れる。

            this.nextNoteTime += secondsPerBeat;
            this.countInBeat++;
        }

        this.schedulerTimer = setTimeout(() => this.schedulerCountIn(), this.lookAhead);
    }

    endCountIn() {
        this.isCountingIn = false;

        // オーバーレイを消す
        if (this.els.countInOverlay) {
            this.els.countInOverlay.classList.remove('active');
        }

        // メインループ開始のための変数をセット
        // nextNoteTime は schedulerCountIn でインクリメントされた状態（次の1拍目）になっているはず
        // なので、そのまま startMainLoop のスケジューラに引き継ぐ

        if (!this.isPaused) {
            this.nextBeatToPlay = 1;
            this.nextMeasureToPlay = 1;
            this.nextSubdivisionToPlay = 1;
            this.currentBeat = 0;
            this.currentMeasure = 1;
            this.currentSubdivision = 0;
        } else {
            // 停止状態から再開する場合などはここには来ない（CountInは常に最初から想定）
            this.nextBeatToPlay = 1;
            this.nextMeasureToPlay = 1;
            this.nextSubdivisionToPlay = 1;
        }

        this.isPlaying = true;
        this.isPaused = false;

        // メインループへ
        this.startMainLoop();
    }

    /**
     * 脳科学的に最適化されたメトロノーム音
     */
    playClick(time, isDownbeat, isBeatStart) {
        if (!this.audioContext) return;

        const masterGain = this.audioContext.createGain();
        masterGain.gain.value = 1.0 * this.volumeMultiplier;
        masterGain.connect(this.audioContext.destination);

        const attackTime = 0.007;  // 7ms
        const decayTime = 0.015;   // 15ms
        const totalDuration = attackTime + decayTime + 0.005;

        // AutoモードかDefaultかで基準周波数を決定
        let baseMainFreq = 3000;
        let baseSubFreq = 1000;

        if (this.soundMode === 'auto') {
            baseMainFreq = this.autoFrequency;
            baseSubFreq = this.autoFrequency / 3; // サブはメインの1/3
        }

        let mainFreq = baseMainFreq;
        let subFreq = baseSubFreq;
        let mainVolume = 0.8;
        let subVolume = 0.05;
        let useNoise = false;

        if (isDownbeat) {
            // 強拍
            mainFreq = baseMainFreq * 1.066; // +約1半音 (200Hz @ 3000Hz)
            subVolume = 0.05;
            useNoise = true;
        } else if (isBeatStart) {
            // 通常拍
            mainFreq = baseMainFreq;
            subVolume = 0.03;
            useNoise = true;
        } else {
            // 細分化
            mainFreq = baseMainFreq * 0.933; // -約1半音
            mainVolume = 0.35;
            subVolume = 0.015;
            useNoise = false;
        }

        // 1️⃣ メイン音
        const mainOsc = this.audioContext.createOscillator();
        const mainGain = this.audioContext.createGain();
        mainOsc.type = 'sine';
        mainOsc.frequency.value = mainFreq;

        mainGain.gain.setValueAtTime(0, time);
        mainGain.gain.linearRampToValueAtTime(mainVolume, time + attackTime);
        mainGain.gain.linearRampToValueAtTime(0, time + attackTime + decayTime);

        mainOsc.connect(mainGain);
        mainGain.connect(masterGain);
        mainOsc.start(time);
        mainOsc.stop(time + totalDuration);

        // 2️⃣ 補助音
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

        // 3️⃣ ノイズ成分
        if (useNoise) {
            this.playNoiseClick(time, attackTime, masterGain, isDownbeat);
        }
    }

    // ... (playNoiseClick unchanged) ...

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
        const noiseVolume = isStrong ? 0.08 : 0.05; // アタック強調のための音量

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
