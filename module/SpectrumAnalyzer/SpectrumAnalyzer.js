/**
 * Spectrum Analyzer Module
 * グローバルオーディオマネージャーと連携してスペクトラム表示を行う
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
    this.animationId = null;
    this.resizeObserver = null;
    this.selectedFreq = null;

    // データ保持
    this.comparisonDataArray = null;
    this.detectedFundamentalFreq = null;

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
      showHarmonics: q('#showHarmonicsCheckbox'),
      saveCompareBtn: q('#saveCompareBtn'),
      showCompare: q('#showCompareCheckbox'),
    };

    if (!this.els.canvas || !this.els.ctx) {
      throw new Error('Canvas element not found.');
    }
  }

  /**
   * SPAマウント時に呼び出す初期化メソッド
   */
  mount() {
    this.setupEventListeners();
    this.handleResize();

    // Canvasのリサイズ監視
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
  }



  // =========================================
  //  Event Handling
  // =========================================

  setupEventListeners() {
    // 比較波形保存
    this.els.saveCompareBtn.addEventListener('click', () => {
      const gam = window.globalAudioManager;
      if (gam) {
        const dataArray = gam.getDataArray();
        this.comparisonDataArray = new Uint8Array(dataArray);
        this.els.showCompare.checked = true;

        this.els.saveCompareBtn.textContent = "保存完了!";
        this.els.saveCompareBtn.classList.add('success');
        setTimeout(() => {
          this.els.saveCompareBtn.textContent = "比較保存";
          this.els.saveCompareBtn.classList.remove('success');
        }, 1000);
      }
    });

    // Canvas Interaction
    this.els.canvas.addEventListener('mousedown', (e) => {
      const rect = this.els.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      this.selectedFreq = this.xToFreq(x);
    });

    // クリック解除
    this.els.canvas.addEventListener('dblclick', () => {
      this.selectedFreq = null;
    });
  }

  // =========================================
  //  Logic Helpers
  // =========================================

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
    const gam = window.globalAudioManager;
    const a4 = gam ? gam.getA4() : 442;
    const notation = gam ? gam.getNotation() : 'C';

    const NOTES_EN = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const NOTES_JP = ["ド", "ド#", "レ", "レ#", "ミ", "ファ", "ファ#", "ソ", "ソ#", "ラ", "ラ#", "シ"];

    const semitonesFromA4 = 12 * Math.log2(freq / a4);
    const midi = Math.round(semitonesFromA4) + 69;
    if (midi < 0) return "?";

    // 移調オフセット
    let offset = 0;
    switch (notation) {
      case "JP_Bb": offset = 2; break;
      case "JP_Eb": offset = 9; break;
      case "JP_F": offset = 7; break;
      default: offset = 0; break;
    }

    const transposedMidi = midi + offset;
    const noteIndex = transposedMidi % 12;
    const octave = Math.floor(transposedMidi / 12) - 1;

    if (notation.startsWith("JP")) {
      return `${NOTES_JP[noteIndex]}${octave}`;
    } else {
      return `${NOTES_EN[noteIndex]}${octave}`;
    }
  }

  // =========================================
  //  Drawing Engine
  // =========================================

  draw() {
    this.animationId = requestAnimationFrame(() => this.draw());

    const gam = window.globalAudioManager;

    if (!gam || !gam.analyser) {
      // Analyser未初期化時はグリッドだけ描画
      this.clearCanvas();
      this.drawGrid();
      return;
    }

    const freqPerBin = gam.audioContext.sampleRate / gam.analyser.fftSize;
    const bufferLength = gam.analyser.frequencyBinCount;
    const dataArray = gam.getDataArray();
    const gainVal = gam.getGain();
    const isFrozen = gam.isFreezeActive();



    this.clearCanvas();
    this.drawGrid();

    // 比較グラフ
    if (this.els.showCompare.checked && this.comparisonDataArray) {
      this.drawComparisonGraph(freqPerBin, gainVal);
    }

    // メイン波形
    this.els.ctx.lineWidth = 2;
    this.els.ctx.strokeStyle = "rgb(0,180,255)";
    this.els.ctx.beginPath();

    let maxVal = 0;
    let maxBinIndex = -1;
    let started = false;

    for (let i = 0; i < bufferLength; i++) {
      const freq = i * freqPerBin;
      if (freq < this.MIN_FREQ || freq > this.MAX_FREQ) continue;

      const val = dataArray[i];
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
    if (!isFrozen) {
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
    this.drawMarkerAndTooltip(freqPerBin, dataArray, gainVal);
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
    const freqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    ctx.textAlign = "center";
    for (let f of freqs) {
      const x = this.freqToX(f);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.els.canvas.height); ctx.stroke();
      ctx.fillText(f >= 1000 ? (f / 1000) + "k" : f, x, this.els.canvas.height - 5);
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

  drawComparisonGraph(freqPerBin, gainVal) {
    if (!this.comparisonDataArray) return;
    const { ctx, canvas } = this.els;

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
      ctx.fillStyle = "orange"; ctx.fillText("Base", x0 + 2, 30);
    }

    // Overtones
    ctx.strokeStyle = "rgba(255,255,0,0.4)"; ctx.fillStyle = "rgba(255,255,0,0.7)";
    for (let n = 2; n <= 16; n++) {
      const fn = f0 * n;
      if (fn > this.MAX_FREQ) break;
      const xn = this.freqToX(fn);
      if (xn >= 0) {
        ctx.beginPath(); ctx.moveTo(xn, 0); ctx.lineTo(xn, this.els.canvas.height); ctx.stroke();
        if (n <= 8) ctx.fillText(`x${n}`, xn + 2, 30);
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

  drawMarkerAndTooltip(freqPerBin, dataArray, gainVal) {
    if (this.selectedFreq == null) return;
    const ctx = this.els.ctx;
    const x = this.freqToX(this.selectedFreq);

    // Index計算
    let index = Math.round(this.selectedFreq / freqPerBin);
    let value = 0;
    if (index >= 0 && index < dataArray.length) value = dataArray[index];

    const dbValue = ((value * gainVal) / 255) * this.DISPLAY_MAX_DB;

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
    ctx.beginPath(); ctx.roundRect(bx, 40, w, h, 4); ctx.fill(); ctx.stroke();

    ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    ctx.fillText(textFreq, bx + 10, 58);
    ctx.fillStyle = "#aaa"; ctx.font = "11px monospace";
    ctx.fillText(textDB, bx + 10, 72);
    if (harmonicText) {
      ctx.fillStyle = harmonicText.includes("Sub") ? "cyan" : "orange";
      ctx.fillText(harmonicText, bx + 10, 90);
    }
  }
}

// グローバル登録
if (typeof window !== 'undefined' && !window.SpectrumAnalyzer) {
  window.SpectrumAnalyzer = SpectrumAnalyzer;
}