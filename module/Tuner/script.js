/**
 * Pro Vision Tuner Module
 * SPA対応・AudioContext共有対応版
 */
class TunerModule {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) throw new Error(`Container #${containerId} not found.`);

    // --- Configuration ---
    this.config = {
      bufferSize: 4096,
      downsampleRate: 4,     // 48kHz -> 12kHz
      a4: 442,
      notationMode: 'C',
      freqTolerance: 0.03,
      confidenceThreshold: 0.92,
      visualHistorySize: 50, // 揺らぎ可視化用の履歴サイズ
      minRMS: 0.012          // 反応する音量の下限 (初期値)
    };

    // --- State ---
    this.audioContext = null;
    this.analyser = null;
    this.isRunning = false;
    this.animationId = null;
    this.resizeObserver = null;

    // Buffers
    this.timeBuf = null;
    this.freqBuf = null;
    this.yinBuffer = null;
    this.mpmNsdf = null;

    // Analysis State
    this.lastValidFreq = 0;
    this.stabilityCounter = 0;
    
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
      a4Input: q('#a4Input'),
      gateInput: q('#gateInput'), // ノイズゲート入力欄
      notationSelect: q('#notationSelect'),
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
    this.setupEvents();
    this.handleResize();
    
    // Canvasのリサイズ監視
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    const canvasParent = this.els.canvas && this.els.canvas.parentElement;
    if (canvasParent) this.resizeObserver.observe(canvasParent);

    // 初期描画
    this.draw();
  }

  dispose() {
    this.stop();
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  setupEvents() {
    this.els.a4Input.addEventListener('change', (e) => {
      this.config.a4 = Number(e.target.value) || 442;
      if (this.currentStableFreq > 0) this.updateUpperUI(this.currentStableFreq);
    });

    this.els.gateInput.addEventListener('change', (e) => {
      this.config.minRMS = Number(e.target.value) || 0.012;
    });

    this.els.notationSelect.addEventListener('change', (e) => {
      this.config.notationMode = e.target.value;
      if (this.currentStableFreq > 0) this.updateUpperUI(this.currentStableFreq);
    });

    // ユーザー操作トリガーで Audio を初期化（ブラウザの自動再生ポリシー対策）
    if (this.container && !this._initClickBound) {
      this.container.addEventListener('click', () => this.initAudio(), { once: true });
      this._initClickBound = true;
    }
  }

  handleResize() {
    const parent = this.els.canvas.parentElement;
    if (parent) {
      this.els.canvas.width = parent.clientWidth;
      this.els.canvas.height = parent.clientHeight;
    }
  }

  // ============================================
  //  Audio Setup
  // ============================================

  async initAudio(sharedContext = null, sharedStream = null) {
    if (this.isRunning) return;

    try {
      this.audioContext = sharedContext || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      let stream = sharedStream;

      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { 
            echoCancellation: false, 
            autoGainControl: false, 
            noiseSuppression: false, 
            channelCount: 1 
          }
        });
      }

      this.timeBuf = new Float32Array(this.config.bufferSize);
      this.freqBuf = new Uint8Array(this.config.bufferSize / 2);
      this.yinBuffer = new Float32Array(this.config.bufferSize / 2);
      this.mpmNsdf = new Float32Array(this.config.bufferSize);

      const source = this.audioContext.createMediaStreamSource(stream);
      const filter = this.audioContext.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 800;
      filter.Q.value = 0.3;

      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.config.bufferSize;

      source.connect(filter);
      filter.connect(this.analyser);

      this.isRunning = true;
      this.processLoop();
      
    } catch (e) {
      console.error("Tuner Audio Init Failed:", e);
      alert("マイクの初期化に失敗しました。");
    }
  }

  stop() {
    this.isRunning = false;
    if (this.animationId) cancelAnimationFrame(this.animationId);
  }

  // ============================================
  //  Processing Loop
  // ============================================

  processLoop() {
    if (!this.isRunning) return;
    this.animationId = requestAnimationFrame(() => this.processLoop());

    this.analyser.getFloatTimeDomainData(this.timeBuf);
    this.analyser.getByteFrequencyData(this.freqBuf);

    // RMS Gate
    const rms = this.calculateRMS(this.timeBuf);
    if (rms < this.config.minRMS) {
      this.resetState();
      this.draw(); 
      return;
    }

    const sr = this.audioContext.sampleRate;

    const yinRes = this.runYIN(this.timeBuf, sr);
    const mpmRes = this.runMPM(this.timeBuf, sr);
    const fftRes = this.runFFT_Harmonic(this.freqBuf, sr);
    const percRes = this.calculatePerceivedPitch(this.freqBuf, sr, fftRes.freq);

    this.perceivedFreq = percRes.freq;
    this.rawAlgoFreqs = { yin: yinRes.freq, mpm: mpmRes.freq, fft: fftRes.freq };

    const finalRes = this.combineAlgorithmsAdaptive(yinRes, mpmRes, fftRes);
    const stableRes = this.adaptiveStabilizer(finalRes, fftRes.prob);

    if (stableRes && stableRes.freq > 0) {
      // --- 追加・変更箇所: 音程変化時の履歴リセット処理 ---
      // 前回の安定値と比べて半音以上（100セント以上）変わったら履歴を消す
      // これにより、帯が「ビヨーン」と伸びるのを防ぎます
      if (this.currentStableFreq > 0) {
        const diffRatio = stableRes.freq / this.currentStableFreq;
        // 半音(約1.059)以上の変化かチェック
        if (diffRatio > 1.06 || diffRatio < 0.94) {
           this.resetSwayHistory();
        }
      }
      // ------------------------------------------------

      this.currentStableFreq = stableRes.freq;
      this.updateUpperUI(stableRes.freq);
    }

    // Update History (リセット判定の後に行う)
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

    // --- 1. Grid & Green Zone ---
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";

    for (let i = -3; i <= 3; i++) {
      const targetRawMidi = centerInfo.rawMidi + i;
      const targetFreq = this.config.a4 * Math.pow(2, (targetRawMidi - 69) / 12);
      const targetLabelInfo = this.getPitchInfo(targetFreq);
      
      const diffCents = 1200 * Math.log2(targetFreq / centerFreq);
      
      if (Math.abs(diffCents) < VIEW_RANGE_CENTS + 20) {
        const x = cx + (diffCents * pxPerCent);

        const zoneWidth = 10 * pxPerCent; 
        ctx.fillStyle = "rgba(0, 230, 118, 0.15)";
        ctx.fillRect(x - zoneWidth/2, 0, zoneWidth, h);

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

    // px単位のターゲット値 (中心からの相対距離)
    const targetMinPx = stats.min * pxPerCent;
    const targetMaxPx = stats.max * pxPerCent;

    // 滑らかな補間 (Lerp)
    // 0.2 程度で素早く、かつ滑らかに追従させます
    state.min += (targetMinPx - state.min) * 0.2;
    state.max += (targetMaxPx - state.max) * 0.2;

    // 画面中央のX座標
    const cx = this.els.canvas.width / 2;

    // 現在の計算値 (白線の位置)
    // minとmaxの中間ではなく、最新の値を描画したい場合は rawAlgoFreqs を使いますが
    // ここでは帯の中心付近に線を表示するロジックとします
    // もし「最新の値」を白線にしたい場合は別途計算が必要ですが、
    // 帯の中に最新値があることは保証されているので、帯の重心または最新値を使います。
    // 今回は「最新値」に白線を引く形にします。
    
    // 最新値の計算
    let currentFreq = (key === 'perc') ? this.perceivedFreq : this.rawAlgoFreqs[key];
    let currentDiffCents = 0;
    if (currentFreq > 0) {
      currentDiffCents = 1200 * Math.log2(currentFreq / centerFreq);
      // 外れ値キャップ
      if(Math.abs(currentDiffCents) > 100) currentDiffCents = 0; 
    }
    const currentPx = currentDiffCents * pxPerCent;


    // --- 描画 ---
    
    // 1. 揺れ幅の帯 (Gray Band)
    // cx + state.min から cx + state.max までを描画
    const bandX = cx + state.min;
    const bandW = state.max - state.min;

    if (bandW > 1) { 
      this.ctx.fillStyle = "rgba(150, 150, 150, 0.25)";
      this.ctx.fillRect(bandX, y, bandW, h);
    }

    // 2. 現在値の白線 (White Line)
    // 帯の中に収まるように描画
    const lineX = cx + currentPx;
    
    // 画面外チェック
    if (lineX < -50 || lineX > this.els.canvas.width + 50) return;

    this.ctx.beginPath();
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    this.ctx.lineWidth = 2;
    this.ctx.moveTo(lineX, y);
    this.ctx.lineTo(lineX, y + h);
    this.ctx.stroke();

    // ラベル
    this.ctx.fillStyle = "rgba(255,255,255,0.7)";
    this.ctx.font = "9px sans-serif";
    this.ctx.fillText(label, lineX + 4, y + h/2);
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
    
    // Reset colors
    this.els.note.classList.remove('active', 'perfect');
    this.els.note.style.color = "#ffffff"; // Default white
    
    this.currentStableFreq = 0; 
    for(let k in this.algoHistory) this.algoHistory[k] = [];
  }

  resetSwayHistory() {
    for(let k in this.algoHistory) this.algoHistory[k] = [];
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
      
      // 中心周波数からのズレを計算
      const c = 1200 * Math.log2(f / centerFreq);
      
      // 異常値（±100セント以上、つまり半音以上のズレ）はノイズとして無視
      // これにより、大きく外れた値が帯を荒ぶらせるのを防ぐ
      if (Math.abs(c) > 100) continue;

      if (c < minCents) minCents = c;
      if (c > maxCents) maxCents = c;
    }
    
    return { min: minCents, max: maxCents };
  }

  // ============================================
  //  Algorithms & Logic
  // ============================================

  getPitchInfo(f) {
    if(!f || f<=0) return null;
    
    const semitones = 12 * Math.log2(f / this.config.a4);
    const midi = Math.round(semitones) + 69;
    const ideal = this.config.a4 * Math.pow(2, (midi-69)/12);
    const cents = 1200 * Math.log2(f / ideal);

    let displayNote = "";
    let displayOctave = Math.floor(midi / 12) - 1;
    
    let offset = 0;
    switch(this.config.notationMode) {
      case "JP_Bb": offset = 2; break; 
      case "JP_Eb": offset = 9; break; 
      case "JP_F":  offset = 7; break; 
      default:      offset = 0; break;
    }

    const transposedMidi = midi + offset;
    const noteIndex = transposedMidi % 12;
    
    if (this.config.notationMode.startsWith("JP")) {
      displayNote = this.NOTES_JP[noteIndex];
    } else {
      displayNote = this.NOTES_EN[noteIndex];
    }
    
    displayOctave = Math.floor(transposedMidi / 12) - 1;

    return { note: displayNote, oct: displayOctave, cents, midi, rawMidi: midi };
  }

  calculateRMS(buf) {
    let s=0; for(let i=0; i<buf.length; i+=4) s+=buf[i]*buf[i];
    return Math.sqrt(s/(buf.length/4));
  }

  runYIN(buffer, sr) {
    const half=buffer.length/2; const th=0.15;
    const minTau=Math.floor(sr/4000), maxTau=Math.floor(sr/30);
    this.yinBuffer.fill(0);
    let rSum=0, foundTau=-1;
    for(let t=1; t<maxTau; t++) {
      if(t<minTau) continue;
      let s=0; for(let i=0; i<half; i+=2) { const d=buffer[i]-buffer[i+t]; s+=d*d; }
      rSum+=s; const v=(rSum===0)?1:(s*t/rSum); this.yinBuffer[t]=v;
      if(foundTau===-1 && v<th) {
        while(t+1<maxTau && this.yinBuffer[t+1]<this.yinBuffer[t]) t++;
        foundTau=t; break;
      }
    }
    if(foundTau===-1) {
      let minV=100; for(let t=minTau; t<maxTau; t++) if(this.yinBuffer[t]<minV) { minV=this.yinBuffer[t]; foundTau=t; }
    }
    const conf = 1-(this.yinBuffer[foundTau]||1);
    if(foundTau<=0 || conf<0.15) return {freq:0, prob:0};
    const t=foundTau; 
    if(t<1||t>=this.yinBuffer.length-1) return {freq:sr/t, prob:conf};
    const s0=this.yinBuffer[t], s1=this.yinBuffer[t-1], s2=this.yinBuffer[t+1];
    const adj=(s2-s1)/(2*(2*s0-s2-s1));
    return {freq: sr/(t+adj), prob:conf};
  }

  runMPM(buffer, sr) {
    const len=buffer.length; const minTau=Math.floor(sr/4000), maxTau=Math.floor(sr/30);
    for(let t=minTau; t<maxTau; t++) {
      let acf=0, div=0, limit=Math.min(len-t, 1024);
      for(let i=0; i<limit; i+=2) { acf+=buffer[i]*buffer[i+t]; div+=buffer[i]*buffer[i]+buffer[i+t]*buffer[i+t]; }
      this.mpmNsdf[t] = (div===0)?0:(2*acf/div);
    }
    let maxP=0; for(let t=minTau; t<maxTau; t++) if(this.mpmNsdf[t]>maxP) maxP=this.mpmNsdf[t];
    const th=maxP*0.9; let bestTau=-1;
    for(let t=minTau+1; t<maxTau-1; t++) {
      if(this.mpmNsdf[t]>this.mpmNsdf[t-1] && this.mpmNsdf[t]>this.mpmNsdf[t+1] && this.mpmNsdf[t]>=th) { bestTau=t; break; }
    }
    if(bestTau<=0) return {freq:0, prob:0};
    const t=bestTau;
    const s0=this.mpmNsdf[t], s1=this.mpmNsdf[t-1], s2=this.mpmNsdf[t+1];
    const adj=(s2-s1)/(2*(2*s0-s2-s1));
    return {freq: sr/(t+adj), prob:this.mpmNsdf[t]};
  }

  runFFT_Harmonic(freqData, sr) {
    const peaks = [];
    const binSize = sr / (freqData.length * 2);
    const th = 30;
    for (let i = 2; i < freqData.length - 2; i++) {
      if (freqData[i] > th) {
        if (freqData[i] > freqData[i-1] && freqData[i] > freqData[i+1]) {
          const d = (freqData[i+1]-freqData[i-1])/(2*(2*freqData[i]-freqData[i+1]-freqData[i-1]));
          peaks.push({ freq: (i+d)*binSize, amp: freqData[i] });
        }
      }
    }
    if (peaks.length < 2) return { freq: 0, prob: 0 };
    peaks.sort((a,b) => b.amp - a.amp);
    let best=0, maxS=0;
    const cands = peaks.slice(0,5).map(p=>p.freq);
    const ext = []; cands.forEach(c=>{ext.push(c); ext.push(c/2);});
    for(let f of ext) {
      if(f<50) continue;
      let s=0, h=0;
      for(let n=1; n<=5; n++) {
        const t = f*n;
        const m = peaks.find(p=>Math.abs(p.freq-t)/t < 0.05);
        if(m) { s+=m.amp; h++; }
      }
      if(h>=2) {
        const tot = s*h*(1+500/f);
        if(tot>maxS) { maxS=tot; best=f; }
      }
    }
    return { freq: best, prob: Math.min(maxS/3000, 1.0) };
  }

  getAWeightingFactor(f) {
    const f2 = f * f;
    const R_A = (12194**2 * f**4) / 
                ((f2 + 20.6**2) * Math.sqrt((f2 + 107.7**2) * (f2 + 737.9**2)) * (f2 + 12194**2));
    return R_A;
  }

  calculatePerceivedPitch(freqData, sampleRate, physicalHint) {
    const binSize = sampleRate / (freqData.length * 2);
    const weightedPeaks = [];
    const threshold = 10;
    for (let i = 2; i < freqData.length - 2; i++) {
      if (freqData[i] > threshold) {
        if (freqData[i] > freqData[i-1] && freqData[i] > freqData[i+1]) {
          const freq = i * binSize;
          const weight = this.getAWeightingFactor(freq);
          const weightedAmp = freqData[i] * weight;
          const delta = (freqData[i+1]-freqData[i-1])/(2*(2*freqData[i]-freqData[i+1]-freqData[i-1]));
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
    candidates.forEach(f => { searchSpace.push(f); searchSpace.push(f/2); });
    const uniqueCandidates = [...new Set(searchSpace.map(f => Math.round(f*10)/10))];
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
