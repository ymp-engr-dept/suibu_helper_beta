/**
 * GlobalAudioManager - オーディオシステム管理
 * 個人練モード（Solo）と合奏モード（Ensemble）をサポート
 */
class GlobalAudioManager {
    constructor() {
        this.audioContext = null;
        this.analyser = null;
        this.micSource = null;
        this.playerSource = null;
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isFrozen = false;
        this.isRecording = false;
        this.isFileMode = false;
        this.isScrubbing = false;
        this.dataArray = new Uint8Array(2048);
        this.recordedMimeType = "audio/webm";

        // === 合奏モード関連 ===
        this.practiceMode = 'solo'; // 'solo' or 'ensemble'
        this.ensembleProcessor = null;
        this.ensembleWorkletNode = null;
        this.ensembleGainNode = null;
        this.isEnsembleWorkletLoaded = false;

        // フォールバック用のScriptProcessor（AudioWorklet非対応環境）
        this.ensembleScriptProcessor = null;
        this.useWorklet = true; // AudioWorkletを使用するか

        // 合奏モード用ノイズフィルタ状態
        this.ensembleState = {
            noiseFloor: 0.01,
            gateState: 0,
            noiseSpectrum: null,
            isCalibrated: false,
            calibrationFrames: 0,
            maxCalibrationFrames: 50,
        };

        this.bindDOMElements();
        this.setupEventListeners();
    }

    bindDOMElements() {
        this.els = {
            statusBadge: document.getElementById('globalStatusBadge'),
            gain: document.getElementById('globalGainInput'),
            a4: document.getElementById('globalA4Input'),
            notation: document.getElementById('globalNotationSelect'),
            freezeBtn: document.getElementById('globalFreezeBtn'),
            recordBtn: document.getElementById('globalRecordBtn'),
            fileInput: document.getElementById('globalFileInput'),
            sourceMode: document.getElementById('globalSourceModeCheckbox'),
            practiceMode: document.getElementById('globalPracticeModeCheckbox'),
            audioEngine: document.getElementById('globalAudioEngine'),
            playerInterface: document.getElementById('globalPlayerInterface'),
            playPauseBtn: document.getElementById('globalPlayPauseBtn'),
            seekBar: document.getElementById('globalAudioSeekBar'),
            timeDisplay: document.getElementById('globalCurrentTimeDisplay'),
            durationDisplay: document.getElementById('globalDurationDisplay'),
            volumeSlider: document.getElementById('globalVolumeSlider'),
            playbackRate: document.getElementById('globalPlaybackRateSelect'),
        };
    }

