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
      badges: {
        signal: q('#signalBadge'),
        stable: q('#stableBadge'),
        fast: q('#fastModeBadge')
      }
    };
    this.ctx = this.els.canvas.getContext('2d');
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
      this.els.canvas.width = parent.clientWidth;
      this.els.canvas.height = parent.clientHeight;
    }
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
  setupAudioIfNeeded() {
    // 既に初期化済みならスキップ
    if (this.analyser) return true;

    const gam = window.globalAudioManager;
    if (!gam || !gam.audioContext) {
      return false;
    }

    try {
      this.audioContext = gam.audioContext;

      // Tuner用の専用Analyserを作成
      this.timeBuf = new Float32Array(this.config.bufferSize);
      this.freqBuf = new Uint8Array(this.config.bufferSize / 2);
      this.yinBuffer = new Float32Array(this.config.bufferSize / 2);
      this.mpmNsdf = new Float32Array(this.config.bufferSize);

      // フィルターとAnalyserを作成
      this.filter = this.audioContext.createBiquadFilter();
      this.filter.type = "bandpass";
      this.filter.frequency.value = 800;
      this.filter.Q.value = 0.3;

      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.config.bufferSize;

      this.filter.connect(this.analyser);

      // ソースを設定
      this.setupAudioSource();

      return true;
    } catch (e) {
      console.error("Tuner Audio Init Failed:", e);
      return false;
    }
  }

  setupAudioSource() {
    const gam = window.globalAudioManager;
    if (!gam || !this.filter) return;

    const isFileMode = gam.isFileMode;

    if (isFileMode) {
      // ファイルモードに切り替え
      if (this.currentSourceMode !== 'file') {
        // 既存のマイクソースを切断
        try { if (this.micSource) this.micSource.disconnect(); } catch (e) { }
        this.micSource = null;
        this.currentSourceMode = 'file';
      }
    } else {
      // マイクモード
      const stream = gam.getMicStream();

      if (stream) {
        // マイクストリームが利用可能
        if (!this.micSource) {
          // まだ接続されていなければ接続
          this.micSource = this.audioContext.createMediaStreamSource(stream);
          this.micSource.connect(this.filter);
          this.currentSourceMode = 'mic';
        }
      } else {
        // マイクストリームがまだ無い場合は待機状態
        // currentSourceModeは更新しない（次回のループで再試行）
        if (this.currentSourceMode === 'file') {
          // ファイルモードからマイクモードへの切り替え時は一旦リセット
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

  processLoop() {
    if (!this.isRunning) return;
    this.animationId = requestAnimationFrame(() => this.processLoop());

    // フリーズ中は描画のみ、データ更新しない
    if (this.isFrozen()) {
      this.draw();
      return;
    }

    // AudioContextが利用可能になったらセットアップを試みる
    this.setupAudioIfNeeded();

    // ソースモードの切替を検出
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

    // RMS Gate (Gainを感度として使用)
    const rms = this.calculateRMS(this.timeBuf);
    const minRMS = this.getMinRMS();
    if (rms < minRMS) {
      this.resetState();
      this.draw();
      return;
    }

    const sr = this.audioContext.sampleRate;

    // === PitchEngine統合 ===
    // PitchEngineが利用可能な場合は使用
    if (window.pitchEngine) {
      window.pitchEngine.setA4(this.getA4());
      const pitchResult = window.pitchEngine.analyze(this.timeBuf, sr);

      if (pitchResult && pitchResult.freq && pitchResult.confidence > 0.3) {
        // PitchEngineの結果を使用
        this.perceivedFreq = pitchResult.freq;
        this.rawAlgoFreqs = {
          yin: pitchResult.freq,
          mpm: pitchResult.freq,
          fft: pitchResult.freq
        };

        // ビブラート情報を保存
        this.vibratoState = pitchResult.vibrato;

        if (this.currentStableFreq > 0) {
          const diffRatio = pitchResult.freq / this.currentStableFreq;
          if (diffRatio > 1.06 || diffRatio < 0.94) {
            this.resetSwayHistory();
          }
        }

        this.currentStableFreq = pitchResult.freq;
        this.updateUpperUI(pitchResult.freq);

        // Update History
        this.updateSwayHistory('yin', pitchResult.freq);
        this.updateSwayHistory('mpm', pitchResult.freq);
        this.updateSwayHistory('fft', pitchResult.freq);
      } else {
        // 信頼度が低い場合はリセット
        this.resetState();
      }

      this.draw();
      return;
    }

    // === フォールバック: 従来の処理 ===
    const yinRes = this.runYIN(this.timeBuf, sr);
    const mpmRes = this.runMPM(this.timeBuf, sr);
    const fftRes = this.runFFT_Harmonic(this.freqBuf, sr);
    const percRes = this.calculatePerceivedPitch(this.freqBuf, sr, fftRes.freq);

    this.perceivedFreq = percRes.freq;
    this.rawAlgoFreqs = { yin: yinRes.freq, mpm: mpmRes.freq, fft: fftRes.freq };

    // ===== 高度なノイズフィルタリングを適用 =====
    const noiseFilterResult = this.applyAdvancedNoiseFilter(
      yinRes, mpmRes, fftRes, rms, this.freqBuf, sr
    );

    // ノイズフィルタを通過しなかった場合は表示を更新しない
    if (!noiseFilterResult.valid) {
      // ただし継続的に失敗する場合のみリセット
      if (noiseFilterResult.reason === 'transient') {
        // 突発音は一時的なのでUI維持
      } else {
        // 品質が低い場合は徐々にフェードアウト
        this.noiseFilter.qualityHistory.length > 5 && this.resetState();
      }
      this.draw();
      return;
    }

    // フィルタを通過した周波数で処理続行
    const finalRes = this.combineAlgorithmsAdaptive(yinRes, mpmRes, fftRes);
    const stableRes = this.adaptiveStabilizer(finalRes, fftRes.prob);

    if (stableRes && stableRes.freq > 0) {
      if (this.currentStableFreq > 0) {
        const diffRatio = stableRes.freq / this.currentStableFreq;
        if (diffRatio > 1.06 || diffRatio < 0.94) {
          this.resetSwayHistory();
        }
      }

      this.currentStableFreq = stableRes.freq;
      this.updateUpperUI(stableRes.freq);
    }

    // Update History
    this.updateSwayHistory('yin', yinRes.freq);
    this.updateSwayHistory('mpm', mpmRes.freq);
    this.updateSwayHistory('fft', fftRes.freq);
    this.updateSwayHistory('perc', percRes.freq);

    this.draw();
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

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

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

    ctx.strokeStyle = "#222";
    ctx.beginPath(); ctx.moveTo(0, row1H); ctx.lineTo(w, row1H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, mainY); ctx.lineTo(w, mainY); ctx.stroke();

    ctx.fillStyle = "#666"; ctx.font = "10px sans-serif";
    ctx.fillText("ALGO RAW", 40, row1H - 5);

    this.drawAlgoSmooth('yin', centerFreq, pxPerCent, 0, row1H, "YIN");
    this.drawAlgoSmooth('mpm', centerFreq, pxPerCent, 0, row1H, "MPM");
    this.drawAlgoSmooth('fft', centerFreq, pxPerCent, 0, row1H, "HARM");

    ctx.fillStyle = "#e040fb";
    ctx.fillText("PERCEIVED", 40, row2Y + row2H - 5);
    this.drawAlgoSmooth('perc', centerFreq, pxPerCent, row2Y, row2H, "HUMAN");

    this.drawCenterLine(cx, h, true);
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

  updateUpperUI(freq) {
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
  }

  resetState() {
    this.stabilityCounter = 0;
    this.els.badges.signal.classList.remove('active');
    this.els.badges.stable.classList.remove('active');
    this.els.badges.fast.classList.remove('active');

    this.els.note.classList.remove('active', 'perfect');
    this.els.note.style.color = "#ffffff";

    this.currentStableFreq = 0;
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
    const hist = this.algoHistory[key];
    if (hist.length < 2) return { min: 0, max: 0 };

    let minCents = 0;
    let maxCents = 0;

    for (let f of hist) {
      if (!f || f <= 0) continue;

      const c = 1200 * Math.log2(f / centerFreq);

      if (Math.abs(c) > 100) continue;

      if (c < minCents) minCents = c;
      if (c > maxCents) maxCents = c;
    }

    return { min: minCents, max: maxCents };
  }

  // ============================================
  //  高度な雑音フィルタリング (Advanced Noise Rejection)
  // ============================================

  /**
   * 突発音（トランジェント）を検出
   * 急激な音量変化を検出し、一定フレーム間無視する
   */
  detectTransient(currentRMS) {
    const nf = this.noiseFilter;
    const cfg = this.config;

    // スムージングされたRMSを更新
    nf.smoothedRMS = nf.smoothedRMS * (1 - cfg.envelopeSmoothingFactor)
      + currentRMS * cfg.envelopeSmoothingFactor;

    // 急激な音量上昇を検出
    if (nf.prevRMS > 0 && currentRMS > nf.prevRMS * cfg.transientThreshold) {
      nf.isTransient = true;
      nf.transientHoldCounter = cfg.transientHoldFrames;
    }

    // ホールドカウンターの減算
    if (nf.transientHoldCounter > 0) {
      nf.transientHoldCounter--;
      if (nf.transientHoldCounter === 0) {
        nf.isTransient = false;
      }
    }

    // ピークRMSを追跡
    if (currentRMS > nf.peakRMS) {
      nf.peakRMS = currentRMS;
    } else {
      nf.peakRMS = nf.peakRMS * 0.995; // ゆっくり減衰
    }

    nf.prevRMS = currentRMS;

    return nf.isTransient;
  }

  /**
   * 倍音構造を検証
   * 楽器音には倍音が存在するため、倍音構造がない音は雑音として除外
   */
  validateHarmonicStructure(freqData, fundamentalFreq, sampleRate) {
    if (!fundamentalFreq || fundamentalFreq <= 0) return { valid: false, score: 0 };

    const cfg = this.config;
    const binSize = sampleRate / (freqData.length * 2);

    // 基音のビン位置と強度を取得
    const fundBin = Math.round(fundamentalFreq / binSize);
    if (fundBin < 0 || fundBin >= freqData.length) return { valid: false, score: 0 };

    const fundStrength = freqData[fundBin];
    if (fundStrength < 20) return { valid: false, score: 0 };

    let harmonicsFound = 1; // 基音をカウント
    let totalHarmonicStrength = fundStrength;
    let harmonicDetails = [{ n: 1, freq: fundamentalFreq, strength: fundStrength }];

    // 2〜8倍音をチェック
    for (let n = 2; n <= 8; n++) {
      const harmonicFreq = fundamentalFreq * n;
      if (harmonicFreq > sampleRate / 2) break;

      const expectedBin = Math.round(harmonicFreq / binSize);
      if (expectedBin >= freqData.length) break;

      // 許容範囲内でピークを探索
      const tolerance = Math.max(2, Math.round(expectedBin * cfg.harmonicTolerance));
      let maxStrength = 0;
      let maxBin = expectedBin;

      for (let b = Math.max(0, expectedBin - tolerance);
        b <= Math.min(freqData.length - 1, expectedBin + tolerance); b++) {
        if (freqData[b] > maxStrength) {
          maxStrength = freqData[b];
          maxBin = b;
        }
      }

      // 基音に対する相対強度をチェック
      const relativeStrength = maxStrength / fundStrength;
      if (relativeStrength >= cfg.harmonicMinStrength) {
        harmonicsFound++;
        totalHarmonicStrength += maxStrength;
        harmonicDetails.push({
          n,
          freq: maxBin * binSize,
          strength: maxStrength,
          relativeStrength
        });
      }
    }

    // 倍音スコアを計算（見つかった倍音の数と強度に基づく）
    const harmonicScore = harmonicsFound >= cfg.harmonicMinCount
      ? (harmonicsFound / 6) * (totalHarmonicStrength / (fundStrength * harmonicsFound))
      : 0;

    return {
      valid: harmonicsFound >= cfg.harmonicMinCount,
      score: Math.min(1, harmonicScore),
      harmonicsFound,
      details: harmonicDetails
    };
  }

  /**
   * アルゴリズム間の一致度を検証
   * 複数のピッチ検出アルゴリズムが同じ周波数を示しているか確認
   */
  checkAlgorithmAgreement(yinRes, mpmRes, fftRes) {
    const cfg = this.config;
    const freqs = [
      { name: 'yin', freq: yinRes.freq, prob: yinRes.prob },
      { name: 'mpm', freq: mpmRes.freq, prob: mpmRes.prob },
      { name: 'fft', freq: fftRes.freq, prob: fftRes.prob }
    ].filter(r => r.freq > 0 && r.prob > 0.3);

    if (freqs.length < 2) {
      return { agreement: false, score: 0, consensusFreq: 0 };
    }

    // すべてのペアで一致度をチェック
    let agreementPairs = 0;
    let totalPairs = 0;
    let freqSum = 0;
    let weightSum = 0;

    for (let i = 0; i < freqs.length; i++) {
      for (let j = i + 1; j < freqs.length; j++) {
        totalPairs++;
        const ratio = freqs[i].freq / freqs[j].freq;
        // 同じ周波数またはオクターブ関係をチェック
        const isMatch = Math.abs(1 - ratio) < cfg.algoAgreementThreshold ||
          Math.abs(0.5 - ratio) < cfg.algoAgreementThreshold ||
          Math.abs(2 - ratio) < cfg.algoAgreementThreshold;
        if (isMatch) agreementPairs++;
      }

      // 重み付き平均周波数を計算
      freqSum += freqs[i].freq * freqs[i].prob;
      weightSum += freqs[i].prob;
    }

    const agreementScore = agreementPairs / totalPairs;
    const consensusFreq = weightSum > 0 ? freqSum / weightSum : 0;

    // 一致履歴を更新
    this.noiseFilter.algoAgreementHistory.push(agreementScore);
    if (this.noiseFilter.algoAgreementHistory.length > 10) {
      this.noiseFilter.algoAgreementHistory.shift();
    }

    return {
      agreement: agreementPairs >= cfg.minAlgoAgreement - 1,
      score: agreementScore,
      consensusFreq,
      matchingAlgos: freqs.length
    };
  }

  /**
   * 音程の継続時間を追跡し、一貫性を検証
   */
  trackPitchDuration(freq, timestamp) {
    const cfg = this.config;
    const nf = this.noiseFilter;

    if (!freq || freq <= 0) {
      // 無効な周波数：履歴をリセット
      nf.pitchHistory = [];
      nf.pitchStartTime = 0;
      return { valid: false, durationMs: 0, consistent: false };
    }

    // 履歴に追加
    nf.pitchHistory.push({ freq, timestamp });

    // 古いエントリを削除（500ms以上前）
    const cutoff = timestamp - 500;
    while (nf.pitchHistory.length > 0 && nf.pitchHistory[0].timestamp < cutoff) {
      nf.pitchHistory.shift();
    }

    if (nf.pitchHistory.length < cfg.pitchConsistencyFrames) {
      return { valid: false, durationMs: 0, consistent: false };
    }

    // 一貫性チェック：最近のフレームで周波数が安定しているか
    const recentEntries = nf.pitchHistory.slice(-cfg.pitchConsistencyFrames);
    const avgFreq = recentEntries.reduce((s, e) => s + e.freq, 0) / recentEntries.length;

    let consistent = true;
    for (const entry of recentEntries) {
      const ratio = entry.freq / avgFreq;
      if (Math.abs(1 - ratio) > cfg.algoAgreementThreshold) {
        consistent = false;
        break;
      }
    }

    // 継続時間を計算
    const durationMs = timestamp - nf.pitchHistory[0].timestamp;

    // 最低継続時間を満たしているかチェック
    const meetsMinDuration = durationMs >= cfg.minPitchDurationMs;

    return {
      valid: consistent && meetsMinDuration,
      durationMs,
      consistent,
      avgFreq
    };
  }

  /**
   * 総合的な品質スコアを計算
   * すべてのフィルタリング結果を統合して最終判定
   */
  calculateQualityScore(harmonicResult, agreementResult, durationResult, rms) {
    const nf = this.noiseFilter;

    // 各要素のスコア（0〜1）
    const harmonicScore = harmonicResult.valid ? harmonicResult.score : 0;
    const agreementScore = agreementResult.agreement ? agreementResult.score : 0;
    const durationScore = durationResult.valid ? Math.min(1, durationResult.durationMs / 200) : 0;
    const envelopeScore = nf.peakRMS > 0 ? Math.min(1, rms / nf.peakRMS) : 0;

    // 重み付きスコア計算
    const weights = {
      harmonic: 0.35,    // 倍音構造が最重要
      agreement: 0.30,   // アルゴリズム一致度
      duration: 0.20,    // 継続時間
      envelope: 0.15     // エンベロープ
    };

    const totalScore =
      harmonicScore * weights.harmonic +
      agreementScore * weights.agreement +
      durationScore * weights.duration +
      envelopeScore * weights.envelope;

    // 履歴に追加
    nf.qualityHistory.push(totalScore);
    if (nf.qualityHistory.length > 10) {
      nf.qualityHistory.shift();
    }

    // スムージングされたスコア
    const smoothedScore = nf.qualityHistory.reduce((a, b) => a + b, 0) / nf.qualityHistory.length;

    return {
      raw: totalScore,
      smoothed: smoothedScore,
      components: { harmonicScore, agreementScore, durationScore, envelopeScore },
      passed: totalScore > 0.35 && harmonicResult.valid
    };
  }

  /**
   * 高度なノイズフィルタリングを適用
   * すべてのチェックを実行し、有効な音程のみを通過させる
   */
  applyAdvancedNoiseFilter(yinRes, mpmRes, fftRes, rms, freqData, sampleRate) {
    const timestamp = performance.now();

    // 1. 突発音チェック
    const isTransient = this.detectTransient(rms);
    if (isTransient) {
      return {
        valid: false,
        reason: 'transient',
        freq: 0
      };
    }

    // 2. 最も信頼性の高い周波数を選択
    const candidateFreq = this.selectBestCandidate(yinRes, mpmRes, fftRes);
    if (!candidateFreq || candidateFreq <= 0) {
      return {
        valid: false,
        reason: 'no_candidate',
        freq: 0
      };
    }

    // 3. 倍音構造検証
    const harmonicResult = this.validateHarmonicStructure(freqData, candidateFreq, sampleRate);

    // 4. アルゴリズム一致度検証
    const agreementResult = this.checkAlgorithmAgreement(yinRes, mpmRes, fftRes);

    // 5. 継続時間追跡
    const durationResult = this.trackPitchDuration(candidateFreq, timestamp);

    // 6. 総合品質スコア
    const qualityResult = this.calculateQualityScore(
      harmonicResult, agreementResult, durationResult, rms
    );

    return {
      valid: qualityResult.passed,
      freq: qualityResult.passed ? candidateFreq : 0,
      quality: qualityResult,
      harmonic: harmonicResult,
      agreement: agreementResult,
      duration: durationResult,
      reason: qualityResult.passed ? 'passed' : 'low_quality'
    };
  }

  /**
   * 最も信頼性の高い候補周波数を選択
   */
  selectBestCandidate(yinRes, mpmRes, fftRes) {
    const candidates = [
      { freq: yinRes.freq, prob: yinRes.prob, weight: 1.2 },
      { freq: mpmRes.freq, prob: mpmRes.prob, weight: 1.0 },
      { freq: fftRes.freq, prob: fftRes.prob, weight: 0.8 }
    ].filter(c => c.freq > 0 && c.prob > 0.3);

    if (candidates.length === 0) return 0;

    // 重み付き選択
    candidates.sort((a, b) => (b.prob * b.weight) - (a.prob * a.weight));
    return candidates[0].freq;
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

  runYIN(buffer, sr) {
    const half = buffer.length / 2; const th = 0.15;
    const minTau = Math.floor(sr / 4000), maxTau = Math.floor(sr / 30);
    this.yinBuffer.fill(0);
    let rSum = 0, foundTau = -1;
    for (let t = 1; t < maxTau; t++) {
      if (t < minTau) continue;
      let s = 0; for (let i = 0; i < half; i += 2) { const d = buffer[i] - buffer[i + t]; s += d * d; }
      rSum += s; const v = (rSum === 0) ? 1 : (s * t / rSum); this.yinBuffer[t] = v;
      if (foundTau === -1 && v < th) {
        while (t + 1 < maxTau && this.yinBuffer[t + 1] < this.yinBuffer[t]) t++;
        foundTau = t; break;
      }
    }
    if (foundTau === -1) {
      let minV = 100; for (let t = minTau; t < maxTau; t++) if (this.yinBuffer[t] < minV) { minV = this.yinBuffer[t]; foundTau = t; }
    }
    const conf = 1 - (this.yinBuffer[foundTau] || 1);
    if (foundTau <= 0 || conf < 0.15) return { freq: 0, prob: 0 };
    const t = foundTau;
    if (t < 1 || t >= this.yinBuffer.length - 1) return { freq: sr / t, prob: conf };
    const s0 = this.yinBuffer[t], s1 = this.yinBuffer[t - 1], s2 = this.yinBuffer[t + 1];
    const adj = (s2 - s1) / (2 * (2 * s0 - s2 - s1));
    return { freq: sr / (t + adj), prob: conf };
  }

  runMPM(buffer, sr) {
    const len = buffer.length; const minTau = Math.floor(sr / 4000), maxTau = Math.floor(sr / 30);
    for (let t = minTau; t < maxTau; t++) {
      let acf = 0, div = 0, limit = Math.min(len - t, 1024);
      for (let i = 0; i < limit; i += 2) { acf += buffer[i] * buffer[i + t]; div += buffer[i] * buffer[i] + buffer[i + t] * buffer[i + t]; }
      this.mpmNsdf[t] = (div === 0) ? 0 : (2 * acf / div);
    }
    let maxP = 0; for (let t = minTau; t < maxTau; t++) if (this.mpmNsdf[t] > maxP) maxP = this.mpmNsdf[t];
    const th = maxP * 0.9; let bestTau = -1;
    for (let t = minTau + 1; t < maxTau - 1; t++) {
      if (this.mpmNsdf[t] > this.mpmNsdf[t - 1] && this.mpmNsdf[t] > this.mpmNsdf[t + 1] && this.mpmNsdf[t] >= th) { bestTau = t; break; }
    }
    if (bestTau <= 0) return { freq: 0, prob: 0 };
    const t = bestTau;
    const s0 = this.mpmNsdf[t], s1 = this.mpmNsdf[t - 1], s2 = this.mpmNsdf[t + 1];
    const adj = (s2 - s1) / (2 * (2 * s0 - s2 - s1));
    return { freq: sr / (t + adj), prob: this.mpmNsdf[t] };
  }

  runFFT_Harmonic(freqData, sr) {
    const peaks = [];
    const binSize = sr / (freqData.length * 2);
    const th = 30;
    for (let i = 2; i < freqData.length - 2; i++) {
      if (freqData[i] > th) {
        if (freqData[i] > freqData[i - 1] && freqData[i] > freqData[i + 1]) {
          const d = (freqData[i + 1] - freqData[i - 1]) / (2 * (2 * freqData[i] - freqData[i + 1] - freqData[i - 1]));
          peaks.push({ freq: (i + d) * binSize, amp: freqData[i] });
        }
      }
    }
    if (peaks.length < 2) return { freq: 0, prob: 0 };
    peaks.sort((a, b) => b.amp - a.amp);
    let best = 0, maxS = 0;
    const cands = peaks.slice(0, 5).map(p => p.freq);
    const ext = []; cands.forEach(c => { ext.push(c); ext.push(c / 2); });
    for (let f of ext) {
      if (f < 50) continue;
      let s = 0, h = 0;
      for (let n = 1; n <= 5; n++) {
        const t = f * n;
        const m = peaks.find(p => Math.abs(p.freq - t) / t < 0.05);
        if (m) { s += m.amp; h++; }
      }
      if (h >= 2) {
        const tot = s * h * (1 + 500 / f);
        if (tot > maxS) { maxS = tot; best = f; }
      }
    }
    return { freq: best, prob: Math.min(maxS / 3000, 1.0) };
  }

  getAWeightingFactor(f) {
    const f2 = f * f;
    const R_A = (12194 ** 2 * f ** 4) /
      ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
    return R_A;
  }

  calculatePerceivedPitch(freqData, sampleRate, physicalHint) {
    const binSize = sampleRate / (freqData.length * 2);
    const weightedPeaks = [];
    const threshold = 10;
    for (let i = 2; i < freqData.length - 2; i++) {
      if (freqData[i] > threshold) {
        if (freqData[i] > freqData[i - 1] && freqData[i] > freqData[i + 1]) {
          const freq = i * binSize;
          const weight = this.getAWeightingFactor(freq);
          const weightedAmp = freqData[i] * weight;
          const delta = (freqData[i + 1] - freqData[i - 1]) / (2 * (2 * freqData[i] - freqData[i + 1] - freqData[i - 1]));
          const refinedFreq = (i + delta) * binSize;
          weightedPeaks.push({ freq: refinedFreq, amp: weightedAmp });
        }
      }
    }
    if (weightedPeaks.length < 2) return { freq: 0, prob: 0 };
    weightedPeaks.sort((a, b) => b.amp - a.amp);
    let bestFreq = 0; let maxScore = 0;
    const candidates = weightedPeaks.slice(0, 5).map(p => p.freq);
    if (physicalHint > 0) candidates.push(physicalHint);
    const searchSpace = [];
    candidates.forEach(f => { searchSpace.push(f); searchSpace.push(f / 2); });
    const uniqueCandidates = [...new Set(searchSpace.map(f => Math.round(f * 10) / 10))];
    for (let fund of uniqueCandidates) {
      if (fund < 40) continue;
      let score = 0; let hits = 0;
      for (let h = 1; h <= 6; h++) {
        const target = fund * h;
        const match = weightedPeaks.find(p => Math.abs(p.freq - target) / target < 0.04);
        if (match) { score += match.amp; hits++; }
      }
      if (hits >= 2) {
        if (score > maxScore) { maxScore = score; bestFreq = fund; }
      }
    }
    return { freq: bestFreq, prob: Math.min(maxScore / 1000, 1.0) };
  }

  combineAlgorithmsAdaptive(yin, mpm, fft) {
    if (fft.prob < 0.25 && yin.prob < 0.85) return { freq: 0, strategy: "Noise Rejection" };
    let candidate = (yin.prob >= mpm.prob) ? yin : mpm;
    if (fft.prob > 0.4) {
      const ratio = candidate.freq / fft.freq;
      if (Math.abs(ratio - 2.0) < 0.2) return { freq: candidate.freq / 2, prob: candidate.prob, strategy: "Octave Fix" };
      if (Math.abs(ratio - 3.0) < 0.2) return { freq: candidate.freq / 3, prob: candidate.prob, strategy: "Harmonic Fix" };
    }
    return { ...candidate, strategy: "Precision" };
  }

  adaptiveStabilizer(currentRes, harmonicQuality) {
    if (!currentRes || currentRes.freq <= 0 || currentRes.strategy === "Noise Rejection") {
      this.stabilityCounter = 0; return null;
    }
    this.els.badges.signal.classList.add('active');
    const isHighQuality = (currentRes.prob > this.config.confidenceThreshold) || (harmonicQuality > 0.7);
    if (this.lastValidFreq > 0) {
      const ratio = currentRes.freq / this.lastValidFreq;
      if (Math.abs(1 - ratio) >= this.config.freqTolerance) {
        if (isHighQuality) {
          this.lastValidFreq = currentRes.freq;
          this.stabilityCounter = 2;
          this.els.badges.fast.classList.add('active');
          return { ...currentRes, strategy: "Fast" };
        } else {
          this.stabilityCounter = 0;
          this.lastValidFreq = currentRes.freq;
          this.els.badges.fast.classList.remove('active');
          return null;
        }
      } else {
        this.stabilityCounter++;
        this.els.badges.fast.classList.remove('active');
      }
    } else {
      this.lastValidFreq = currentRes.freq;
      this.stabilityCounter = isHighQuality ? 2 : 1;
    }
    if (this.stabilityCounter >= 2) {
      this.els.badges.stable.classList.add('active');
      this.stabilityCounter = 5;
      return currentRes;
    } else {
      this.els.badges.stable.classList.remove('active');
      return null;
    }
  }
}

// グローバルに公開して SPA の動的ロードから参照可能にする
if (typeof window !== 'undefined' && !window.TunerModule) {
  window.TunerModule = TunerModule;
}