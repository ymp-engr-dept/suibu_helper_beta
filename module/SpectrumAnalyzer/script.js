/**
 * Professional Spectrum Analyzer Module
 * SPA対応・クラスベース設計
 */
class SpectrumAnalyzer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) throw new Error(`Container #${containerId} not found.`);

    // --- 設定値 & 定数 ---
    this.MIN_FREQ = 20;
    this.MAX_FREQ = 20000;
    this.DISPLAY_MIN_DB = 0;
    this.DISPLAY_MAX_DB = 80;

    // --- 状態管理 ---
    this.audioContext = null;
    this.analyser = null;
    this.micSource = null;
    this.playerSource = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.animationId = null;
    this.resizeObserver = null;

    this.isFrozen = false;
    this.isRecording = false;
    this.isFileMode = false;
    this.isScrubbing = false;
    this.selectedFreq = null;
    
    // データ保持
    this.dataArray = new Uint8Array(2048);
    this.comparisonDataArray = null;
    this.detectedFundamentalFreq = null;
    this.recordedMimeType = "audio/webm";

    // --- DOM要素のキャッシュ ---
    this.bindDOMElements();
  }

  /**
   * DOM要素を取得しプロパティに紐付け
   */
  bindDOMElements() {
    const q = (sel) => this.container.querySelector(sel);
    const canvasEl = q('#analyzerCanvas');
    const ctx = canvasEl ? canvasEl.getContext('2d') : null;

    this.els = {
      canvas: canvasEl,
      ctx: ctx,
      gain: q('#gainInput'),
      a4: q('#a4Input'),
      showHarmonics: q('#showHarmonicsCheckbox'),
      freezeBtn: q('#freezeBtn'),
      saveCompareBtn: q('#saveCompareBtn'),
      showCompare: q('#showCompareCheckbox'),
      recordBtn: q('#recordBtn'),
      fileInput: q('#fileInput'),
      // Player related
      audioEngine: q('#audioEngine'),
      playerInterface: q('#playerInterface'),
      sourceMode: q('#sourceModeCheckbox'),
      playPauseBtn: q('#playPauseBtn'),
      seekBar: q('#audioSeekBar'),
      timeDisplay: q('#currentTimeDisplay'),
      durationDisplay: q('#durationDisplay'),
      volumeSlider: q('#volumeSlider'),
      playbackRate: q('#playbackRateSelect'),
      status: q('#statusIndicator'),
    };

    // 必須要素の検証（存在しない場合は早期に分かりやすいエラーを投げる）
    const required = [
      'canvas', 'ctx', 'audioEngine', 'sourceMode', 'recordBtn', 'status'
    ];
    const missing = required.filter(k => !this.els[k]);
    if (missing.length) {
      throw new Error(`Missing DOM element(s): ${missing.join(', ')}`);
    }
  }

  /**
   * SPAマウント時に呼び出す初期化メソッド
   */
  mount() {
    this.setupEventListeners();
    this.handleResize();
    
    // Canvasのリサイズ監視 (ウィンドウリサイズではなくコンテナリサイズに対応)
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);

    // 初期描画ループ開始
    this.draw();
  }

  /**
   * SPAアンマウント時に呼び出すクリーンアップメソッド
   */
  dispose() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.audioContext) this.audioContext.close();
    
    // 録音中なら停止
    if (this.isRecording && this.mediaRecorder) {
      this.mediaRecorder.stop();
    }
  }

  // =========================================
  //  Audio System
  // =========================================

  async initAudio() {
    if (this.audioContext) return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContext();

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;

    // マイク入力設定
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micSource = this.audioContext.createMediaStreamSource(stream);
      this.setupRecorder(stream);
      this.els.status.textContent = "Mic Ready";
    } catch (e) {
      console.warn("マイクアクセス拒否または利用不可:", e);
      this.els.status.textContent = "Mic Error";
    }

    // プレイヤー入力設定
    this.playerSource = this.audioContext.createMediaElementSource(this.els.audioEngine);

    // ルーティング適用
    this.updateSourceRouting();
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
      // 録音完了後は自動でファイルモードへ
      this.els.sourceMode.checked = true;
      this.updateSourceRouting();
    };
  }

  updateSourceRouting() {
    if (!this.audioContext || !this.analyser) return;

    // sourceMode は this.els 内の要素なので安全にアクセスする
    this.isFileMode = !!(this.els.sourceMode && this.els.sourceMode.checked);

    const playerInterface = this.els.playerInterface;
    const audioEngine = this.els.audioEngine;
    const { micSource, playerSource, analyser } = this;
    const { playPauseBtn, seekBar, volumeSlider, playbackRate } = this.els;

    // UI制御
    if (this.isFileMode) {
      if (playerInterface && playerInterface.classList) playerInterface.classList.remove('disabled');
      [playPauseBtn, seekBar, volumeSlider, playbackRate].forEach(el => { if (el) el.disabled = false; });
    } else {
      if (playerInterface && playerInterface.classList) playerInterface.classList.add('disabled');
      [playPauseBtn, seekBar, volumeSlider, playbackRate].forEach(el => { if (el) el.disabled = true; });
    }

    // Audio Routing
    if (this.isFileMode) {
      // File Mode
      try { if (micSource && micSource.disconnect) micSource.disconnect(); } catch(e){}
      try {
        if (playerSource && playerSource.connect) playerSource.connect(analyser);
        if (analyser && analyser.connect) analyser.connect(this.audioContext.destination); // 鳴らす
      } catch(e){}
    } else {
      // Mic Mode
      try { if (playerSource && playerSource.disconnect) playerSource.disconnect(); } catch(e){}
      try { if (analyser && analyser.disconnect) analyser.disconnect(this.audioContext.destination); } catch(e){}
      try { if (micSource && micSource.connect) micSource.connect(analyser); } catch(e){}
    }
  }

  // =========================================
  //  Event Handling
  // =========================================

  setupEventListeners() {
    // Audio Context開始トリガー (ユーザー操作が必要)
    this.container.addEventListener('click', () => this.initAudio(), { once: true });

    // Tools
    this.els.freezeBtn.addEventListener('click', () => {
      this.isFrozen = !this.isFrozen;
      this.els.freezeBtn.textContent = this.isFrozen ? "再開" : "フリーズ";
      this.els.freezeBtn.style.background = this.isFrozen ? "#d32f2f" : "";
    });

    this.els.saveCompareBtn.addEventListener('click', () => {
      if (this.dataArray) {
        this.comparisonDataArray = new Uint8Array(this.dataArray);
        this.els.showCompare.checked = true;
        
        const originalText = this.els.saveCompareBtn.textContent;
        this.els.saveCompareBtn.textContent = "保存完了!";
        setTimeout(() => this.els.saveCompareBtn.textContent = originalText, 1000);
      }
    });

    this.els.recordBtn.addEventListener('click', () => {
      if (!this.audioContext) this.initAudio();
      if (!this.mediaRecorder) return;

      if (!this.isRecording) {
        this.startRecording();
      } else {
        this.stopRecording();
      }
    });

    // File Input
    this.els.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        this.loadAudioBlob(file);
        this.els.sourceMode.checked = true;
        this.updateSourceRouting();
      }
    });

    // Mode Switch
    this.els.sourceMode.addEventListener('change', () => {
      if(!this.audioContext) this.initAudio();
      this.updateSourceRouting();
    });

    // Canvas Interaction
    this.els.canvas.addEventListener('mousedown', (e) => {
      const rect = this.els.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      this.selectedFreq = this.xToFreq(x);
    });
    
    // Player Events
    this.setupPlayerEvents();
  }

  setupPlayerEvents() {
    const { audioEngine, playPauseBtn, seekBar, timeDisplay, durationDisplay, volumeSlider, playbackRate } = this.els;

    audioEngine.addEventListener('play', () => {
      if (this.audioContext && this.audioContext.state === 'suspended') this.audioContext.resume();
      playPauseBtn.textContent = "❚❚";
    });

    audioEngine.addEventListener('pause', () => playPauseBtn.textContent = "▶");
    audioEngine.addEventListener('ended', () => playPauseBtn.textContent = "▶");
    
    audioEngine.addEventListener('loadedmetadata', () => {
      seekBar.max = audioEngine.duration;
      durationDisplay.textContent = this.formatTime(audioEngine.duration);
    });

    audioEngine.addEventListener('timeupdate', () => {
      if (!this.isScrubbing) {
        seekBar.value = audioEngine.currentTime;
        timeDisplay.textContent = this.formatTime(audioEngine.currentTime);
      }
    });

    playPauseBtn.addEventListener('click', () => {
      if(audioEngine.paused) audioEngine.play();
      else audioEngine.pause();
    });

    volumeSlider.addEventListener('input', (e) => audioEngine.volume = parseFloat(e.target.value));
    playbackRate.addEventListener('change', (e) => audioEngine.playbackRate = parseFloat(e.target.value));

    // Scrubbing
    const startScrub = () => { this.isScrubbing = true; };
    const endScrub = () => { this.isScrubbing = false; };
    const performScrub = () => {
      if(!this.audioContext) this.initAudio();
      audioEngine.currentTime = parseFloat(seekBar.value);
      timeDisplay.textContent = this.formatTime(audioEngine.currentTime);
    };

    seekBar.addEventListener('mousedown', startScrub);
    seekBar.addEventListener('touchstart', startScrub, {passive: true});
    seekBar.addEventListener('input', performScrub);
    seekBar.addEventListener('mouseup', endScrub);
    seekBar.addEventListener('touchend', endScrub);
  }

  // =========================================
  //  Logic Helpers
  // =========================================

  startRecording() {
    this.audioChunks = [];
    this.mediaRecorder.start();
    this.isRecording = true;
    this.els.recordBtn.textContent = "■ 停止";
    this.els.recordBtn.classList.add("recording");
    this.els.audioEngine.pause();
  }

  stopRecording() {
    this.mediaRecorder.stop();
    this.isRecording = false;
    this.els.recordBtn.textContent = "● 録音";
    this.els.recordBtn.classList.remove("recording");
  }

  loadAudioBlob(blob) {
    const url = URL.createObjectURL(blob);
    this.els.audioEngine.src = url;
  }

  formatTime(seconds) {
    if(!seconds) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  handleResize() {
    this.els.canvas.width = this.els.canvas.clientWidth;
    this.els.canvas.height = this.els.canvas.clientHeight;
  }

  freqToX(freq) {
    const logMin = Math.log10(this.MIN_FREQ);
    const logMax = Math.log10(this.MAX_FREQ);
    const logF = Math.log10(freq);
    return ((logF - logMin) / (logMax - logMin)) * this.els.canvas.width;
  }

  xToFreq(x) {
    const logMin = Math.log10(this.MIN_FREQ);
    const logMax = Math.log10(this.MAX_FREQ);
    const ratio = x / this.els.canvas.width;
    const logF = ratio * (logMax - logMin) + logMin;
    return Math.pow(10, logF);
  }

  getNoteName(freq) {
    if (!freq || freq <= 0) return "--";
    const a4 = Number(this.els.a4.value) || 442;
    const noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const semitonesFromA4 = 12 * Math.log2(freq / a4);
    const midiNum = Math.round(semitonesFromA4) + 69;
    if (midiNum < 0) return "?"; 
    return `${noteStrings[midiNum % 12]}${Math.floor(midiNum / 12) - 1}`;
  }

  // =========================================
  //  Drawing Engine
  // =========================================

  draw() {
    this.animationId = requestAnimationFrame(() => this.draw());
    
    if (!this.analyser) {
        // Analyser未初期化時はグリッドだけ描画
        this.clearCanvas();
        this.drawGrid();
        return;
    }

    const freqPerBin = this.audioContext.sampleRate / this.analyser.fftSize;
    const bufferLength = this.analyser.frequencyBinCount;

    if (!this.isFrozen) {
      this.analyser.getByteFrequencyData(this.dataArray);
    }

    this.clearCanvas();
    this.drawGrid();

    // 比較グラフ
    if (this.els.showCompare.checked && this.comparisonDataArray) {
      this.drawComparisonGraph(freqPerBin);
    }

    // メイン波形
    const gainVal = Number(this.els.gain.value) || 1;
    this.els.ctx.lineWidth = 2;
    this.els.ctx.strokeStyle = "rgb(0,180,255)";
    this.els.ctx.beginPath();

    let maxVal = 0;
    let maxBinIndex = -1;
    let started = false;

    for (let i = 0; i < bufferLength; i++) {
      const freq = i * freqPerBin;
      if (freq < this.MIN_FREQ || freq > this.MAX_FREQ) continue;
      
      const val = this.dataArray[i];
      if (val > maxVal) {
        maxVal = val;
        maxBinIndex = i;
      }

      const x = this.freqToX(freq);
      const y = this.els.canvas.height * (1 - (val / 255) * gainVal);

      if (!started) {
        this.els.ctx.moveTo(x, y);
        started = true;
      } else {
        this.els.ctx.lineTo(x, y);
      }
    }
    this.els.ctx.stroke();

    // 基本周波数検出
    if (!this.isFrozen) {
      if (maxVal > 50 && maxBinIndex !== -1) {
        this.detectedFundamentalFreq = maxBinIndex * freqPerBin;
      } else {
        this.detectedFundamentalFreq = null;
      }
    }

    // 倍音描画
    if (this.els.showHarmonics.checked && this.detectedFundamentalFreq) {
      this.drawHarmonicsLines(this.detectedFundamentalFreq);
    }

    // マーカーとツールチップ
    this.drawMarkerAndTooltip(freqPerBin);
  }

  clearCanvas() {
    const { ctx, canvas } = this.els;
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, "#000");
    grad.addColorStop(1, "#050505");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  drawGrid() {
    const ctx = this.els.ctx;
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#888";
    
    // 周波数目盛り
    const freqs = [20,50,100,200,500,1000,2000,5000,10000,20000];
    ctx.textAlign = "center";
    for (let f of freqs) {
      const x = this.freqToX(f);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.els.canvas.height); ctx.stroke();
      ctx.fillText(f >= 1000 ? (f/1000)+"k" : f, x, this.els.canvas.height - 5);
    }

    // dB目盛り
    const dBLines = [0, 20, 40, 60, 80];
    ctx.textAlign = "left";
    dBLines.forEach(dB => {
      const y = this.els.canvas.height * (1 - dB / this.DISPLAY_MAX_DB);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.els.canvas.width, y); ctx.stroke();
      ctx.fillText(dB + "dB", 5, y - 3);
    });
  }

  drawComparisonGraph(freqPerBin) {
    if (!this.comparisonDataArray) return;
    const { ctx, canvas, gain } = this.els;
    const gainVal = Number(gain.value) || 1;
    
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(150, 150, 150, 0.4)"; 
    ctx.fillStyle = "rgba(150, 150, 150, 0.1)"; 

    ctx.beginPath();
    ctx.moveTo(0, canvas.height);

    let started = false;
    for (let i = 0; i < this.comparisonDataArray.length; i++) {
      const freq = i * freqPerBin;
      if (freq < this.MIN_FREQ || freq > this.MAX_FREQ) continue;
      
      const val = this.comparisonDataArray[i];
      const x = this.freqToX(freq);
      const y = canvas.height * (1 - (val / 255) * gainVal);

      if (!started) {
        ctx.lineTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  drawHarmonicsLines(f0) {
    if (!f0 || f0 < this.MIN_FREQ) return;
    const ctx = this.els.ctx;
    
    // Base
    const x0 = this.freqToX(f0);
    if (x0 >= 0) {
      ctx.beginPath(); ctx.strokeStyle = "rgba(255,165,0,0.8)"; 
      ctx.setLineDash([]); ctx.moveTo(x0, 0); ctx.lineTo(x0, this.els.canvas.height); ctx.stroke();
      ctx.fillStyle = "orange"; ctx.fillText("Base", x0 + 2, 10);
    }

    // Overtones
    ctx.strokeStyle = "rgba(255,255,0,0.4)"; ctx.fillStyle = "rgba(255,255,0,0.7)";
    for (let n = 2; n <= 16; n++) {
      const fn = f0 * n;
      if (fn > this.MAX_FREQ) break;
      const xn = this.freqToX(fn);
      if (xn >= 0) {
        ctx.beginPath(); ctx.moveTo(xn, 0); ctx.lineTo(xn, this.els.canvas.height); ctx.stroke();
        if (n <= 8) ctx.fillText(`x${n}`, xn + 2, 10);
      }
    }

    // Subharmonics
    ctx.strokeStyle = "rgba(0,255,255,0.4)"; ctx.fillStyle = "rgba(0,255,255,0.7)"; ctx.setLineDash([2, 4]);
    for (let n = 2; n <= 4; n++) {
      const fn = f0 / n;
      if (fn < this.MIN_FREQ) break;
      const xn = this.freqToX(fn);
      if (xn >= 0) {
        ctx.beginPath(); ctx.moveTo(xn, 0); ctx.lineTo(xn, this.els.canvas.height); ctx.stroke();
        ctx.fillText(`1/${n}`, xn + 2, this.els.canvas.height - 20);
      }
    }
    ctx.setLineDash([]);
  }

  drawMarkerAndTooltip(freqPerBin) {
    if (this.selectedFreq == null) return;
    const ctx = this.els.ctx;
    const x = this.freqToX(this.selectedFreq);
    
    // Index計算
    let index = Math.round(this.selectedFreq / freqPerBin);
    let value = 0;
    if (index >= 0 && index < this.dataArray.length) value = this.dataArray[index];
    
    const dbValue = ((value * (Number(this.els.gain.value)||1)) / 255) * this.DISPLAY_MAX_DB;

    // 赤ライン
    ctx.beginPath(); ctx.strokeStyle = "rgba(255, 50, 50, 0.8)"; ctx.lineWidth = 1;
    ctx.setLineDash([4, 2]); ctx.moveTo(x, 0); ctx.lineTo(x, this.els.canvas.height); ctx.stroke(); ctx.setLineDash([]);

    // テキスト構成
    const noteName = this.getNoteName(this.selectedFreq);
    const textFreq = `${Math.round(this.selectedFreq)}Hz (${noteName})`;
    const textDB = `${dbValue.toFixed(1)} dB`;
    
    // 倍音判定
    let harmonicText = "";
    if (this.detectedFundamentalFreq) {
      const f0 = this.detectedFundamentalFreq;
      if (this.selectedFreq >= f0) {
        const ratio = this.selectedFreq / f0;
        const n = Math.round(ratio);
        if (Math.abs(ratio - n) < 0.05) harmonicText = n === 1 ? "★ 基本周波数" : `倍音: x${n}`;
      } else {
        const ratio = f0 / this.selectedFreq;
        const n = Math.round(ratio);
        if (Math.abs(ratio - n) < 0.05 && n > 1) harmonicText = `倍音: 1/${n}`;
      }
    }

    // ツールチップ
    ctx.font = "bold 12px sans-serif";
    const w = Math.max(110, ctx.measureText(textFreq).width + 20);
    const h = harmonicText ? 60 : 45;
    let bx = x + 10;
    if (bx + w > this.els.canvas.width) bx = x - w - 10;
    
    ctx.fillStyle = "rgba(20, 20, 20, 0.9)"; ctx.strokeStyle = "#444";
    ctx.beginPath(); ctx.roundRect(bx, 20, w, h, 4); ctx.fill(); ctx.stroke();

    ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    ctx.fillText(textFreq, bx + 10, 38);
    ctx.fillStyle = "#aaa"; ctx.font = "11px monospace";
    ctx.fillText(textDB, bx + 10, 52);
    if (harmonicText) {
      ctx.fillStyle = harmonicText.includes("Sub") ? "cyan" : "orange";
      ctx.fillText(harmonicText, bx + 10, 70);
    }
  }
}

// ブラウザ上でモジュールを SPA から参照できるようにグローバル登録
if (typeof window !== 'undefined' && !window.SpectrumAnalyzer) {
  window.SpectrumAnalyzer = SpectrumAnalyzer;
}