    setupEventListeners() {
        document.addEventListener('click', () => this.initAudio(), { once: true });
        this.els.freezeBtn?.addEventListener('click', () => {
            this.isFrozen = !this.isFrozen;
            this.els.freezeBtn.textContent = this.isFrozen ? "再開" : "フリーズ";
            this.els.freezeBtn.classList.toggle('active', this.isFrozen);
        });
        this.els.recordBtn?.addEventListener('click', () => {
            if (!this.audioContext) this.initAudio();
            if (!this.mediaRecorder) return;
            if (!this.isRecording) this.startRecording();
            else this.stopRecording();
        });
        this.els.fileInput?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.loadAudioBlob(file);
                this.els.sourceMode.checked = true;
                this.updateSourceRouting();
            }
        });
        this.els.sourceMode?.addEventListener('change', () => {
            if (!this.audioContext) this.initAudio();
            this.updateSourceRouting();
        });

        // 練習モード切り替え
        this.els.practiceMode?.addEventListener('change', () => {
            if (!this.audioContext) this.initAudio();
            this.setPracticeMode(this.els.practiceMode.checked ? 'ensemble' : 'solo');
            this.saveSettings(); // 設定を保存
        });

        // === 設定変更時の自動保存 ===
        this.els.gain?.addEventListener('change', () => this.saveSettings());
        this.els.a4?.addEventListener('change', () => this.saveSettings());
        this.els.notation?.addEventListener('change', () => this.saveSettings());
        this.els.volumeSlider?.addEventListener('change', () => this.saveSettings());
        this.els.playbackRate?.addEventListener('change', () => this.saveSettings());

        this.setupPlayerEvents();

        // 起動時に設定を復元
        this.restoreSettings();

        // プリセットシステムを初期化
        this.setupPresetSystem();
    }

    async initAudio() {
        if (this.audioContext) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AC();
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.6;

        // 合奏モード用のGainNode
        this.ensembleGainNode = this.audioContext.createGain();
        this.ensembleGainNode.gain.value = 1.0;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.micSource = this.audioContext.createMediaStreamSource(stream);
            this.micStream = stream;
            this.setupRecorder(stream);

            // AudioWorkletのロードを試みる
            await this.loadEnsembleWorklet();

            this.updateStatusBadge('mic-ready', 'Mic Ready');
        } catch (e) {
            console.error('Audio init error:', e);
            this.updateStatusBadge('error', 'Mic Error');
        }
        this.playerSource = this.audioContext.createMediaElementSource(this.els.audioEngine);
        this.updateSourceRouting();
    }

    /**
     * AudioWorkletをロード
     */
    async loadEnsembleWorklet() {
        if (this.isEnsembleWorkletLoaded) return;

        try {
            if (this.audioContext.audioWorklet) {
                await this.audioContext.audioWorklet.addModule('./ensemble-processor.js');
                this.ensembleWorkletNode = new AudioWorkletNode(
                    this.audioContext,
                    'ensemble-audio-processor'
                );

                // ワークレットからのメッセージを処理
                this.ensembleWorkletNode.port.onmessage = (event) => {
                    if (event.data.type === 'noiseCalibrated') {
                        console.log('Ensemble: ノイズキャリブレーション完了');
                        this.ensembleState.isCalibrated = true;
                    }
                };

                this.isEnsembleWorkletLoaded = true;
                this.useWorklet = true;
                console.log('AudioWorklet loaded successfully');
            } else {
                throw new Error('AudioWorklet not supported');
            }
        } catch (e) {
            console.warn('AudioWorklet not available, using ScriptProcessor fallback:', e);
            this.useWorklet = false;
            this.setupScriptProcessorFallback();
        }
    }

    /**
     * ScriptProcessorNodeフォールバック（AudioWorklet非対応環境用）
     */
    setupScriptProcessorFallback() {
        if (this.ensembleScriptProcessor) return;

        const bufferSize = 2048;
        this.ensembleScriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

        this.ensembleScriptProcessor.onaudioprocess = (event) => {
            const inputBuffer = event.inputBuffer.getChannelData(0);
            const outputBuffer = event.outputBuffer.getChannelData(0);

            if (this.practiceMode !== 'ensemble') {
                // Soloモードの場合はパススルー
                outputBuffer.set(inputBuffer);
                return;
            }

            // 適応型ノイズゲート処理
            const processedData = this.applyEnsembleProcessing(inputBuffer);
            outputBuffer.set(processedData);
        };
    }

    /**
     * 合奏モード用の音声処理（ScriptProcessor用）
     */
    applyEnsembleProcessing(inputBuffer) {
        const output = new Float32Array(inputBuffer.length);
        const state = this.ensembleState;

        // RMSを計算
        let rms = 0;
        for (let i = 0; i < inputBuffer.length; i++) {
            rms += inputBuffer[i] * inputBuffer[i];
        }
        rms = Math.sqrt(rms / inputBuffer.length);

        // ノイズフロアの推定
        const noiseGateRelease = 0.995;
        const noiseGateAttack = 0.05;
        const minThreshold = 0.005;
        const thresholdMultiplier = 2.5;

        if (rms < state.noiseFloor * 1.5 || rms < minThreshold) {
            state.noiseFloor = state.noiseFloor * noiseGateRelease + rms * (1 - noiseGateRelease);
        }

        // 動的閾値
        const threshold = Math.max(state.noiseFloor * thresholdMultiplier, minThreshold);

        // ゲート状態の更新
        const targetState = rms > threshold ? 1.0 : 0.0;
        if (targetState > state.gateState) {
            state.gateState += noiseGateAttack;
            if (state.gateState > 1) state.gateState = 1;
        } else {
            state.gateState *= noiseGateRelease;
            if (state.gateState < 0.001) state.gateState = 0;
        }

        // ゲートを適用
        for (let i = 0; i < inputBuffer.length; i++) {
            output[i] = inputBuffer[i] * state.gateState;
        }

        return output;
    }

    /**
     * 練習モードを設定
     */
    setPracticeMode(mode) {
        if (mode !== 'solo' && mode !== 'ensemble') return;

        this.practiceMode = mode;
        console.log(`Practice mode changed to: ${mode}`);

        // AudioWorkletノードに通知
        if (this.ensembleWorkletNode) {
            this.ensembleWorkletNode.port.postMessage({
                type: 'enable',
                value: mode === 'ensemble'
            });
        }

        // ノイズキャリブレーションをリセット
        if (mode === 'ensemble') {
            this.ensembleState.isCalibrated = false;
            this.ensembleState.calibrationFrames = 0;
            this.ensembleState.noiseSpectrum = null;

            if (this.ensembleWorkletNode) {
                this.ensembleWorkletNode.port.postMessage({ type: 'reset' });
            }
        }

        // ルーティングを更新
        this.updateSourceRouting();

        // ステータスバッジを更新
        if (!this.isFileMode && this.micSource) {
            if (mode === 'ensemble') {
                this.updateStatusBadge('ensemble-mode', '合奏モード');
            } else {
                this.updateStatusBadge('mic-ready', 'Mic Mode');
            }
        }
    }

    /**
     * 練習モードを取得
     */
    getPracticeMode() {
        return this.practiceMode;
    }

    /**
     * 合奏モードが有効かどうか
     */
    isEnsembleMode() {
        return this.practiceMode === 'ensemble';
    }

    updateStatusBadge(status, text) {
        const badge = this.els.statusBadge;
        if (!badge) return;

        // 新しいstatus-indicator構造に対応
        if (badge.classList.contains('status-indicator')) {
            badge.className = 'status-indicator';
            if (status) badge.classList.add(status);
            const textEl = badge.querySelector('.status-text');
            if (textEl) textEl.textContent = text;
        } else {
            // 旧構造にもフォールバック対応
            badge.className = 'status-badge';
            if (status) badge.classList.add(status);
            badge.textContent = text;
        }

        // practiceModeIndicatorも更新
        this.updatePracticeModeIndicator();
    }

    updatePracticeModeIndicator() {
        const indicator = document.getElementById('practiceModeIndicator');
        if (!indicator) return;

        const iconEl = indicator.querySelector('.mode-icon');
        const textEl = indicator.querySelector('.mode-text');

        if (this.practiceMode === 'ensemble') {
            indicator.classList.add('ensemble');
            if (iconEl) iconEl.textContent = '👥';
            if (textEl) textEl.textContent = '合奏';
        } else {
            indicator.classList.remove('ensemble');
            if (iconEl) iconEl.textContent = '👤';
            if (textEl) textEl.textContent = '個人練';
        }
    }

    setupRecorder(stream) {
        let options = {};
        if (MediaRecorder.isTypeSupported('audio/webm')) {
            options = { mimeType: 'audio/webm' };
            this.recordedMimeType = 'audio/webm';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            options = { mimeType: 'audio/mp4' };
            this.recordedMimeType = 'audio/mp4';
        }
        this.mediaRecorder = new MediaRecorder(stream, options);
        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.audioChunks.push(e.data);
        };
        this.mediaRecorder.onstop = () => {
            const blob = new Blob(this.audioChunks, { type: this.recordedMimeType });
            this.loadAudioBlob(blob);
            this.audioChunks = [];
            this.els.sourceMode.checked = true;
            this.updateSourceRouting();
        };
    }

    updateSourceRouting() {
        if (!this.audioContext || !this.analyser) return;
        this.isFileMode = this.els.sourceMode.checked;
        const { playerInterface, playPauseBtn, seekBar, volumeSlider, playbackRate } = this.els;

        if (this.isFileMode) {
            playerInterface?.classList.remove('disabled');
            [playPauseBtn, seekBar, volumeSlider, playbackRate].forEach(el => { if (el) el.disabled = false; });
            this.updateStatusBadge('file-mode', 'File Mode');
        } else {
            playerInterface?.classList.add('disabled');
            [playPauseBtn, seekBar, volumeSlider, playbackRate].forEach(el => { if (el) el.disabled = true; });
            if (this.micSource) {
                if (this.practiceMode === 'ensemble') {
                    this.updateStatusBadge('ensemble-mode', '合奏モード');
                } else {
                    this.updateStatusBadge('mic-ready', 'Mic Mode');
                }
            }
        }

        // すべての接続を切断
        try { this.micSource?.disconnect(); } catch (e) { }
        try { this.playerSource?.disconnect(); } catch (e) { }
        try { this.ensembleWorkletNode?.disconnect(); } catch (e) { }
        try { this.ensembleScriptProcessor?.disconnect(); } catch (e) { }
        try { this.ensembleGainNode?.disconnect(); } catch (e) { }
        try { this.analyser?.disconnect(); } catch (e) { }

        if (this.isFileMode) {
            // ファイルモード
            try {
                this.playerSource?.connect(this.analyser);
                this.analyser.connect(this.audioContext.destination);
            } catch (e) { }
        } else {
            // マイクモード
            if (this.practiceMode === 'ensemble' && this.micSource) {
                // 合奏モード: マイク → 合奏プロセッサー → Analyser
                try {
                    if (this.useWorklet && this.ensembleWorkletNode) {
                        this.micSource.connect(this.ensembleWorkletNode);
                        this.ensembleWorkletNode.connect(this.analyser);
                    } else if (this.ensembleScriptProcessor) {
                        this.micSource.connect(this.ensembleScriptProcessor);
                        this.ensembleScriptProcessor.connect(this.analyser);
                    } else {
                        // フォールバック: 直接接続
                        this.micSource.connect(this.analyser);
                    }
                } catch (e) {
                    console.error('Ensemble routing error:', e);
                    this.micSource?.connect(this.analyser);
                }
            } else {
                // 個人練モード: マイク → Analyser
                try {
                    this.micSource?.connect(this.analyser);
                } catch (e) { }
            }
        }
    }

    setupPlayerEvents() {
        const { audioEngine, playPauseBtn, seekBar, timeDisplay, durationDisplay, volumeSlider, playbackRate } = this.els;
        if (!audioEngine) return;
        audioEngine.addEventListener('play', () => {
            if (this.audioContext?.state === 'suspended') this.audioContext.resume();
            if (playPauseBtn) playPauseBtn.textContent = "❚❚";
        });
        audioEngine.addEventListener('pause', () => { if (playPauseBtn) playPauseBtn.textContent = "▶"; });
        audioEngine.addEventListener('ended', () => { if (playPauseBtn) playPauseBtn.textContent = "▶"; });
        audioEngine.addEventListener('loadedmetadata', () => {
            if (seekBar) seekBar.max = audioEngine.duration;
            if (durationDisplay) durationDisplay.textContent = this.formatTime(audioEngine.duration);
        });
        audioEngine.addEventListener('timeupdate', () => {
            if (!this.isScrubbing && seekBar && timeDisplay) {
                seekBar.value = audioEngine.currentTime;
                timeDisplay.textContent = this.formatTime(audioEngine.currentTime);
            }
        });
        playPauseBtn?.addEventListener('click', () => { audioEngine.paused ? audioEngine.play() : audioEngine.pause(); });
        volumeSlider?.addEventListener('input', (e) => audioEngine.volume = parseFloat(e.target.value));
        playbackRate?.addEventListener('change', (e) => audioEngine.playbackRate = parseFloat(e.target.value));
        const startScrub = () => { this.isScrubbing = true; };
        const endScrub = () => { this.isScrubbing = false; };
        const performScrub = () => {
            if (!this.audioContext) this.initAudio();
            audioEngine.currentTime = parseFloat(seekBar.value);
            if (timeDisplay) timeDisplay.textContent = this.formatTime(audioEngine.currentTime);
        };
        seekBar?.addEventListener('mousedown', startScrub);
        seekBar?.addEventListener('touchstart', startScrub, { passive: true });
        seekBar?.addEventListener('input', performScrub);
        seekBar?.addEventListener('mouseup', endScrub);
        seekBar?.addEventListener('touchend', endScrub);
    }

    startRecording() {
        this.audioChunks = [];
        this.mediaRecorder.start();
        this.isRecording = true;
        this.els.recordBtn.textContent = "■ 停止";
        this.els.recordBtn.classList.add("recording");
        this.els.audioEngine?.pause();
    }

    stopRecording() {
        this.mediaRecorder.stop();
        this.isRecording = false;
        this.els.recordBtn.textContent = "● 録音";
        this.els.recordBtn.classList.remove("recording");
    }

    loadAudioBlob(blob) {
        if (this.els.audioEngine) this.els.audioEngine.src = URL.createObjectURL(blob);
    }

    formatTime(s) {
        if (!s) return "0:00";
        return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
    }

    getAnalyser() { return this.analyser; }
    getAudioContext() { return this.audioContext; }
    getDataArray() {
        if (!this.isFrozen && this.analyser) this.analyser.getByteFrequencyData(this.dataArray);
        return this.dataArray;
    }
    getGain() { return Number(this.els.gain?.value) || 1; }
    getA4() { return Number(this.els.a4?.value) || 442; }
    getNotation() { return this.els.notation?.value || 'C'; }
    isFreezeActive() { return this.isFrozen; }
    getMicStream() { return this.micStream; }

    // ========================================
    // 設定の保存・復元
    // ========================================

    /**
     * 共通設定を保存
     */
    saveSettings() {
        const settings = {
            version: 1,
            gain: this.els.gain?.value || '1',
            a4: this.els.a4?.value || '442',
            notation: this.els.notation?.value || 'C',
            practiceMode: this.practiceMode || 'solo',
            volume: this.els.volumeSlider?.value || '0.8',
            playbackRate: this.els.playbackRate?.value || '1'
        };
        localStorage.setItem('suiren-settings-v1', JSON.stringify(settings));
        console.log('💾 Settings saved:', settings);
    }

    /**
     * 共通設定を復元
     */
    restoreSettings() {
        const saved = localStorage.getItem('suiren-settings-v1');
        if (!saved) return;

        try {
            const settings = JSON.parse(saved);
            console.log('📂 Restoring settings:', settings);

            // 各設定を復元
            if (settings.gain && this.els.gain) {
                this.els.gain.value = settings.gain;
            }
            if (settings.a4 && this.els.a4) {
                this.els.a4.value = settings.a4;
            }
            if (settings.notation && this.els.notation) {
                this.els.notation.value = settings.notation;
            }
            if (settings.volume && this.els.volumeSlider) {
                this.els.volumeSlider.value = settings.volume;
                if (this.els.audioEngine) {
                    this.els.audioEngine.volume = parseFloat(settings.volume);
                }
            }
            if (settings.playbackRate && this.els.playbackRate) {
                this.els.playbackRate.value = settings.playbackRate;
                if (this.els.audioEngine) {
                    this.els.audioEngine.playbackRate = parseFloat(settings.playbackRate);
                }
            }
            if (settings.practiceMode && this.els.practiceMode) {
                this.els.practiceMode.checked = settings.practiceMode === 'ensemble';
                this.practiceMode = settings.practiceMode;
            }
        } catch (e) {
            console.error('Settings restore failed:', e);
        }
    }

    // ========================================
    // プリセット管理
    // ========================================

    /**
     * プリセットUI要素をバインド
     */
    bindPresetElements() {
        this.presetEls = {
            nameInput: document.getElementById('presetNameInput'),
            saveBtn: document.getElementById('presetSaveBtn'),
            listBtn: document.getElementById('presetListBtn'),
            list: document.getElementById('presetList')
        };
    }

    /**
     * プリセット機能をセットアップ
     */
    setupPresetSystem() {
        this.bindPresetElements();

        // 保存ボタン
        this.presetEls.saveBtn?.addEventListener('click', () => {
            const name = this.presetEls.nameInput?.value.trim();
            if (!name) {
                alert('プリセット名を入力してください');
                return;
            }
            this.savePreset(name);
            this.presetEls.nameInput.value = '';
        });

        // リストボタン（トグル）- 位置を計算して表示
        this.presetEls.listBtn?.addEventListener('click', (e) => {
            e.stopPropagation();

            const list = this.presetEls.list;
            const btn = this.presetEls.listBtn;

            if (!list || !btn) return;

            const isOpen = list.classList.contains('open');

            if (!isOpen) {
                // ボタンの位置を取得して、リストの表示位置を計算
                const btnRect = btn.getBoundingClientRect();
                const listWidth = 220; // min-width

                // 右端がはみ出さないように調整
                let left = btnRect.right - listWidth;
                if (left < 10) left = 10;

                // 下端がはみ出さないように調整
                let top = btnRect.bottom + 4;
                const maxHeight = 300;
                if (top + maxHeight > window.innerHeight - 10) {
                    // 上に表示
                    top = Math.max(10, btnRect.top - maxHeight - 4);
                }

                list.style.left = left + 'px';
                list.style.top = top + 'px';
                list.classList.add('open');
                this.renderPresetList();
            } else {
                list.classList.remove('open');
            }
        });

        // リスト外クリックで閉じる
        document.addEventListener('click', (e) => {
            if (!this.presetEls.list?.contains(e.target) &&
                !this.presetEls.listBtn?.contains(e.target)) {
                this.presetEls.list?.classList.remove('open');
            }
        });

        // 初回リスト描画
        this.renderPresetList();
    }

    /**
     * プリセット一覧を取得
     */
    getPresets() {
        const saved = localStorage.getItem('suiren-presets');
        return saved ? JSON.parse(saved) : {};
    }

    /**
     * プリセット一覧を保存
     */
    savePresetsRegistry(presets) {
        localStorage.setItem('suiren-presets', JSON.stringify(presets));
    }

    /**
     * プリセットを保存
     */
    savePreset(name) {
        const presets = this.getPresets();

        // 現在の設定を取得
        const settings = {
            gain: this.els.gain?.value || '1',
            a4: this.els.a4?.value || '442',
            notation: this.els.notation?.value || 'C',
            practiceMode: this.practiceMode || 'solo',
            volume: this.els.volumeSlider?.value || '0.8',
            playbackRate: this.els.playbackRate?.value || '1'
        };

        // 現在のレイアウトを取得
        const layout = localStorage.getItem('suiren-layout-v12');

        presets[name] = {
            settings,
            layout: layout ? JSON.parse(layout) : null,
            savedAt: new Date().toISOString()
        };

        this.savePresetsRegistry(presets);
        this.renderPresetList();
        console.log('✅ Preset saved:', name);
    }

    /**
     * プリセットをロード
     */
    async loadPreset(name) {
        const presets = this.getPresets();
        const preset = presets[name];
        if (!preset) return;

        console.log('📂 Loading preset:', name, preset);

        // 設定を復元
        if (preset.settings) {
            if (preset.settings.gain && this.els.gain) {
                this.els.gain.value = preset.settings.gain;
            }
            if (preset.settings.a4 && this.els.a4) {
                this.els.a4.value = preset.settings.a4;
            }
            if (preset.settings.notation && this.els.notation) {
                this.els.notation.value = preset.settings.notation;
            }
            if (preset.settings.volume && this.els.volumeSlider) {
                this.els.volumeSlider.value = preset.settings.volume;
                if (this.els.audioEngine) {
                    this.els.audioEngine.volume = parseFloat(preset.settings.volume);
                }
            }
            if (preset.settings.playbackRate && this.els.playbackRate) {
                this.els.playbackRate.value = preset.settings.playbackRate;
                if (this.els.audioEngine) {
                    this.els.audioEngine.playbackRate = parseFloat(preset.settings.playbackRate);
                }
            }
            if (preset.settings.practiceMode && this.els.practiceMode) {
                this.els.practiceMode.checked = preset.settings.practiceMode === 'ensemble';
                this.practiceMode = preset.settings.practiceMode;
            }
        }

        // レイアウトを復元
        if (preset.layout) {
            localStorage.setItem('suiren-layout-v12', JSON.stringify(preset.layout));
            // レイアウトマネージャーに復元を依頼
            if (window.layoutManager) {
                await window.layoutManager.restoreLayout();
            }
        }

        this.presetEls.list?.classList.remove('open');
    }

    /**
     * プリセットを削除
     */
    deletePreset(name) {
        if (!confirm(`プリセット「${name}」を削除しますか？`)) return;

        const presets = this.getPresets();
        delete presets[name];
        this.savePresetsRegistry(presets);
        this.renderPresetList();
        console.log('🗑 Preset deleted:', name);
    }

    /**
     * プリセットリストを描画
     */
    renderPresetList() {
        if (!this.presetEls?.list) return;

        const presets = this.getPresets();
        const names = Object.keys(presets);

        if (names.length === 0) {
            this.presetEls.list.innerHTML = '<div class="preset-empty">プリセットなし</div>';
            return;
        }

        this.presetEls.list.innerHTML = names.map(name => `
            <div class="preset-item" data-name="${name}">
                <span class="preset-item-name">${name}</span>
                <button class="preset-item-delete" title="削除">🗑</button>
            </div>
        `).join('');

        // イベントリスナー設定
        this.presetEls.list.querySelectorAll('.preset-item-name').forEach(el => {
            el.addEventListener('click', () => {
                const name = el.parentElement.dataset.name;
                this.loadPreset(name);
            });
        });

        this.presetEls.list.querySelectorAll('.preset-item-delete').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const name = el.parentElement.dataset.name;
                this.deletePreset(name);
            });
        });
    }
}

