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
        });

        this.setupPlayerEvents();
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
        badge.className = 'status-badge';
        if (status) badge.classList.add(status);
        badge.textContent = text;
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
}

/**
 * TreeLayoutManager - ツリーベースの上下左右分割レイアウト管理
 */
class TreeLayoutManager {
    constructor(app) {
        this.app = app;
        this.panelIdCounter = 0;
        this.panels = new Map();
        this.moduleInWorkspace = new Set();
        this.moduleRegistry = []; // modules.jsonから読み込んだモジュール情報

        this.drawer = document.getElementById('moduleDrawer');
        this.drawerToggle = document.getElementById('drawerToggle');
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

        this.init();
    }

    async init() {
        this.drawerToggle?.addEventListener('click', () => this.drawer.classList.toggle('expanded'));

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

        // メニュー閉じる
        document.addEventListener('click', (e) => {
            if (this.activeMenu && !e.target.closest('.panel-menu') && !e.target.closest('.panel-menu-btn')) {
                this.activeMenu.classList.remove('open');
                this.activeMenu = null;
            }
        });

        this.restoreLayout();
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

            // ドラッグイベント設定
            card.addEventListener('dragstart', (e) => this.onCardDragStart(e, card));
            card.addEventListener('dragend', () => this.onDragEnd());

            this.moduleList.appendChild(card);
        });
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

        this.dropZones.classList.add('active');
        this.highlightPanelDropZones(true);
    }

    onDragEnd() {
        document.querySelectorAll('.module-card, .module-panel').forEach(c => c.classList.remove('dragging'));
        document.querySelectorAll('.drop-zone, .panel-drop-zone').forEach(z => z.classList.remove('highlight'));
        this.dropZones.classList.remove('active');
        this.highlightPanelDropZones(false);
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
        document.querySelectorAll('.drop-zone, .panel-drop-zone').forEach(z => z.classList.remove('highlight'));
        this.currentHoverZone = null;
        this.currentHoverPanelZone = null;

        const workspaceZones = this.dropZones.querySelectorAll('.drop-zone');
        for (const zone of workspaceZones) {
            const rect = zone.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                zone.classList.add('highlight');
                this.currentHoverZone = { type: 'workspace', zone: zone.dataset.zone };
                return;
            }
        }

        for (const [panelId, panelData] of this.panels) {
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
        document.querySelectorAll('.drop-zone, .panel-drop-zone').forEach(z => z.classList.remove('highlight'));
        this.dropZones.classList.remove('active');
        this.highlightPanelDropZones(false);

        if (!data) {
            this.draggedData = null;
            return;
        }

        let targetPanelId = null;
        let position = 'center';

        if (this.currentHoverPanelZone) {
            targetPanelId = this.currentHoverPanelZone.panelId;
            position = this.currentHoverPanelZone.zone;
        } else if (this.currentHoverZone) {
            position = this.currentHoverZone.zone;
        } else {
            this.moduleInWorkspace.delete(data.module);
            this.updateDrawerVisibility();
            this.draggedData = null;
            this.currentHoverZone = null;
            this.currentHoverPanelZone = null;
            this.saveLayout();
            return;
        }

        this.draggedData = null;
        this.currentHoverZone = null;
        this.currentHoverPanelZone = null;

        this.addPanel(data, targetPanelId, position);
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

        menuBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDragging = false;
            startX = e.clientX;
            startY = e.clientY;

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    startLiftDrag(panelId, moduleInfo) {
        const panelData = this.panels.get(panelId);
        if (!panelData) return;

        this.draggedData = {
            type: 'move',
            module: moduleInfo.module,
            class: moduleInfo.class,
            container: moduleInfo.container,
            title: moduleInfo.title
        };

        this.isLiftDragging = true;
        this.removePanelFromLayout(panelId, true);
        this.dropZones.classList.add('active');
        this.highlightPanelDropZones(true);
        document.body.style.cursor = 'grabbing';
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

        splitter.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const prev = splitter.previousElementSibling;
            const next = splitter.nextElementSibling;

            if (!prev || !next) return;

            this.activeSplitter = {
                element: splitter,
                direction,
                startX: e.clientX,
                startY: e.clientY,
                prev,
                next,
                prevRect: prev.getBoundingClientRect(),
                nextRect: next.getBoundingClientRect()
            };

            splitter.classList.add('active');
            document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
            document.body.style.userSelect = 'none';
        });

        return splitter;
    }

    onSplitterDrag(e) {
        if (!this.activeSplitter) return;

        const { direction, startX, startY, prev, next, prevRect, nextRect } = this.activeSplitter;

        if (direction === 'horizontal') {
            const dx = e.clientX - startX;
            const newPrevWidth = Math.max(100, prevRect.width + dx);
            const newNextWidth = Math.max(100, nextRect.width - dx);

            prev.style.flex = 'none';
            prev.style.width = newPrevWidth + 'px';
            next.style.flex = 'none';
            next.style.width = newNextWidth + 'px';
        } else {
            const dy = e.clientY - startY;
            const newPrevHeight = Math.max(80, prevRect.height + dy);
            const newNextHeight = Math.max(80, nextRect.height - dy);

            prev.style.flex = 'none';
            prev.style.height = newPrevHeight + 'px';
            next.style.flex = 'none';
            next.style.height = newNextHeight + 'px';
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

    saveLayout() {
        const serialize = (element) => {
            if (!element) return null;

            if (element.classList.contains('module-panel')) {
                const data = this.panels.get(element.id);
                if (!data) return null;
                return {
                    type: 'panel',
                    module: data.moduleInfo.module,
                    class: data.moduleInfo.class,
                    container: data.moduleInfo.container,
                    title: data.moduleInfo.title,
                    width: element.style.width || '',
                    height: element.style.height || ''
                };
            } else if (element.classList.contains('split-container')) {
                const children = [];
                for (const child of element.children) {
                    if (!child.classList.contains('splitter')) {
                        const serialized = serialize(child);
                        if (serialized) children.push(serialized);
                    }
                }
                return {
                    type: 'split',
                    direction: element.classList.contains('vertical') ? 'vertical' : 'horizontal',
                    children
                };
            }
            return null;
        };

        const root = this.layoutRoot.firstElementChild;
        const layout = root ? serialize(root) : null;
        localStorage.setItem('suiren-layout-v9', JSON.stringify(layout));
    }

    async restoreLayout() {
        const saved = localStorage.getItem('suiren-layout-v9');
        if (!saved) return;

        try {
            const layout = JSON.parse(saved);
            if (layout) {
                await this.restoreNode(layout, null);
            }
        } catch (e) {
            console.error('Layout restore failed:', e);
            localStorage.removeItem('suiren-layout-v9');
        }
    }

    async restoreNode(node, position) {
        if (!node) return;

        if (node.type === 'panel') {
            const pos = position || 'center';
            await this.addPanel({
                module: node.module,
                class: node.class,
                container: node.container,
                title: node.title
            }, null, pos);

            const lastPanel = Array.from(this.panels.values()).pop();
            if (lastPanel && node.width) {
                lastPanel.element.style.width = node.width;
                lastPanel.element.style.height = node.height;
                lastPanel.element.style.flex = 'none';
            }
        } else if (node.type === 'split' && node.children?.length > 0) {
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i];
                let pos;
                if (i === 0) {
                    pos = 'center';
                } else {
                    pos = node.direction === 'horizontal' ? 'right' : 'bottom';
                }
                await this.restoreNode(child, pos);
            }
        }
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
