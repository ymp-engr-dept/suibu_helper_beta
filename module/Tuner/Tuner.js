/**
 * Pro Vision Tuner Module
 * GlobalAudioManager連携版
 */
class TunerModule {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) throw new Error(`Container #${containerId} not found.`);

    // --- Configuration ---
    this.config = {
      bufferSize: 4096,
      downsampleRate: 4,     // 48kHz -> 12kHz
      freqTolerance: 0.03,
      confidenceThreshold: 0.92,
      visualHistorySize: 50,

      // ===== 高度な雑音フィルタリング設定 =====
      // 倍音構造検証
      harmonicMinCount: 2,           // 最低必要な倍音数（基音含む）
      harmonicTolerance: 0.06,       // 倍音周波数の許容誤差（6%）
      harmonicMinStrength: 0.15,     // 倍音の最低強度（基音比）

      // 突発音フィルタリング
      transientThreshold: 3.0,       // RMS急上昇の閾値（倍率）
      transientHoldFrames: 8,        // 突発音後の無視フレーム数

      // 継続時間チェック
      minPitchDurationMs: 50,        // 最低継続時間（ミリ秒）
      pitchConsistencyFrames: 3,     // 一貫性確認に必要なフレーム数

      // アルゴリズム一致度
      algoAgreementThreshold: 0.08,  // アルゴリズム間の許容誤差（8%）
      minAlgoAgreement: 2,           // 最低一致アルゴリズム数

      // エンベロープ追跡
      envelopeSmoothingFactor: 0.3,  // エンベロープ平滑化係数
      minEnvelopeRatio: 0.4,         // 最低エンベロープ比率
    };

    // --- State ---
    this.audioContext = null;
    this.analyser = null;
    this.micSource = null;
    this.fileSource = null;
    this.filter = null;
    this.isRunning = false;
    this.animationId = null;
    this.resizeObserver = null;
    this.currentSourceMode = null; // 'mic' or 'file'

    // Buffers
    this.timeBuf = null;
    this.freqBuf = null;
    this.yinBuffer = null;
    this.mpmNsdf = null;

    // Analysis State
    this.lastValidFreq = 0;
    this.stabilityCounter = 0;

    // ===== 高度な雑音フィルタリング状態 =====
    this.noiseFilter = {
      // エンベロープ追跡
      smoothedRMS: 0,
      prevRMS: 0,
      peakRMS: 0,

      // 突発音検出
      transientHoldCounter: 0,
      isTransient: false,

      // 継続時間追跡
      pitchHistory: [],           // {freq, timestamp} の配列
      lastConfirmedFreq: 0,
      pitchStartTime: 0,

      // アルゴリズム一致履歴
      algoAgreementHistory: [],

      // 品質スコア履歴
      qualityHistory: [],
    };

    // Visualization State
    this.currentStableFreq = 0;
    this.visualFreq = 0;
    this.perceivedFreq = 0;
    this.rawAlgoFreqs = { yin: 0, mpm: 0, fft: 0 };

    this.algoHistory = { yin: [], mpm: [], fft: [], perc: [] };
    this.visualSwayState = {
      yin: { min: 0, max: 0 },
      mpm: { min: 0, max: 0 },
      fft: { min: 0, max: 0 },
      perc: { min: 0, max: 0 }
    };

    // === 予測ピッチ表示用 ===
    this.predictionDisplay = {
      predictedFreq: 0,
      trend: 0,
      confidence: 0,
    };

    // === 外れ値除去用 ===
    this.stabilizer = {
      history: [],           // 直近の周波数履歴
      lastStableFreq: 0,
      outlierCount: 0,
      maxOutlierCents: 80,   // 80セント以上の変化は外れ値候補
    };

    // --- Constants ---
    this.NOTES_EN = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    this.NOTES_JP = ["ド", "ド#", "レ", "レ#", "ミ", "ファ", "ファ#", "ソ", "ソ#", "ラ", "ラ#", "シ"];

    // --- DOM Elements ---
    this.bindDOMElements();
  }

  bindDOMElements() {
    const q = (sel) => this.container.querySelector(sel);
    this.els = {
      note: q('#noteDisplay'),
      oct: q('#octaveDisplay'),
      cents: q('#centsDisplay'),
      canvas: q('#scopeCanvas'),
      // 信頼度表示
      confidenceBar: q('#confidenceBar'),
      confidenceText: q('#confidenceText'),
    };
    this.ctx = this.els.canvas.getContext('2d');

    // オフスクリーンキャンバス（静的背景用）
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCtx = this.offscreenCanvas.getContext('2d');
  }

  // ============================================
  //  Lifecycle Methods
  // ============================================

  mount() {
    this.handleResize();

    // Canvasのリサイズ監視
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    const canvasParent = this.els.canvas && this.els.canvas.parentElement;
    if (canvasParent) this.resizeObserver.observe(canvasParent);

    // 処理ループ開始（マイクやファイルが接続されたら自動で動作）
    this.startProcessing();
  }

  dispose() {
    this.stop();
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  handleResize() {
    const parent = this.els.canvas.parentElement;
    if (parent) {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      this.els.canvas.width = w;
      this.els.canvas.height = h;

      // オフスクリーンキャンバスもリサイズ
      if (this.offscreenCanvas) {
        this.offscreenCanvas.width = w;
        this.offscreenCanvas.height = h;
        this.drawStaticBackground();
      }
    }
  }

  /**
   * 静的な背景要素を描画（オフスクリーン）
   */
  drawStaticBackground() {
    const ctx = this.offscreenCtx;
    const w = this.offscreenCanvas.width;
    const h = this.offscreenCanvas.height;

    // 背景クリア
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const row1H = h * 0.2;
    const row2H = h * 0.2;
    const row2Y = row1H;
    const mainY = row1H + row2H;

    // 区切り線
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, row1H); ctx.lineTo(w, row1H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, mainY); ctx.lineTo(w, mainY); ctx.stroke();

    // 静的ラベル
    ctx.fillStyle = "#666"; ctx.font = "10px sans-serif";
    ctx.fillText("ALGO RAW", 40, row1H - 5);

    ctx.fillStyle = "#e040fb";
    ctx.fillText("PERCEIVED", 40, row2Y + row2H - 5);
  }

  // ============================================
  //  Audio Setup (GlobalAudioManager連携)
  // ============================================

  /**
   * 処理ループを開始（モジュールマウント時に呼ばれる）
   * AudioContextが利用可能になったら自動でセットアップする
   */
  startProcessing() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.processLoop();
  }

  /**
   * AudioContextが利用可能であればオーディオノードをセットアップ
   * processLoop内で繰り返し呼ばれ、準備ができたら初期化を行う
   */
  async setupAudioIfNeeded() {
    const gam = window.globalAudioManager;
    if (!gam) return false;

    // GlobalAudioManagerが準備できていなければ初期化を促す
    if (!gam.analyser) {
      // まだ初期化されていない場合は何もしない（ユーザーアクション待ち）
      // またはgam.initAudio()を呼ぶこともできるが、通常はクリックイベント待ち
      return false;
    }

    // AudioContext参照のみ保持（描画同期等で必要な場合）
    this.audioContext = gam.audioContext;

    // バッファ初期化（1回のみ）
    if (!this.timeBuf) {
      this.timeBuf = new Float32Array(this.config.bufferSize);
      this.freqBuf = new Uint8Array(this.config.bufferSize / 2);
    }

    return true;
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

  getNotation() {
    const gam = window.globalAudioManager;
    return gam ? gam.getNotation() : 'C';
  }

  getMinRMS() {
    // Gainを感度として使用（高いGain = 低いRMS閾値 = 高感度）
    const gain = this.getGain();
    // gain 1.0 -> minRMS 0.012, gain 0.1 -> minRMS 0.12, gain 10 -> minRMS 0.0012
    return 0.012 / gain;
  }

  isFrozen() {
    const gam = window.globalAudioManager;
    return gam ? gam.isFreezeActive() : false;
  }

  isFileMode() {
    const gam = window.globalAudioManager;
    return gam ? gam.isFileMode : false;
  }

  // ============================================
  //  Processing Loop
  // ============================================

  async processLoop() {
    if (!this.isRunning) return;
    this.animationId = requestAnimationFrame(() => this.processLoop());

    const pm = window.powerManager;

    // === 描画は常に実行（スムーズ表示） ===
    if (pm && !pm.shouldSkipDrawing('tuner')) {
      this.draw();
    }

    // フリーズ中はデータ更新しない
    if (this.isFrozen()) return;

    // === 処理はPowerManagerの指示に従う ===
    if (pm && pm.shouldSkipProcessing('tuner', this._lastProcessTime || 0)) {
      return;
    }
    this._lastProcessTime = performance.now();

    // Audioセットアップ確認
    const ready = await this.setupAudioIfNeeded();
    if (!ready) return; // 準備できていなければスキップ

    const gam = window.globalAudioManager;
    const analyserToUse = gam.analyser;

    // Analyserがまだ無い場合はグリッドのみ描画
    if (!analyserToUse) {
      this.draw();
      return;
    }

    analyserToUse.getFloatTimeDomainData(this.timeBuf);
    analyserToUse.getByteFrequencyData(this.freqBuf);

    // RMS Gate
    const rms = this.calculateRMS(this.timeBuf);
    if (pm) pm.updateRMS(rms);

    const minRMS = this.getMinRMS();
    if (rms < minRMS) {
      this.resetState();
      this.draw();
      return;
    }

    const sr = this.audioContext.sampleRate;

    // === 音声データの実際の発生時刻を計算（PerformanceGraphと同期） ===
    const bufferSize = analyserToUse.fftSize;
    const bufferLatencyMs = (bufferSize / sr) * 1000;
    const audioDataTimestamp = performance.now() - bufferLatencyMs;

    // === PitchEngine統合 (Centralized) ===
    if (window.pitchEngine) {
      window.pitchEngine.setA4(this.getA4());

      // 解析実行 (正確なタイムスタンプを渡す)
      window.pitchEngine.analyze(this.timeBuf, sr, this.freqBuf, audioDataTimestamp);

      // Tuner用に加工されたピッチを取得
      const pitchResult = window.pitchEngine.getProcessedPitch('tuner');

      // 個別アルゴリズムの結果を取得（可視化用）
      const algoResults = window.pitchEngine.getAlgorithmResults();
      if (algoResults && Array.isArray(algoResults)) {
        // YIN
        const yin = algoResults.find(r => r.name === 'yin');
        if (yin) {
          this.rawAlgoFreqs.yin = yin.freq;
          this.updateSwayHistory('yin', yin.freq);
        }

        // NSDF (MPMとして表示)
        const nsdf = algoResults.find(r => r.name === 'nsdf');
        if (nsdf) {
          this.rawAlgoFreqs.mpm = nsdf.freq;
          this.updateSwayHistory('mpm', nsdf.freq);
        }

        // Spectral (FFT/HARMとして表示)
        const spectral = algoResults.find(r => r.name === 'spectral');
        if (spectral) {
          this.rawAlgoFreqs.fft = spectral.freq;
          this.updateSwayHistory('fft', spectral.freq);
        }
      }

      if (pitchResult && pitchResult.freq) {
        this.currentStableFreq = pitchResult.freq;
        this.updateUpperUI(pitchResult.freq, pitchResult.confidence);

        // ビブラート・予測情報の更新
        this.vibratoState = pitchResult.vibrato;
        if (pitchResult.prediction) {
          this.predictionDisplay = {
            predictedFreq: pitchResult.prediction.freq || 0, // lastPrediction構造に合わせる
            trend: pitchResult.prediction.trend || 0,
            confidence: pitchResult.prediction.confidence || 0
          };
        }
      } else {
        // 信頼度が低い または フィルタで除外された場合
        this.resetState();
      }
    }
  }

  // ============================================
  //  Visualization
  // ============================================

  draw() {
    const { canvas } = this.els;
    const ctx = this.ctx;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;



    // オフスクリーンキャンバス（背景）を描画
    if (this.offscreenCanvas && this.offscreenCanvas.width === w) {
      ctx.drawImage(this.offscreenCanvas, 0, 0);
    } else {
      // フォールバック
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
    }

    const VIEW_RANGE_CENTS = 60;
    const pxPerCent = w / (VIEW_RANGE_CENTS * 2);

    if (this.currentStableFreq <= 0) {
      this.drawCenterLine(cx, h, false);
      return;
    }

    if (this.visualFreq === 0 || Math.abs(this.visualFreq - this.currentStableFreq) > 50) {
      this.visualFreq = this.currentStableFreq;
    } else {
      this.visualFreq += (this.currentStableFreq - this.visualFreq) * 0.15;
    }

    const centerFreq = this.visualFreq;
    const centerInfo = this.getPitchInfo(centerFreq);

    // --- Grid & Green Zone ---
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";

    for (let i = -3; i <= 3; i++) {
      const targetRawMidi = centerInfo.rawMidi + i;
      const targetFreq = this.getA4() * Math.pow(2, (targetRawMidi - 69) / 12);
      const targetLabelInfo = this.getPitchInfo(targetFreq);

      const diffCents = 1200 * Math.log2(targetFreq / centerFreq);

      if (Math.abs(diffCents) < VIEW_RANGE_CENTS + 20) {
        const x = cx + (diffCents * pxPerCent);

        const zoneWidth = 10 * pxPerCent;
        ctx.fillStyle = "rgba(0, 230, 118, 0.15)";
        ctx.fillRect(x - zoneWidth / 2, 0, zoneWidth, h);

        ctx.beginPath(); ctx.strokeStyle = "#555"; ctx.lineWidth = 1;
        ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();

        ctx.fillStyle = "#aaa"; ctx.font = "bold 14px sans-serif";
        ctx.fillText(`${targetLabelInfo.note}${targetLabelInfo.oct}`, x, h - 25);

        ctx.fillStyle = "#444"; ctx.font = "10px sans-serif";
        for (let c = -40; c <= 40; c += 10) {
          if (c === 0) continue;
          const subFreq = targetFreq * Math.pow(2, c / 1200);
          const subDiff = 1200 * Math.log2(subFreq / centerFreq);
          const subX = cx + (subDiff * pxPerCent);
          if (subX > 0 && subX < w) {
            ctx.beginPath(); ctx.strokeStyle = "#222"; ctx.lineWidth = 1;
            ctx.moveTo(subX, 0); ctx.lineTo(subX, h); ctx.stroke();
            if (Math.abs(subDiff) < VIEW_RANGE_CENTS) {
              ctx.fillText(c > 0 ? `+${c}` : c, subX, h - 10);
            }
          }
        }
      }
    }

    // --- Rows ---
    const row1H = h * 0.2;
    const row2H = h * 0.2;
    const row2Y = row1H;
    const mainY = row1H + row2H;

    // Draw Dynamic Algo Lines (Labels are drawn dynamically)
    this.drawAlgoSmooth('yin', centerFreq, pxPerCent, 0, row1H, "YIN");
    this.drawAlgoSmooth('mpm', centerFreq, pxPerCent, 0, row1H, "MPM");
    this.drawAlgoSmooth('fft', centerFreq, pxPerCent, 0, row1H, "HARM");

    this.drawAlgoSmooth('perc', centerFreq, pxPerCent, row2Y, row2H, "HUMAN");

    this.drawCenterLine(cx, h, true);

    // === 予測音程の描画 (Cyan Marker) ===
    if (this.predictionDisplay.confidence > 0.3 && this.predictionDisplay.predictedFreq > 0) {
      const predFreq = this.predictionDisplay.predictedFreq;
      const predDiff = 1200 * Math.log2(predFreq / centerFreq);

      // 画面内にある場合のみ描画
      if (Math.abs(predDiff) < VIEW_RANGE_CENTS) {
        const pxPerCent = w / (VIEW_RANGE_CENTS * 2);
        const predX = cx + (predDiff * pxPerCent);

        ctx.save();
        ctx.translate(predX, row1H + row2H + 10);

        // 三角形マーカー
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-5, 8);
        ctx.lineTo(5, 8);
        ctx.closePath();

        ctx.fillStyle = "cyan"; // Cyan for prediction
        ctx.fill();

        // 予測線 (点線)
        ctx.beginPath();
        ctx.strokeStyle = "rgba(0, 255, 255, 0.5)";
        ctx.setLineDash([2, 2]);
        ctx.moveTo(0, 8);
        ctx.lineTo(0, h - (row1H + row2H + 10)); // 下まで伸ばす
        ctx.stroke();

        ctx.restore();
      }
    }
  }

  drawAlgoSmooth(key, centerFreq, pxPerCent, y, h, label) {
    const stats = this.getSwayStats(key, centerFreq);
    const state = this.visualSwayState[key];

    const targetMinPx = stats.min * pxPerCent;
    const targetMaxPx = stats.max * pxPerCent;

    state.min += (targetMinPx - state.min) * 0.2;
    state.max += (targetMaxPx - state.max) * 0.2;

    const cx = this.els.canvas.width / 2;

    let currentFreq = (key === 'perc') ? this.perceivedFreq : this.rawAlgoFreqs[key];
    let currentDiffCents = 0;
    if (currentFreq > 0) {
      currentDiffCents = 1200 * Math.log2(currentFreq / centerFreq);
      if (Math.abs(currentDiffCents) > 100) currentDiffCents = 0;
    }
    const currentPx = currentDiffCents * pxPerCent;

    const bandX = cx + state.min;
    const bandW = state.max - state.min;

    if (bandW > 1) {
      this.ctx.fillStyle = "rgba(150, 150, 150, 0.25)";
      this.ctx.fillRect(bandX, y, bandW, h);
    }

    const lineX = cx + currentPx;

    if (lineX < -50 || lineX > this.els.canvas.width + 50) return;

    this.ctx.beginPath();
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    this.ctx.lineWidth = 2;
    this.ctx.moveTo(lineX, y);
    this.ctx.lineTo(lineX, y + h);
    this.ctx.stroke();

    this.ctx.fillStyle = "rgba(255,255,255,0.7)";
    this.ctx.font = "9px sans-serif";
    this.ctx.fillText(label, lineX + 4, y + h / 2);
  }

  drawCenterLine(x, h, isActive) {
    this.ctx.beginPath();
    this.ctx.strokeStyle = isActive ? "#ff1744" : "#333";
    this.ctx.lineWidth = 2;
    this.ctx.moveTo(x, 0);
    this.ctx.lineTo(x, h);
    this.ctx.stroke();
  }

  updateUpperUI(freq, confidence = 0) {
    if (!freq) return;
    const info = this.getPitchInfo(freq);
    if (!info) return;

    this.els.note.firstChild.textContent = info.note;
    this.els.oct.textContent = info.oct;

    const sign = info.cents >= 0 ? "+" : "";
    this.els.cents.textContent = `${sign}${info.cents.toFixed(1)}`;

    this.els.note.classList.add('active');
    if (Math.abs(info.cents) < 5) {
      this.els.note.classList.add('perfect');
      this.els.cents.style.color = "var(--accent-ok)";
    } else {
      this.els.note.classList.remove('perfect');
      this.els.cents.style.color = Math.abs(info.cents) < 15 ? "#00bcd4" : "var(--accent-warn)";
    }

    // 信頼度表示を更新
    this.updateConfidenceDisplay(confidence);
  }

  updateConfidenceDisplay(confidence) {
    if (!this.els.confidenceBar || !this.els.confidenceText) return;

    const percent = Math.round(confidence * 100);
    this.els.confidenceBar.style.setProperty('--confidence-level', `${percent}%`);
    this.els.confidenceText.textContent = `${percent}%`;

    // 信頼度に応じたクラス
    this.els.confidenceText.classList.remove('high', 'medium', 'low');
    if (confidence >= 0.8) {
      this.els.confidenceText.classList.add('high');
    } else if (confidence >= 0.5) {
      this.els.confidenceText.classList.add('medium');
    } else {
      this.els.confidenceText.classList.add('low');
    }
  }

  resetState() {
    this.stabilityCounter = 0;

    // UIテキストのリセット（完全消去）
    if (this.els.note) {
      this.els.note.innerHTML = '<span style="font-size: 0.8em; opacity: 0.5;">--</span>';
      this.els.note.classList.remove('active', 'perfect');
      this.els.note.style.color = "#ffffff";
    }
    if (this.els.oct) this.els.oct.textContent = "";
    if (this.els.cents) this.els.cents.textContent = "";

    // 信頼度表示をリセット
    this.updateConfidenceDisplay(0);

    this.currentStableFreq = 0;
    this.visualFreq = 0; // 針も戻す

    for (let k in this.algoHistory) this.algoHistory[k] = [];

    // ノイズフィルター状態もリセット
    if (this.noiseFilter) {
      this.noiseFilter.pitchHistory = [];
      this.noiseFilter.algoAgreementHistory = [];
      this.noiseFilter.qualityHistory = [];
      this.noiseFilter.pitchStartTime = 0;
      this.noiseFilter.lastConfirmedFreq = 0;
    }
  }

  resetSwayHistory() {
    for (let k in this.algoHistory) this.algoHistory[k] = [];
  }

  updateSwayHistory(key, freq) {
    if (!freq || freq <= 0) return;
    this.algoHistory[key].push(freq);
    if (this.algoHistory[key].length > this.config.visualHistorySize) {
      this.algoHistory[key].shift();
    }
  }

  getSwayStats(key, centerFreq) {
    const history = this.algoHistory[key];
    if (!history || history.length === 0 || centerFreq <= 0) {
      return { min: 0, max: 0 };
    }

    let minCents = Infinity;
    let maxCents = -Infinity;

    for (const freq of history) {
      if (freq > 0) {
        const cents = 1200 * Math.log2(freq / centerFreq);
        if (Math.abs(cents) < 100) {
          if (cents < minCents) minCents = cents;
          if (cents > maxCents) maxCents = cents;
        }
      }
    }

    if (minCents === Infinity) minCents = 0;
    if (maxCents === -Infinity) maxCents = 0;

    return { min: minCents, max: maxCents };
  }

  // ============================================
  //  Algorithms & Logic
  // ============================================


  getPitchInfo(f) {
    if (!f || f <= 0) return null;

    const a4 = this.getA4();
    const notation = this.getNotation();

    const semitones = 12 * Math.log2(f / a4);
    const midi = Math.round(semitones) + 69;
    const ideal = a4 * Math.pow(2, (midi - 69) / 12);
    const cents = 1200 * Math.log2(f / ideal);

    let displayNote = "";
    let displayOctave = Math.floor(midi / 12) - 1;

    let offset = 0;
    switch (notation) {
      case "JP_Bb": offset = 2; break;
      case "JP_Eb": offset = 9; break;
      case "JP_F": offset = 7; break;
      default: offset = 0; break;
    }

    const transposedMidi = midi + offset;
    const noteIndex = transposedMidi % 12;

    if (notation.startsWith("JP")) {
      displayNote = this.NOTES_JP[noteIndex];
    } else {
      displayNote = this.NOTES_EN[noteIndex];
    }

    displayOctave = Math.floor(transposedMidi / 12) - 1;

    return { note: displayNote, oct: displayOctave, cents, midi, rawMidi: midi };
  }

  calculateRMS(buf) {
    let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] * buf[i];
    return Math.sqrt(s / (buf.length / 4));
  }


}

// グローバルに公開して SPA の動的ロードから参照可能にする
if (typeof window !== 'undefined' && !window.TunerModule) {
  window.TunerModule = TunerModule;
}