/**
 * TreeLayoutManager - ツリーベースの上下左右分割レイアウト管理
 * タッチ操作対応版
 */
class TreeLayoutManager {
    constructor(app) {
        this.app = app;
        this.panelIdCounter = 0;
        this.panels = new Map();
        this.moduleInWorkspace = new Set();
        this.moduleRegistry = []; // modules.jsonから読み込んだモジュール情報

        // === 最小サイズ制約 ===
        this.MIN_PANEL_WIDTH = 150;
        this.MIN_PANEL_HEIGHT = 120;

        this.drawer = document.getElementById('moduleDrawer');
        this.menuToggle = document.getElementById('menuToggle');
        this.moduleList = document.getElementById('moduleList');
        this.workspace = document.getElementById('workspace');
        this.layoutRoot = document.getElementById('layoutRoot');
        this.workspaceEmpty = document.getElementById('workspaceEmpty');
        this.dropZones = document.getElementById('dropZones');
        this.panelTemplate = document.getElementById('modulePanelTemplate');

        this.draggedData = null;
        this.activeSplitter = null;
        this.activeMenu = null;
        this.isLiftDragging = false;
        this.currentHoverZone = null;
        this.currentHoverPanelZone = null;

        // === タッチドラッグ状態 ===
        this.touchDragState = null;
        this.isTouchDragging = false;

        this.init();
    }

    async init() {
        // ドロワー開閉ボタン（グローバルオーディオパネル内）
        this.drawerOpenBtn = document.getElementById('drawerOpenBtn');
        this.drawerOpenBtn?.addEventListener('click', () => {
            this.toggleDrawer();
        });

        // modules.jsonを読み込んでモジュールカードを動的生成
        await this.loadModuleRegistry();


        // ワークスペースのドロップイベント
        this.setupWorkspaceDropEvents();

        // グローバルマウスイベント
        document.addEventListener('mousemove', (e) => {
            this.onSplitterDrag(e);
            if (this.isLiftDragging) this.onLiftDrag(e);
        });
        document.addEventListener('mouseup', (e) => {
            this.onSplitterDragEnd();
            if (this.isLiftDragging) this.onLiftDrop(e);
        });

        // === グローバルタッチイベント ===
        document.addEventListener('touchmove', (e) => {
            if (this.activeSplitter) {
                e.preventDefault();
                const touch = e.touches[0];
                this.onSplitterDrag({ clientX: touch.clientX, clientY: touch.clientY });
            }
            if (this.isLiftDragging || this.isTouchDragging) {
                e.preventDefault();
                const touch = e.touches[0];
                this.onLiftDrag({ clientX: touch.clientX, clientY: touch.clientY });
            }
        }, { passive: false });

        document.addEventListener('touchend', (e) => {
            if (this.activeSplitter) {
                this.onSplitterDragEnd();
            }
            if (this.isLiftDragging || this.isTouchDragging) {
                const touch = e.changedTouches[0];
                this.onLiftDrop({ clientX: touch.clientX, clientY: touch.clientY });
                this.isTouchDragging = false;
            }
            if (this.touchDragState) {
                this.onTouchDragEnd(e);
            }
        });

        document.addEventListener('touchcancel', () => {
            this.activeSplitter = null;
            this.isLiftDragging = false;
            this.isTouchDragging = false;
            this.touchDragState = null;
            this.onDragEnd();
            document.body.style.cursor = '';
        });

        // メニュー閉じる
        document.addEventListener('click', (e) => {
            if (this.activeMenu && !e.target.closest('.panel-menu') && !e.target.closest('.panel-menu-btn')) {
                this.activeMenu.classList.remove('open');
                this.activeMenu = null;
            }
        });

        this.restoreLayout();

        // === リサイズ時のレイアウト自動調整 ===
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.normalizeLayout();
            }, 150);
        });
    }

    /**
     * レイアウトを正規化（ワークスペースサイズに合わせて調整）
     */
    normalizeLayout() {
        const root = this.layoutRoot.firstElementChild;
        if (!root) return;

        const workspaceRect = this.workspace.getBoundingClientRect();
        console.log('🔧 Normalizing layout to:', workspaceRect.width, 'x', workspaceRect.height);

        this.normalizeSplitContainer(root, workspaceRect.width, workspaceRect.height);
        this.saveLayout();
    }

    /**
     * split-containerを正規化
     */
    normalizeSplitContainer(element, availableWidth, availableHeight) {
        if (!element) return;

        if (element.classList.contains('module-panel')) {
            // 単一パネルの場合、サイズを100%に
            element.style.width = '';
            element.style.height = '';
            element.style.flex = '1';
            return;
        }

        if (!element.classList.contains('split-container')) return;

        const direction = element.classList.contains('vertical') ? 'vertical' : 'horizontal';
        const children = Array.from(element.children).filter(c => !c.classList.contains('splitter'));
        const splitterCount = children.length - 1;
        const splitterSize = 4; // CSSの--splitter-size

        if (children.length === 0) return;

        // 利用可能なサイズを計算
        const totalSplitterSize = splitterCount * splitterSize;
        const availableSize = direction === 'horizontal'
            ? availableWidth - totalSplitterSize
            : availableHeight - totalSplitterSize;

        // 現在の子要素のサイズを取得
        const childSizes = children.map(child => {
            const rect = child.getBoundingClientRect();
            return direction === 'horizontal' ? rect.width : rect.height;
        });

        const totalCurrentSize = childSizes.reduce((sum, s) => sum + s, 0);

        // 比率を計算して新しいサイズを適用
        const minSize = direction === 'horizontal' ? this.MIN_PANEL_WIDTH : this.MIN_PANEL_HEIGHT;

        children.forEach((child, i) => {
            // 比率を維持しながらサイズを調整
            let ratio = totalCurrentSize > 0 ? childSizes[i] / totalCurrentSize : 1 / children.length;
            let newSize = Math.max(minSize, Math.round(availableSize * ratio));

            // 最後の要素は残りのスペースを使用
            if (i === children.length - 1) {
                const usedSize = children.slice(0, -1).reduce((sum, c) => {
                    const rect = c.getBoundingClientRect();
                    return sum + (direction === 'horizontal' ? rect.width : rect.height);
                }, 0);
                newSize = Math.max(minSize, availableSize - usedSize);
            }

            if (direction === 'horizontal') {
                child.style.width = newSize + 'px';
                child.style.height = '';
                child.style.flex = 'none';
            } else {
                child.style.height = newSize + 'px';
                child.style.width = '';
                child.style.flex = 'none';
            }

            // 再帰的に子要素を正規化
            const childRect = child.getBoundingClientRect();
            if (child.classList.contains('split-container')) {
                this.normalizeSplitContainer(child, childRect.width, childRect.height);
            } else if (child.classList.contains('module-panel')) {
                // パネルの中にネストされたコンテナがある場合
                const nestedContainer = child.querySelector('.split-container');
                if (nestedContainer) {
                    this.normalizeSplitContainer(nestedContainer, childRect.width, childRect.height);
                }
            }
        });
    }

    async loadModuleRegistry() {
        try {
            const response = await fetch('./module/modules.json');
            this.moduleRegistry = await response.json();
            this.renderModuleCards();
        } catch (e) {
            console.error('Failed to load modules.json:', e);
        }
    }

    renderModuleCards() {
        this.moduleList.innerHTML = '';

        this.moduleRegistry.forEach(mod => {
            const card = document.createElement('div');
            card.className = 'module-card';
            card.draggable = true;
            card.dataset.module = mod.id;
            card.dataset.class = mod.class;
            card.dataset.container = mod.container;
            card.dataset.title = mod.title;

            card.innerHTML = `
        <span class="module-icon">${mod.icon}</span>
        <span class="module-name">${mod.title}</span>
      `;

            // ドラッグイベント設定（マウス）
            card.addEventListener('dragstart', (e) => this.onCardDragStart(e, card));
            card.addEventListener('dragend', () => this.onDragEnd());

            // タッチイベント設定
            card.addEventListener('touchstart', (e) => this.onCardTouchStart(e, card), { passive: false });

            this.moduleList.appendChild(card);
        });
    }

    /**
     * モジュールカードのタッチ開始
     */
    onCardTouchStart(e, card) {
        e.preventDefault();
        const touch = e.touches[0];

        this.touchDragState = {
            card,
            startX: touch.clientX,
            startY: touch.clientY,
            moved: false
        };

        // 長押しでドラッグ開始（200ms後）
        this.touchDragState.timer = setTimeout(() => {
            if (this.touchDragState && this.touchDragState.card === card) {
                this.startTouchDrag(card, touch.clientX, touch.clientY);
            }
        }, 200);

        // タッチ移動を監視
        const onTouchMove = (e) => {
            if (!this.touchDragState) return;
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - this.touchDragState.startX);
            const dy = Math.abs(touch.clientY - this.touchDragState.startY);

            if (dx > 10 || dy > 10) {
                this.touchDragState.moved = true;
                clearTimeout(this.touchDragState.timer);
                this.startTouchDrag(card, touch.clientX, touch.clientY);
                document.removeEventListener('touchmove', onTouchMove);
            }
        };

        document.addEventListener('touchmove', onTouchMove, { passive: false });

        // タッチ終了時にクリーンアップ
        const onTouchEnd = () => {
            clearTimeout(this.touchDragState?.timer);
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
        };
        document.addEventListener('touchend', onTouchEnd, { once: true });
    }

    /**
     * タッチドラッグを開始
     */
    startTouchDrag(card, x, y) {
        this.draggedData = {
            type: 'new',
            module: card.dataset.module,
            class: card.dataset.class,
            container: card.dataset.container,
            title: card.dataset.title
        };

        card.classList.add('dragging');
        this.isTouchDragging = true;

        // ドロワーを非表示（ドラッグ中）
        this.drawer?.classList.add('hide-on-drag');

        this.dropZones.classList.add('active');

        // ワークスペースにパネルがある場合はセンターゾーンを非表示
        const centerZone = this.dropZones.querySelector('.zone-center');
        if (centerZone) {
            centerZone.style.display = this.panels.size > 0 ? 'none' : '';
        }

        this.highlightPanelDropZones(true);
        this.setupSplitterDropTargets(true);
        this.updateDropZoneHighlight(x, y);
    }

    /**
     * タッチドラッグ終了
     */
    onTouchDragEnd(e) {
        if (!this.touchDragState) return;

        clearTimeout(this.touchDragState.timer);
        this.touchDragState = null;
    }

    /**
     * ドロワーの開閉を切り替え
     */
    toggleDrawer() {
        const isOpen = this.drawer.classList.contains('expanded');

        if (isOpen) {
            // 閉じる
            this.drawer.classList.remove('expanded');
            this.drawerOpenBtn?.classList.remove('open');
        } else {
            // 開く
            this.drawer.classList.add('expanded');
            this.drawerOpenBtn?.classList.add('open');
        }
    }

    /**
     * ドロワーを閉じる
     */
    closeDrawer() {
        this.drawer.classList.remove('expanded');
        this.drawerOpenBtn?.classList.remove('open');
    }

    updateDrawerVisibility() {
        const cards = this.moduleList.querySelectorAll('.module-card');
        cards.forEach(card => {
            const moduleName = card.dataset.module;
            card.style.display = this.moduleInWorkspace.has(moduleName) ? 'none' : 'flex';
        });
    }

    setupWorkspaceDropEvents() {
        this.dropZones.querySelectorAll('.drop-zone').forEach(zone => {
            zone.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                zone.classList.add('highlight');
            });
            zone.addEventListener('dragleave', (e) => {
                e.stopPropagation();
                zone.classList.remove('highlight');
            });
            zone.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleDrop(null, zone.dataset.zone);
            });
        });

        this.workspace.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZones.classList.add('active');
        });

        this.workspace.addEventListener('dragleave', (e) => {
            if (!this.workspace.contains(e.relatedTarget)) {
                this.dropZones.classList.remove('active');
            }
        });
    }

    onCardDragStart(e, card) {
        this.draggedData = {
            type: 'new',
            module: card.dataset.module,
            class: card.dataset.class,
            container: card.dataset.container,
            title: card.dataset.title
        };

        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.dataset.module);

        // ドロワーを非表示（ドラッグ中）
        this.drawer?.classList.add('hide-on-drag');

        // ドロップゾーンを表示
        this.dropZones.classList.add('active');

        // ワークスペースにパネルがある場合はセンターゾーンを非表示
        const centerZone = this.dropZones.querySelector('.zone-center');
        if (centerZone) {
            centerZone.style.display = this.panels.size > 0 ? 'none' : '';
        }

        this.highlightPanelDropZones(true);
        this.setupSplitterDropTargets(true);
    }

    onDragEnd() {
        document.querySelectorAll('.module-card, .module-panel').forEach(c => c.classList.remove('dragging'));
        document.querySelectorAll('.drop-zone, .panel-drop-zone').forEach(z => z.classList.remove('highlight'));
        document.querySelectorAll('.splitter').forEach(s => s.classList.remove('drop-target'));
        this.dropZones.classList.remove('active');
        this.highlightPanelDropZones(false);
        this.setupSplitterDropTargets(false);

        // センターゾーンを再表示
        const centerZone = this.dropZones.querySelector('.zone-center');
        if (centerZone) centerZone.style.display = '';

        // ドロワーを再表示
        this.drawer?.classList.remove('hide-on-drag');

        this.draggedData = null;
    }

    highlightPanelDropZones(show) {
        this.panels.forEach(p => {
            if (show) p.element.classList.add('drag-over');
            else p.element.classList.remove('drag-over');
        });
    }

    handleDrop(targetPanelId, position) {
        const data = this.draggedData;
        this.onDragEnd();

        if (!data) return;
        this.addPanel(data, targetPanelId, position);
    }

    onLiftDrag(e) {
        this.updateDropZoneHighlight(e.clientX, e.clientY);
    }

    updateDropZoneHighlight(x, y) {
        // 既存のハイライトをすべてクリア
        document.querySelectorAll('.drop-zone, .panel-drop-zone').forEach(z => z.classList.remove('highlight'));
        document.querySelectorAll('.splitter').forEach(s => s.classList.remove('drop-target'));
        this.currentHoverZone = null;
        this.currentHoverPanelZone = null;
        this.currentHoverSplitter = null;

        // 1. スプリッターをチェック（最優先）
        const splitters = this.layoutRoot.querySelectorAll('.splitter');
        for (const splitter of splitters) {
            const rect = splitter.getBoundingClientRect();
            // スプリッターの検出範囲を広げる（周囲20px）
            const padding = 20;
            if (x >= rect.left - padding && x <= rect.right + padding &&
                y >= rect.top - padding && y <= rect.bottom + padding) {
                splitter.classList.add('drop-target');
                this.currentHoverSplitter = { element: splitter };
                return;
            }
        }

        // 2. ワークスペースのエッジゾーンをチェック
        const workspaceZones = this.dropZones.querySelectorAll('.drop-zone');
        for (const zone of workspaceZones) {
            if (zone.style.display === 'none') continue;
            const rect = zone.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                zone.classList.add('highlight');
                this.currentHoverZone = { type: 'workspace', zone: zone.dataset.zone };
                return;
            }
        }

        // 3. パネルのドロップゾーンをチェック（移動時は自分自身を除外）
        for (const [panelId, panelData] of this.panels) {
            // 自分自身（ドラッグ中のパネル）は除外
            if (this.draggedData?.sourcePanelId === panelId) continue;

            const panelZones = panelData.element.querySelectorAll('.panel-drop-zone');
            for (const zone of panelZones) {
                const rect = zone.getBoundingClientRect();
                if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                    zone.classList.add('highlight');
                    this.currentHoverPanelZone = { panelId, zone: zone.dataset.zone };
                    return;
                }
            }
        }
    }

    onLiftDrop(e) {
        const data = this.draggedData;

        this.isLiftDragging = false;
        document.body.style.cursor = '';

        // すべてのハイライトをクリア
        document.querySelectorAll('.drop-zone, .panel-drop-zone').forEach(z => z.classList.remove('highlight'));
        document.querySelectorAll('.splitter').forEach(s => s.classList.remove('drop-target'));
        this.dropZones.classList.remove('active');
        this.highlightPanelDropZones(false);
        this.setupSplitterDropTargets(false);

        // center zoneを再表示
        const centerZone = this.dropZones.querySelector('.zone-center');
        if (centerZone) centerZone.style.display = '';

        // ドロワーを再表示
        this.drawer?.classList.remove('hide-on-drag');

        // ドラッグ中のパネルのスタイルを確実に戻す
        if (data?.sourcePanelId) {
            const sourcePanel = this.panels.get(data.sourcePanelId);
            if (sourcePanel) {
                sourcePanel.element.classList.remove('dragging');
            }
        }

        if (!data) {
            this.draggedData = null;
            this.currentHoverZone = null;
            this.currentHoverPanelZone = null;
            this.currentHoverSplitter = null;
            return;
        }

        let targetPanelId = null;
        let position = 'center';
        let splitterTarget = null;

        if (this.currentHoverSplitter) {
            // スプリッターへのドロップ
            splitterTarget = this.currentHoverSplitter.element;
        } else if (this.currentHoverPanelZone) {
            targetPanelId = this.currentHoverPanelZone.panelId;
            position = this.currentHoverPanelZone.zone;
        } else if (this.currentHoverZone) {
            position = this.currentHoverZone.zone;
        } else {
            // ドロップ先がない場合は移動をキャンセル（元の位置に戻す）
            this.draggedData = null;
            this.currentHoverZone = null;
            this.currentHoverPanelZone = null;
            this.currentHoverSplitter = null;
            this.saveLayout();
            return;
        }

        // 移動の場合は元のパネルを削除して新しい位置に追加
        if (data.type === 'move' && data.sourcePanelId) {
            this.removePanelFromLayout(data.sourcePanelId, true);
        }

        this.draggedData = null;
        this.currentHoverZone = null;
        this.currentHoverPanelZone = null;
        this.currentHoverSplitter = null;

        if (splitterTarget) {
            // スプリッターへのドロップ処理
            this.addPanelAtSplitter(data, splitterTarget);
        } else {
            this.addPanel(data, targetPanelId, position);
        }
    }

    /**
     * スプリッターの位置にパネルを追加
     */
    async addPanelAtSplitter(moduleInfo, splitter) {
        const panelId = `panel-${++this.panelIdCounter}`;

        const template = this.panelTemplate.content.cloneNode(true);
        const panel = template.querySelector('.module-panel');
        panel.id = panelId;
        panel.dataset.module = moduleInfo.module;

        const panelTitle = panel.querySelector('.panel-title');
        panelTitle.textContent = moduleInfo.title;

        const panelContent = panel.querySelector('.panel-content');
        const menuBtn = panel.querySelector('.panel-menu-btn');
        const panelMenu = panel.querySelector('.panel-menu');
        const deleteBtn = panel.querySelector('.delete-item');
        const dragHandle = panel.querySelector('.panel-drag-handle');

        // ドラッグハンドルのイベント設定
        this.setupDragHandle(dragHandle, panelId, moduleInfo);

        // パネルドロップゾーンの設定
        this.setupPanelDropZones(panel, panelId);

        // メニューボタンの設定
        this.setupMenuButton(menuBtn, panelMenu, panelId, moduleInfo);

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panelMenu.classList.remove('open');
            this.activeMenu = null;
            this.returnToDrawer(panelId);
        });

        // スプリッターの隣に挿入
        const direction = splitter.classList.contains('horizontal') ? 'horizontal' : 'vertical';
        const parent = splitter.parentElement;
        const newSplitter = this.createSplitter(direction);

        // スプリッターの後ろに新しいパネルを挿入
        splitter.after(newSplitter);
        newSplitter.after(panel);

        this.workspaceEmpty.classList.add('hidden');
        this.moduleInWorkspace.add(moduleInfo.module);
        this.updateDrawerVisibility();

        const instance = await this.app.loadModuleIntoPanel(
            moduleInfo.module,
            moduleInfo.class,
            moduleInfo.container,
            panelContent
        );

        this.panels.set(panelId, {
            element: panel,
            moduleInfo,
            instance
        });

        this.saveLayout();
    }

    /**
     * ドラッグハンドルのイベント設定
     */
    setupDragHandle(dragHandle, panelId, moduleInfo) {
        if (!dragHandle) return;

        let isDragging = false;
        let startX, startY;
        let longPressTimer = null;
        const DRAG_THRESHOLD = 3; // より小さいしきい値で反応しやすく
        const LONG_PRESS_DELAY = 200; // 長押し検出時間（ms）

        const startDrag = () => {
            if (isDragging) return;
            isDragging = true;
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            this.startLiftDrag(panelId, moduleInfo);
        };

        const onMouseMove = (e) => {
            if (isDragging) return;

            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);

            if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
                startDrag();
            }
        };

        const onMouseUp = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        // マウスイベント
        dragHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDragging = false;
            startX = e.clientX;
            startY = e.clientY;

            // 長押しでもドラッグ開始
            longPressTimer = setTimeout(startDrag, LONG_PRESS_DELAY);

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // タッチイベント
        dragHandle.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const touch = e.touches[0];
            isDragging = false;
            startX = touch.clientX;
            startY = touch.clientY;

            // 長押しでもドラッグ開始
            longPressTimer = setTimeout(() => {
                startDrag();
                this.isTouchDragging = true;
            }, LONG_PRESS_DELAY);

            const onTouchMove = (e) => {
                if (isDragging) {
                    // ドラッグ中の位置更新
                    const touch = e.touches[0];
                    this.updateDropZoneHighlight(touch.clientX, touch.clientY);
                    return;
                }

                const touch = e.touches[0];
                const dx = Math.abs(touch.clientX - startX);
                const dy = Math.abs(touch.clientY - startY);

                if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
                    if (longPressTimer) {
                        clearTimeout(longPressTimer);
                        longPressTimer = null;
                    }
                    isDragging = true;
                    this.startLiftDrag(panelId, moduleInfo);
                    this.isTouchDragging = true;
                }
            };

            const onTouchEnd = (e) => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
                document.removeEventListener('touchmove', onTouchMove);
                document.removeEventListener('touchend', onTouchEnd);

                // ドラッグ中だった場合はドロップ処理
                if (isDragging && this.isLiftDragging) {
                    this.onLiftDrop(e);
                }
            };

            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('touchend', onTouchEnd);
        }, { passive: false });
    }

    /**
     * パネルドロップゾーンの設定
     */
    setupPanelDropZones(panel, panelId) {
        const panelDropZones = panel.querySelectorAll('.panel-drop-zone');
        panelDropZones.forEach(zone => {
            zone.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                zone.classList.add('highlight');
            });
            zone.addEventListener('dragleave', (e) => {
                e.stopPropagation();
                zone.classList.remove('highlight');
            });
            zone.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleDrop(panelId, zone.dataset.zone);
            });
        });
    }

    async addPanel(moduleInfo, targetPanelId, position) {
        const panelId = `panel-${++this.panelIdCounter}`;

        const template = this.panelTemplate.content.cloneNode(true);
        const panel = template.querySelector('.module-panel');
        panel.id = panelId;
        panel.dataset.module = moduleInfo.module;

        const panelTitle = panel.querySelector('.panel-title');
        panelTitle.textContent = moduleInfo.title;

        const panelContent = panel.querySelector('.panel-content');
        const menuBtn = panel.querySelector('.panel-menu-btn');
        const panelMenu = panel.querySelector('.panel-menu');
        const deleteBtn = panel.querySelector('.delete-item');
        const dragHandle = panel.querySelector('.panel-drag-handle');

        // ドラッグハンドルのイベント設定
        this.setupDragHandle(dragHandle, panelId, moduleInfo);

        // パネルドロップゾーンの設定
        this.setupPanelDropZones(panel, panelId);

        this.setupMenuButton(menuBtn, panelMenu, panelId, moduleInfo);

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panelMenu.classList.remove('open');
            this.activeMenu = null;
            this.returnToDrawer(panelId);
        });

        if (this.panels.size === 0) {
            this.layoutRoot.appendChild(panel);
        } else {
            this.insertPanelIntoLayout(panel, targetPanelId, position);
        }

        this.workspaceEmpty.classList.add('hidden');
        this.moduleInWorkspace.add(moduleInfo.module);
        this.updateDrawerVisibility();

        const instance = await this.app.loadModuleIntoPanel(
            moduleInfo.module,
            moduleInfo.class,
            moduleInfo.container,
            panelContent
        );

        this.panels.set(panelId, {
            element: panel,
            moduleInfo,
            instance
        });

        this.saveLayout();
    }

    setupMenuButton(menuBtn, panelMenu, panelId, moduleInfo) {
        let isDragging = false;
        let startX, startY;
        const DRAG_THRESHOLD = 5;

        const onMouseMove = (e) => {
            if (isDragging) return;

            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);

            if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
                isDragging = true;
                this.startLiftDrag(panelId, moduleInfo);
            }
        };

        const onMouseUp = (e) => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            if (!isDragging) {
                e.stopPropagation();
                if (this.activeMenu && this.activeMenu !== panelMenu) {
                    this.activeMenu.classList.remove('open');
                }
                panelMenu.classList.toggle('open');
                this.activeMenu = panelMenu.classList.contains('open') ? panelMenu : null;
            }
        };

        // マウスイベント
        menuBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDragging = false;
            startX = e.clientX;
            startY = e.clientY;

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // タッチイベント
        menuBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const touch = e.touches[0];
            isDragging = false;
            startX = touch.clientX;
            startY = touch.clientY;

            let touchMoved = false;

            const onTouchMove = (e) => {
                if (isDragging) return;
                const touch = e.touches[0];
                const dx = Math.abs(touch.clientX - startX);
                const dy = Math.abs(touch.clientY - startY);

                if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
                    touchMoved = true;
                    isDragging = true;
                    this.startLiftDrag(panelId, moduleInfo);
                    this.isTouchDragging = true;
                }
            };

            const onTouchEnd = (e) => {
                document.removeEventListener('touchmove', onTouchMove);
                document.removeEventListener('touchend', onTouchEnd);

                if (!touchMoved && !isDragging) {
                    // タップでメニュー開閉
                    if (this.activeMenu && this.activeMenu !== panelMenu) {
                        this.activeMenu.classList.remove('open');
                    }
                    panelMenu.classList.toggle('open');
                    this.activeMenu = panelMenu.classList.contains('open') ? panelMenu : null;
                }
            };

            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('touchend', onTouchEnd);
        }, { passive: false });
    }

    startLiftDrag(panelId, moduleInfo) {
        const panelData = this.panels.get(panelId);
        if (!panelData) return;

        this.draggedData = {
            type: 'move',
            sourcePanelId: panelId, // 移動元パネルIDを保存
            module: moduleInfo.module,
            class: moduleInfo.class,
            container: moduleInfo.container,
            title: moduleInfo.title
        };

        // パネルをドラッグ中状態にする（削除はしない）
        panelData.element.classList.add('dragging');

        this.isLiftDragging = true;

        // ドロワーを非表示（ドラッグ中）
        this.drawer?.classList.add('hide-on-drag');

        // ドロップゾーンを表示（エッジ + パネル内）
        this.dropZones.classList.add('active');

        // ワークスペースにパネルが1つだけの場合はセンターゾーンも表示
        // 複数ある場合はセンターを非表示
        const centerZone = this.dropZones.querySelector('.zone-center');
        if (centerZone) {
            centerZone.style.display = this.panels.size > 1 ? 'none' : '';
        }

        // パネル内ドロップゾーンを有効化（自分以外）
        this.highlightPanelDropZones(true);

        // スプリッターをドロップターゲットとして設定
        this.setupSplitterDropTargets(true);

        document.body.style.cursor = 'grabbing';
    }

    /**
     * エッジドロップゾーンを表示
     */
    showEdgeDropZones() {
        this.dropZones.classList.add('active');
        // center zoneは非表示
        const centerZone = this.dropZones.querySelector('.zone-center');
        if (centerZone) centerZone.style.display = 'none';
    }

    /**
     * スプリッターをドロップターゲットとして設定
     */
    setupSplitterDropTargets(enable) {
        const splitters = this.layoutRoot.querySelectorAll('.splitter');
        splitters.forEach(splitter => {
            if (enable) {
                splitter.classList.add('drop-target-candidate');
            } else {
                splitter.classList.remove('drop-target-candidate', 'drop-target');
            }
        });
    }

    removePanelFromLayout(panelId, keepInWorkspace = false) {
        const panelData = this.panels.get(panelId);
        if (!panelData) return;

        if (panelData.instance?.dispose) {
            panelData.instance.dispose();
        }

        const panel = panelData.element;
        const parent = panel.parentElement;

        const prevSibling = panel.previousElementSibling;
        const nextSibling = panel.nextElementSibling;

        if (prevSibling?.classList.contains('splitter')) {
            prevSibling.remove();
        } else if (nextSibling?.classList.contains('splitter')) {
            nextSibling.remove();
        }

        panel.remove();
        this.panels.delete(panelId);

        if (parent && parent.classList.contains('split-container')) {
            const children = Array.from(parent.children).filter(c => !c.classList.contains('splitter'));

            if (children.length === 1) {
                const child = children[0];
                const grandParent = parent.parentElement;

                child.style.flex = '1';
                child.style.width = '';
                child.style.height = '';

                if (grandParent) {
                    grandParent.insertBefore(child, parent);
                    parent.remove();
                }
            } else if (children.length === 0) {
                parent.remove();
            }
        }

        if (this.panels.size === 0) {
            this.workspaceEmpty.classList.remove('hidden');
            this.layoutRoot.innerHTML = '';
        }

        if (!keepInWorkspace) {
            this.moduleInWorkspace.delete(panelData.moduleInfo.module);
            this.updateDrawerVisibility();
        }
    }

    returnToDrawer(panelId) {
        this.removePanelFromLayout(panelId, false);
        this.saveLayout();
    }

    insertPanelIntoLayout(newPanel, targetPanelId, position) {
        const isVertical = (position === 'top' || position === 'bottom');
        const direction = isVertical ? 'vertical' : 'horizontal';

        if (targetPanelId) {
            const targetData = this.panels.get(targetPanelId);
            if (!targetData) return;

            const targetEl = targetData.element;
            const parent = targetEl.parentElement;

            const container = document.createElement('div');
            container.className = `split-container ${direction}`;

            const splitter = this.createSplitter(direction);

            parent.insertBefore(container, targetEl);

            if (position === 'top' || position === 'left') {
                container.appendChild(newPanel);
                container.appendChild(splitter);
                container.appendChild(targetEl);
            } else {
                container.appendChild(targetEl);
                container.appendChild(splitter);
                container.appendChild(newPanel);
            }
        } else {
            const currentContent = this.layoutRoot.firstElementChild;
            if (!currentContent) {
                this.layoutRoot.appendChild(newPanel);
                return;
            }

            const container = document.createElement('div');
            container.className = `split-container ${direction}`;

            const splitter = this.createSplitter(direction);

            this.layoutRoot.innerHTML = '';

            if (position === 'top' || position === 'left') {
                container.appendChild(newPanel);
                container.appendChild(splitter);
                container.appendChild(currentContent);
            } else {
                container.appendChild(currentContent);
                container.appendChild(splitter);
                container.appendChild(newPanel);
            }

            this.layoutRoot.appendChild(container);
        }
    }

    createSplitter(direction) {
        const splitter = document.createElement('div');
        splitter.className = `splitter ${direction}`;

        // マウスイベント
        splitter.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.startSplitterDrag(splitter, direction, e.clientX, e.clientY);
        });

        // タッチイベント
        splitter.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            this.startSplitterDrag(splitter, direction, touch.clientX, touch.clientY);
        }, { passive: false });

        return splitter;
    }

    /**
     * スプリッタードラッグ開始（共通処理）
     */
    startSplitterDrag(splitter, direction, clientX, clientY) {
        const prev = splitter.previousElementSibling;
        const next = splitter.nextElementSibling;

        if (!prev || !next) return;

        this.activeSplitter = {
            element: splitter,
            direction,
            startX: clientX,
            startY: clientY,
            prev,
            next,
            prevRect: prev.getBoundingClientRect(),
            nextRect: next.getBoundingClientRect()
        };

        splitter.classList.add('active');
        document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
    }

    onSplitterDrag(e) {
        if (!this.activeSplitter) return;

        const { direction, startX, startY, prev, next, prevRect, nextRect } = this.activeSplitter;

        // ワークスペースの境界を取得
        const workspaceRect = this.workspace.getBoundingClientRect();

        if (direction === 'horizontal') {
            const dx = e.clientX - startX;
            // 最小サイズ制約を適用
            let newPrevWidth = Math.max(this.MIN_PANEL_WIDTH, prevRect.width + dx);
            let newNextWidth = Math.max(this.MIN_PANEL_WIDTH, nextRect.width - dx);

            // 右端境界制限: 次のパネルが画面外に出ないよう制限
            const maxPrevWidth = workspaceRect.width - this.MIN_PANEL_WIDTH - 10;
            newPrevWidth = Math.min(newPrevWidth, maxPrevWidth);
            newNextWidth = Math.max(this.MIN_PANEL_WIDTH, nextRect.width - (newPrevWidth - prevRect.width));

            // 両方が最小サイズを満たす場合のみ適用
            if (newPrevWidth >= this.MIN_PANEL_WIDTH && newNextWidth >= this.MIN_PANEL_WIDTH) {
                prev.style.flex = 'none';
                prev.style.width = newPrevWidth + 'px';
                next.style.flex = 'none';
                next.style.width = newNextWidth + 'px';
            }
        } else {
            const dy = e.clientY - startY;
            // 最小サイズ制約を適用
            let newPrevHeight = Math.max(this.MIN_PANEL_HEIGHT, prevRect.height + dy);
            let newNextHeight = Math.max(this.MIN_PANEL_HEIGHT, nextRect.height - dy);

            // 下端境界制限: 次のパネルが画面外に出ないよう制限
            const maxPrevHeight = workspaceRect.height - this.MIN_PANEL_HEIGHT - 10;
            newPrevHeight = Math.min(newPrevHeight, maxPrevHeight);
            newNextHeight = Math.max(this.MIN_PANEL_HEIGHT, nextRect.height - (newPrevHeight - prevRect.height));

            // 両方が最小サイズを満たす場合のみ適用
            if (newPrevHeight >= this.MIN_PANEL_HEIGHT && newNextHeight >= this.MIN_PANEL_HEIGHT) {
                prev.style.flex = 'none';
                prev.style.height = newPrevHeight + 'px';
                next.style.flex = 'none';
                next.style.height = newNextHeight + 'px';
            }
        }
    }

    onSplitterDragEnd() {
        if (this.activeSplitter) {
            this.activeSplitter.element.classList.remove('active');
            this.activeSplitter = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            this.saveLayout();
        }
    }
    // ========================================
    // DOMスナップショット方式 レイアウト保存・復元
    // ========================================

    /**
     * レイアウトを保存（DOMスナップショット方式）
     */
    saveLayout() {
        const serialize = (element) => {
            if (!element) return null;

            if (element.classList.contains('module-panel')) {
                const data = this.panels.get(element.id);
                if (!data) return null;

                const rect = element.getBoundingClientRect();
                return {
                    type: 'panel',
                    module: data.moduleInfo.module,
                    class: data.moduleInfo.class,
                    container: data.moduleInfo.container,
                    title: data.moduleInfo.title,
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                };
            } else if (element.classList.contains('split-container')) {
                const direction = element.classList.contains('vertical') ? 'vertical' : 'horizontal';
                const children = [];

                for (const child of element.children) {
                    if (child.classList.contains('splitter')) continue;

                    const serialized = serialize(child);
                    if (serialized) {
                        const childRect = child.getBoundingClientRect();
                        // 分割方向に応じたサイズを保存
                        serialized.size = direction === 'horizontal'
                            ? Math.round(childRect.width)
                            : Math.round(childRect.height);
                        children.push(serialized);
                    }
                }

                return {
                    type: 'split',
                    direction,
                    children
                };
            }
            return null;
        };

        const root = this.layoutRoot.firstElementChild;
        const layout = {
            version: 12,
            data: root ? serialize(root) : null
        };

        console.log('💾 Saving layout (v12):', JSON.stringify(layout, null, 2));
        localStorage.setItem('suiren-layout-v12', JSON.stringify(layout));
    }

    /**
     * レイアウトを復元（DOMスナップショット方式）
     */
    async restoreLayout() {
        // v12を優先、古いバージョンは無視
        const saved = localStorage.getItem('suiren-layout-v12');
        if (!saved) return;

        try {
            const layout = JSON.parse(saved);
            console.log('📂 Restoring layout (v12):', layout);

            if (layout?.data) {
                // layoutRootをクリア
                this.layoutRoot.innerHTML = '';
                this.panels.clear();
                this.moduleInWorkspace.clear();
                this.panelIdCounter = 0;

                // DOM構造を直接構築（この時点ではモジュールはロードしない）
                const rootElement = await this.buildDOMFromSnapshot(layout.data);
                if (rootElement) {
                    // DOMに追加
                    this.layoutRoot.appendChild(rootElement);
                    this.workspaceEmpty.classList.add('hidden');
                    this.updateDrawerVisibility();

                    // ★DOMに追加後にモジュールをロード
                    await this.loadModulesAfterRestore();

                    // ★復元後にレイアウトを正規化
                    setTimeout(() => this.normalizeLayout(), 100);
                }
            }
        } catch (e) {
            console.error('❌ Layout restore failed:', e);
            localStorage.removeItem('suiren-layout-v12');
        }
    }

    /**
     * スナップショットからDOM構造を構築
     */
    async buildDOMFromSnapshot(node) {
        if (!node) return null;

        if (node.type === 'panel') {
            return await this.createPanelFromSnapshot(node);
        } else if (node.type === 'split') {
            return await this.createSplitFromSnapshot(node);
        }
        return null;
    }

    /**
     * スナップショットからパネル要素を作成
     */
    async createPanelFromSnapshot(panelNode) {
        const panelId = `panel-${++this.panelIdCounter}`;
        const template = this.panelTemplate.content.cloneNode(true);
        const panel = template.querySelector('.module-panel');

        panel.id = panelId;
        panel.dataset.module = panelNode.module;

        const panelTitle = panel.querySelector('.panel-title');
        panelTitle.textContent = panelNode.title;

        const panelContent = panel.querySelector('.panel-content');
        const menuBtn = panel.querySelector('.panel-menu-btn');
        const panelMenu = panel.querySelector('.panel-menu');
        const deleteBtn = panel.querySelector('.delete-item');

        // ★重要: panelContentにIDを設定（モジュールがこのIDを参照する）
        panelContent.id = panelNode.container;

        const moduleInfo = {
            module: panelNode.module,
            class: panelNode.class,
            container: panelNode.container,
            title: panelNode.title
        };

        // ★ドラッグハンドルの設定（復元モジュールでも移動可能に）
        const dragHandle = panel.querySelector('.panel-drag-handle');
        this.setupDragHandle(dragHandle, panelId, moduleInfo);

        // ★パネルドロップゾーンの設定
        this.setupPanelDropZones(panel, panelId);

        this.setupMenuButton(menuBtn, panelMenu, panelId, moduleInfo);

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panelMenu.classList.remove('open');
            this.activeMenu = null;
            this.returnToDrawer(panelId);
        });

        // パネルデータを先に登録
        this.panels.set(panelId, {
            element: panel,
            instance: null, // インスタンスは後でロード
            moduleInfo
        });

        this.moduleInWorkspace.add(panelNode.module);

        // サイズを適用
        if (panelNode.width && panelNode.width > this.MIN_PANEL_WIDTH) {
            panel.style.width = panelNode.width + 'px';
            panel.style.flex = 'none';
        }
        if (panelNode.height && panelNode.height > this.MIN_PANEL_HEIGHT) {
            panel.style.height = panelNode.height + 'px';
            panel.style.flex = 'none';
        }

        return panel;
    }

    /**
     * 復元後にモジュールをロード
     */
    async loadModulesAfterRestore() {
        for (const [panelId, panelData] of this.panels) {
            if (panelData.instance) continue; // 既にロード済み

            const panelContent = panelData.element.querySelector('.panel-content');
            if (!panelContent) continue;

            try {
                const instance = await this.app.loadModuleIntoPanel(
                    panelData.moduleInfo.module,
                    panelData.moduleInfo.class,
                    panelData.moduleInfo.container,
                    panelContent
                );
                panelData.instance = instance;
            } catch (e) {
                console.error(`Module load error for ${panelData.moduleInfo.module}:`, e);
            }
        }
    }

    /**
     * スナップショットからsplit-container要素を作成
     */
    async createSplitFromSnapshot(splitNode) {
        const { direction, children } = splitNode;

        if (!children || children.length === 0) return null;

        const container = document.createElement('div');
        container.className = `split-container ${direction}`;

        for (let i = 0; i < children.length; i++) {
            const childNode = children[i];

            // 子要素を構築
            const childElement = await this.buildDOMFromSnapshot(childNode);
            if (!childElement) continue;

            // サイズを適用
            if (childNode.size) {
                if (direction === 'horizontal') {
                    childElement.style.width = childNode.size + 'px';
                    childElement.style.flex = 'none';
                } else {
                    childElement.style.height = childNode.size + 'px';
                    childElement.style.flex = 'none';
                }
            }

            container.appendChild(childElement);

            // 最後の要素以外にスプリッターを追加
            if (i < children.length - 1) {
                const splitter = this.createSplitter(direction);
                container.appendChild(splitter);
            }
        }

        return container;
    }
}

/**
 * AppController
 */
class AppController {
    constructor() {
        this.loadedScripts = new Set();
        window.globalAudioManager = new GlobalAudioManager();
        this.init();
    }

    init() {
        document.getElementById('menuToggle')?.addEventListener('click', () => {
            document.getElementById('moduleDrawer')?.classList.toggle('expanded');
        });
        this.layoutManager = new TreeLayoutManager(this);
        // プリセットシステム用にグローバル参照を設定
        window.layoutManager = this.layoutManager;
    }

    async loadModuleIntoPanel(moduleName, className, originalContainerId, panelContentElement) {
        try {
            const basePath = `./module/${moduleName}/${moduleName}`;
            this.loadCSS(`${basePath}.css`);

            const htmlResponse = await fetch(`${basePath}.html`);
            const htmlText = await htmlResponse.text();
            const doc = new DOMParser().parseFromString(htmlText, 'text/html');

            let moduleContent = doc.getElementById(originalContainerId);
            if (!moduleContent) {
                moduleContent = doc.body.firstElementChild || doc.body;
            }

            panelContentElement.innerHTML = '';
            panelContentElement.id = originalContainerId;

            const clonedContent = moduleContent.cloneNode(true);

            if (clonedContent.tagName === 'BODY') {
                panelContentElement.innerHTML = clonedContent.innerHTML;
            } else {
                while (clonedContent.firstChild) {
                    panelContentElement.appendChild(clonedContent.firstChild);
                }
            }

            await this.loadScript(`${basePath}.js`);

            if (window[className]) {
                const instance = new window[className](originalContainerId);
                if (typeof instance.mount === 'function') instance.mount();
                return instance;
            }
            return null;
        } catch (e) {
            console.error('Module Load Error:', e);
            panelContentElement.innerHTML = `<div style="color:red;padding:20px;">Error: ${e.message}</div>`;
            return null;
        }
    }

    loadCSS(href) {
        if (!document.querySelector(`link[href="${href}"]`)) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            document.head.appendChild(link);
        }
    }

    loadScript(src) {
        return new Promise((resolve, reject) => {
            if (this.loadedScripts.has(src)) { resolve(); return; }
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => { this.loadedScripts.add(src); resolve(); };
            script.onerror = reject;
            document.body.appendChild(script);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => new AppController());

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js').then(reg => {
            reg.onupdatefound = () => {
                const w = reg.installing;
                w.onstatechange = () => {
                    if (w.state === 'installed' && navigator.serviceWorker.controller) {
                        console.log('New content available');
                    }
                };
            };
        }).catch(e => console.log('SW error:', e));
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    });
}
