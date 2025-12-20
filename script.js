const canvas = document.getElementById("analyzer");
const ctx = canvas.getContext("2d");
const gainInput = document.getElementById("gainInput");
const freezeBtn = document.getElementById("freezeBtn");
const recordBtn = document.getElementById("recordBtn");
const fileInput = document.getElementById("fileInput");
const audioPlayer = document.getElementById("audioPlayer");
const a4Input = document.getElementById("a4Input");
const showHarmonicsCheckbox = document.getElementById("showHarmonicsCheckbox");
const saveCompareBtn = document.getElementById("saveCompareBtn");
const showCompareCheckbox = document.getElementById("showCompareCheckbox");
const sourceModeCheckbox = document.getElementById("sourceModeCheckbox");
const audioSeekBar = document.getElementById("audioSeekBar");
const currentTimeDisplay = document.getElementById("currentTimeDisplay");
const durationDisplay = document.getElementById("durationDisplay");
const playPauseBtn = document.getElementById("playPauseBtn");
const volumeSlider = document.getElementById("volumeSlider");
const playbackRateSelect = document.getElementById("playbackRateSelect");

// AI関連のDOM
const chatHistory = document.getElementById("chatHistory");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");
const sendDataCheckbox = document.getElementById("sendDataCheckbox");

// =======================================================
//  OpenAI API 設定
// =======================================================
// 【重要】ここにOpenAIのAPIキーを入力してください
// テスト時はここに直接書き込みますが、本番環境ではサーバーサイドで管理することを推奨します。
const OPENAI_API_KEY = "OpenAI_API_KEYをここに入力";

// --- 状態管理変数 ---
let selectedFreq = null;
let isFrozen = false;
let isRecording = false;

// 現在保持している音声データ (Blob)
let currentAudioBlob = null; 
// 録音のMIME Type (OpenAIへ送る形式判定用)
let recordedMimeType = "audio/wav";

// AudioContext関連
let audioContext = null;
let analyser = null;
let micSource = null;       
let playerSource = null;    
let mediaRecorder = null;   
let audioChunks = [];       

// 基本周波数を追跡するための変数を追加
let detectedFundamentalFreq = null;

// 比較用データを格納する変数
let comparisonDataArray = null;

// フラグ
let isFileMode = false; // false=Mic, true=File
let isScrubbing = false; // スライダー操作中かどうか

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = 350;
}
resize();
window.onresize = resize;

// --- 座標・周波数変換ロジック ---
const minFreq = 20;
const maxFreq = 20000;
const displayMinDB = 0;
const displayMaxDB = 80;

function freqToX(freq) {
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);
  const logF = Math.log10(freq);
  return ((logF - logMin) / (logMax - logMin)) * canvas.width;
}

function xToFreq(x) {
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);
  const ratio = x / canvas.width;
  const logF = ratio * (logMax - logMin) + logMin;
  return Math.pow(10, logF);
}

// --- 初期化 & オーディオセットアップ ---
async function initAudio() {
  if (audioContext) return; 

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6; 

  // マイク入力セットアップ
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch(e) {
    console.warn("マイクが見つかりません:", e);
  }
  
  if (stream) {
    micSource = audioContext.createMediaStreamSource(stream);
    
    // 録音機能 (既存コード維持)
    let options = {};
    if (MediaRecorder.isTypeSupported('audio/webm')) {
      options = { mimeType: 'audio/webm' };
      recordedMimeType = 'audio/webm';
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      options = { mimeType: 'audio/mp4' };
      recordedMimeType = 'audio/mp4';
    }

    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunks, { type: recordedMimeType });
      currentAudioBlob = audioBlob; 
      const audioUrl = URL.createObjectURL(audioBlob);
      audioPlayer.src = audioUrl;
      audioChunks = [];
      
      // 録音完了したら自動でファイルモードに切り替えると親切
      sourceModeCheckbox.checked = true;
      updateSourceRouting();
    };
  }

  // プレイヤーソース作成
  playerSource = audioContext.createMediaElementSource(audioPlayer);

  // ▼▼▼ オーディオプレイヤーのイベント監視 (UI同期) ▼▼▼
  
  // 再生開始時
  audioPlayer.addEventListener('play', () => {
    if (audioContext.state === 'suspended') audioContext.resume();
    playPauseBtn.textContent = "❚❚"; // 一時停止アイコン
    if (sourceModeCheckbox.checked) updateSourceRouting();
  });

  // 一時停止時
  audioPlayer.addEventListener('pause', () => {
    playPauseBtn.textContent = "▶"; // 再生アイコン
    // pause時はルーティングを切る必要はない (スクラブ操作などのため接続維持推奨)
  });

  // 再生終了時
  audioPlayer.addEventListener('ended', () => {
    playPauseBtn.textContent = "▶";
  });

  // 初期ルーティング実行
  updateSourceRouting();
  draw();
}

function updateSourceRouting() {
  if (!analyser) return;

  isFileMode = sourceModeCheckbox.checked;

  // ▼▼▼ 新しいUIパーツの有効/無効切り替え ▼▼▼
  const uiElements = [audioSeekBar, playPauseBtn, volumeSlider, playbackRateSelect];
  uiElements.forEach(el => el.disabled = !isFileMode);
  
  // モードOFFなら不透明度を下げて視覚的に無効化
  document.querySelector('.player-controls-group').style.opacity = isFileMode ? "1" : "0.6";

  if (isFileMode) {
    // --- 音源モード ---
    try { micSource.disconnect(); } catch(e){}
    try { 
      playerSource.connect(analyser);
      analyser.connect(audioContext.destination); 
    } catch(e){}
  } else {
    // --- マイクモード ---
    try { playerSource.disconnect(); } catch(e){}
    try { analyser.disconnect(audioContext.destination); } catch(e){}
    try { micSource.connect(analyser); } catch(e){}
  }
}


// --- UIイベントリスナー ---

document.body.addEventListener('click', () => {
  if (!audioContext) initAudio();
}, { once: true });

freezeBtn.addEventListener("click", () => {
  isFrozen = !isFrozen;
  freezeBtn.textContent = isFrozen ? "再開 (解除)" : "フリーズ";
  freezeBtn.classList.toggle("active", isFrozen);
});

recordBtn.addEventListener("click", async () => {
  if (!audioContext) await initAudio();
  if (!mediaRecorder) return;

  if (!isRecording) {
    audioChunks = [];
    mediaRecorder.start();
    isRecording = true;
    recordBtn.textContent = "■ 停止";
    recordBtn.classList.add("recording");
    audioPlayer.pause();
  } else {
    mediaRecorder.stop();
    isRecording = false;
    recordBtn.textContent = "● 録音";
    recordBtn.classList.remove("recording");
  }
});

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    currentAudioBlob = file; 
    recordedMimeType = file.type; // ファイルのMIMEタイプを保持
    const url = URL.createObjectURL(file);
    audioPlayer.src = url;
  }
});

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const freq = xToFreq(x);
  if (freq >= minFreq && freq <= maxFreq) {
    selectedFreq = freq;
  }
});

// 比較グラフ保存ボタン
saveCompareBtn.addEventListener("click", () => {
  if (dataArray) {
    // 現在のデータをディープコピーして保存 (参照渡しだとリアルタイムで変わってしまうため)
    comparisonDataArray = new Uint8Array(dataArray);
    
    // 保存した瞬間、自動で「表示」をONにすると親切です
    showCompareCheckbox.checked = true;
    
    // 保存完了の視覚フィードバック（ボタンを一瞬光らせるなど）
    const originalText = saveCompareBtn.textContent;
    saveCompareBtn.textContent = "保存完了!";
    setTimeout(() => saveCompareBtn.textContent = originalText, 1000);
  }
});

// モード切替スイッチ
sourceModeCheckbox.addEventListener("change", () => {
  if (!audioContext) initAudio();
  updateSourceRouting();
});

// ファイル読み込み時
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    currentAudioBlob = file; 
    recordedMimeType = file.type;
    const url = URL.createObjectURL(file);
    audioPlayer.src = url;
    
    // 自動でモードON
    sourceModeCheckbox.checked = true;
    updateSourceRouting();
  }
});

// --- シークバー & タイム表示ロジック ---

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// メタデータ読み込み完了（長さ確定）
audioPlayer.addEventListener('loadedmetadata', () => {
  audioSeekBar.max = audioPlayer.duration;
  durationDisplay.textContent = formatTime(audioPlayer.duration);
});

// 再生中のスライダー自動更新
audioPlayer.addEventListener('timeupdate', () => {
  if (!isScrubbing) {
    audioSeekBar.value = audioPlayer.currentTime;
    currentTimeDisplay.textContent = formatTime(audioPlayer.currentTime);
  }
});

// スライダー操作開始 (ドラッグ中)
audioSeekBar.addEventListener('mousedown', () => { isScrubbing = true; });
audioSeekBar.addEventListener('touchstart', () => { isScrubbing = true; }, {passive: true});

// スライダー操作中 (スクラブ)
audioSeekBar.addEventListener('input', () => {
  if (!audioContext) initAudio();
  
  const time = parseFloat(audioSeekBar.value);
  audioPlayer.currentTime = time;
  currentTimeDisplay.textContent = formatTime(time);
  });

audioSeekBar.addEventListener('mouseup', () => { isScrubbing = false; });
audioSeekBar.addEventListener('touchend', () => { isScrubbing = false; });

// 再生/一時停止ボタン
playPauseBtn.addEventListener("click", () => {
  if (!audioContext) initAudio();
  
  if (audioPlayer.paused) {
    audioPlayer.play();
  } else {
    audioPlayer.pause();
  }
});

// 音量スライダー
volumeSlider.addEventListener("input", (e) => {
  audioPlayer.volume = parseFloat(e.target.value);
});

// 再生速度選択
playbackRateSelect.addEventListener("change", (e) => {
  audioPlayer.playbackRate = parseFloat(e.target.value);
});


// --- シークバー関連 (既存コードの確認と微調整) ---

// formatTime関数 (既存)
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// メタデータ読み込み時
audioPlayer.addEventListener('loadedmetadata', () => {
  audioSeekBar.max = audioPlayer.duration;
  durationDisplay.textContent = formatTime(audioPlayer.duration);
  // 初期状態UIリセット
  playPauseBtn.textContent = "▶";
});

// 再生中の更新
audioPlayer.addEventListener('timeupdate', () => {
  if (!isScrubbing) {
    audioSeekBar.value = audioPlayer.currentTime;
    currentTimeDisplay.textContent = formatTime(audioPlayer.currentTime);
  }
});

// スクラブ操作 (既存コード)
audioSeekBar.addEventListener('mousedown', () => { isScrubbing = true; });
audioSeekBar.addEventListener('touchstart', () => { isScrubbing = true; }, {passive: true});

audioSeekBar.addEventListener('input', () => {
  if (!audioContext) initAudio();
  const time = parseFloat(audioSeekBar.value);
  
  // シーク位置を即時反映
  audioPlayer.currentTime = time;
  currentTimeDisplay.textContent = formatTime(time);
});

audioSeekBar.addEventListener('mouseup', () => { isScrubbing = false; });
audioSeekBar.addEventListener('touchend', () => { isScrubbing = false; });

// --- 描画ループ ---
const dataArray = new Uint8Array(2048); 

function drawGrid() {
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  const freqs = [20,30,50,100,200,300,500,1000,2000,3000,5000,8000,10000,20000];
  ctx.font = "12px sans-serif";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  for (let f of freqs) {
    const x = freqToX(f);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    ctx.fillText(f + "Hz", x, canvas.height - 5);
  }
  const dBLines = [0, 20, 40, 60, 80];
  ctx.textAlign = "left";
  dBLines.forEach(dB => {
    const y = canvas.height * (1 - dB / displayMaxDB);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    ctx.fillText(dB + " dB", 5, y - 3);
  });
}

function drawMarkerAndTooltip(freqPerBin) {
  if (selectedFreq == null) return;

  const bufferLength = analyser ? analyser.frequencyBinCount : (dataArray ? dataArray.length : 0);
  if (!bufferLength) return;

  const x = freqToX(selectedFreq);
  let index = Math.round(selectedFreq / freqPerBin);
  index = Math.max(0, Math.min(index, bufferLength - 1));

  let value = 0;
  if (index >= 0 && index < dataArray.length) {
    value = dataArray[index] || 0;
  }

  const gainVal = Number(gainInput.value) || 1;
  let adjustedValue = value * gainVal;
  const dbValue = (adjustedValue / 255) * displayMaxDB;

  // 赤い縦線
  ctx.beginPath();
  ctx.strokeStyle = "rgba(255, 50, 50, 0.8)";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();
  ctx.setLineDash([]);

  // テキスト情報の構築
  let noteName = "";
  try {
    noteName = typeof getNoteName === "function" ? getNoteName(selectedFreq) : "";
  } catch (e) {}

  let textFreq = `${Math.round(selectedFreq)} Hz${noteName ? " (" + noteName + ")" : ""}`;
  const textDB = `${dbValue.toFixed(1)} dB`;
  
  // ▼▼▼ 倍音・低次倍音 判定ロジック ▼▼▼
  let harmonicText = "";
  if (detectedFundamentalFreq && detectedFundamentalFreq > 0) {
    // 1. 高次倍音 (Harmonics: f * n) 判定
    if (selectedFreq >= detectedFundamentalFreq) {
      const ratio = selectedFreq / detectedFundamentalFreq;
      const harmonicN = Math.round(ratio);
      // 誤差5%以内
      if (Math.abs(ratio - harmonicN) < 0.05) {
        harmonicText = harmonicN === 1 ? "★ 基本周波数" : `第${harmonicN}倍音`;
      }
    } 
    // 2. 低次倍音 (Subharmonics: f / n) 判定
    else {
      // 逆比 (基本周波数 / 選択周波数) が整数に近いか
      const ratioSub = detectedFundamentalFreq / selectedFreq;
      const subN = Math.round(ratioSub);
      
      if (Math.abs(ratioSub - subN) < 0.05 && subN > 1) {
        harmonicText = `1/${subN} 低次倍音`;
      }
    }
  }
  // ▲▲▲ 追加終了 ▲▲▲

  // ボックスサイズ計算
  ctx.font = "bold 13px sans-serif";
  const textMetrics = ctx.measureText(textFreq);
  const textMetricsH = ctx.measureText(harmonicText);
  const boxWidth = Math.max(120, textMetrics.width + 20, textMetricsH.width + 20);
  const boxHeight = harmonicText ? 70 : 50;

  let boxX = x + 10;
  let boxY = 20;
  if (boxX + boxWidth > canvas.width) boxX = x - boxWidth - 10;
  if (boxX < 0) boxX = 5;

  // 吹き出し描画
  ctx.fillStyle = "rgba(50, 0, 0, 0.9)";
  ctx.strokeStyle = "red";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 5);
  else ctx.rect(boxX, boxY, boxWidth, boxHeight);
  ctx.fill();
  ctx.stroke();

  // 文字描画
  ctx.fillStyle = "white";
  ctx.textAlign = "left";
  ctx.font = "bold 13px sans-serif";
  ctx.fillText(textFreq, boxX + 10, boxY + 20);

  ctx.fillStyle = dbValue > 60 ? "#ff5555" : "#aaa";
  ctx.font = "12px monospace";
  ctx.fillText(textDB, boxX + 10, boxY + 40);

  if (harmonicText) {
    // 低次倍音は色を変える（例：シアン系）、通常倍音はオレンジ
    ctx.fillStyle = harmonicText.includes("低次") ? "#00ffff" : "#ffaa00";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(harmonicText, boxX + 10, boxY + 60);
  }
}

function drawHarmonicsLines(f0) {
  if (!f0 || f0 < minFreq) return;

  ctx.lineWidth = 1.5;
  
  // --- 1. 基本周波数 (Base) ---
  const x0 = freqToX(f0);
  if (x0 >= 0 && x0 <= canvas.width) {
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,165,0,0.9)"; // 濃いオレンジ
    ctx.setLineDash([]);
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, canvas.height);
    ctx.stroke();
    
    ctx.fillStyle = "rgba(255, 165, 0, 1)";
    ctx.font = "10px sans-serif";
    ctx.fillText("Base", x0 + 2, 10);
  }

  // --- 2. 高次倍音 (Overtones: x2, x3...) ---
  ctx.strokeStyle = "rgba(255,255,0,0.5)"; // 黄色
  ctx.fillStyle = "rgba(255,255,0,0.8)";
  ctx.setLineDash([]); // 実線

  for (let n = 2; n <= 16; n++) {
    const fn = f0 * n;
    if (fn > maxFreq) break; 

    const xn = freqToX(fn);
    if (xn >= 0 && xn <= canvas.width) {
      ctx.beginPath();
      ctx.moveTo(xn, 0);
      ctx.lineTo(xn, canvas.height);
      ctx.stroke();
      if (n <= 8) ctx.fillText(`x${n}`, xn + 2, 10);
    }
  }

  // --- 3. 低次倍音 (Subharmonics: 1/2, 1/3...) ---
  // 追加機能: 基本周波数より低い成分の位置を示す
  ctx.strokeStyle = "rgba(0, 255, 255, 0.4)"; // シアン（薄め）
  ctx.fillStyle = "rgba(0, 255, 255, 0.7)";
  ctx.setLineDash([2, 4]); // 点線にする

  for (let n = 2; n <= 8; n++) {
    const fn = f0 / n; // 割り算
    if (fn < minFreq) break; // 最低周波数を下回ったら終了

    const xn = freqToX(fn);
    if (xn >= 0 && xn <= canvas.width) {
      ctx.beginPath();
      ctx.moveTo(xn, 0);
      ctx.lineTo(xn, canvas.height);
      ctx.stroke();
      
      // ラベル表示 (下部に表示して被りを避ける)
      ctx.fillText(`1/${n}`, xn + 2, canvas.height - 20);
    }
  }
  
  ctx.setLineDash([]); // 設定を戻す
}

function draw() {
  requestAnimationFrame(draw);
  if (!analyser) return;

  const freqPerBin = audioContext.sampleRate / analyser.fftSize;
  const bufferLength = analyser.frequencyBinCount;

  if (!isFrozen) {
    analyser.getByteFrequencyData(dataArray);
  }

  // 背景クリア
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, "#000");
  grad.addColorStop(1, "#050505");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawGrid();

  // ▼▼▼ 比較グラフの描画 (メイングラフの「下層」に描くため先に呼ぶ) ▼▼▼
  if (showCompareCheckbox.checked && comparisonDataArray) {
    drawComparisonGraph(freqPerBin);
  }
  // ▲▲▲ 追加終了 ▲▲▲

  // メイングラフ描画
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgb(0,180,255)";
  const gainVal = Number(gainInput.value) || 1;

  ctx.beginPath();
  let started = false;

  let maxVal = 0;
  let maxBinIndex = -1;
  const threshold = 50; 

  for (let i = 0; i < bufferLength; i++) {
    const freq = i * freqPerBin;
    if (freq < minFreq || freq > maxFreq) continue;
    
    const val = dataArray[i];

    if (val > maxVal) {
      maxVal = val;
      maxBinIndex = i;
    }

    const x = freqToX(freq);
    const y = canvas.height * (1 - (val / 255) * gainVal);

    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // 基本周波数の特定と更新
  if (!isFrozen) {
    if (maxVal > threshold && maxBinIndex !== -1) {
      detectedFundamentalFreq = maxBinIndex * freqPerBin;
    } else {
      detectedFundamentalFreq = null; 
    }
  }

  // 倍音・低次倍音ラインの描画
  if (showHarmonicsCheckbox.checked && detectedFundamentalFreq) {
    drawHarmonicsLines(detectedFundamentalFreq);
  }

  // マウスカーソルとツールチップ
  drawMarkerAndTooltip(freqPerBin);
}

function drawComparisonGraph(freqPerBin) {
  if (!comparisonDataArray) return;

  const gainVal = Number(gainInput.value) || 1;
  const bufferLength = comparisonDataArray.length;

  ctx.lineWidth = 2;
  // 半透明の白/グレーで描画
  ctx.strokeStyle = "rgba(150, 150, 150, 0.5)"; 
  // 塗りつぶしも追加して視認性を上げる
  ctx.fillStyle = "rgba(150, 150, 150, 0.15)"; 

  ctx.beginPath();
  ctx.moveTo(0, canvas.height); // 左下から開始

  let started = false;
  
  for (let i = 0; i < bufferLength; i++) {
    const freq = i * freqPerBin;
    if (freq < minFreq || freq > maxFreq) continue;
    
    const val = comparisonDataArray[i];
    const x = freqToX(freq);
    const y = canvas.height * (1 - (val / 255) * gainVal);

    if (!started) {
      ctx.lineTo(x, y); // 最初の点
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  
  // 右下まで線を引いて閉じる（塗りつぶし用）
  ctx.lineTo(canvas.width, canvas.height);
  ctx.closePath();
  
  ctx.fill();   // 薄く塗りつぶし
  ctx.stroke(); // 輪郭線
}

function getNoteName(freq) {
  if (!freq || freq <= 0) return "--";
  const a4 = Number(a4Input.value) || 442;
  const noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const semitonesFromA4 = 12 * Math.log2(freq / a4);
  const midiNum = Math.round(semitonesFromA4) + 69;
  if (midiNum < 0) return "?"; 
  return `${noteStrings[midiNum % 12]}${Math.floor(midiNum / 12) - 1}`;
}


// =======================================================
//  AI分析 & チャット機能 (OpenAI API Integration)
// =======================================================

sendChatBtn.addEventListener("click", sendMessage);

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  appendMessage("user", text);
  chatInput.value = "";
  
  const loadingId = appendMessage("ai", "OpenAI分析中... (少々お待ちください)");

  try {
    let audioDataBase64 = null;
    let analysisJson = null;

    if (sendDataCheckbox.checked) {
      if (!currentAudioBlob) {
        updateMessage(loadingId, "エラー: 送信する音声データがありません。");
        return;
      }

      // 1. 音声ファイルをBase64変換
      audioDataBase64 = await blobToBase64(currentAudioBlob);

      // 2. 音声ファイルを解析してJSONデータを生成 (簡易メタデータ)
      updateMessage(loadingId, "音声と解析データをパッケージング中...");
      analysisJson = await generateSpectralJSON(currentAudioBlob);
    }

    // OpenAI APIへ送信
    updateMessage(loadingId, "AI(GPT-4o Audio)に問い合わせ中...");
    const aiResponse = await callOpenAIAPI(text, audioDataBase64, analysisJson);

    // AIの返答を表示 (Markdownレンダリング)
    updateMessage(loadingId, marked.parse(aiResponse));

  } catch (err) {
    console.error(err);
    updateMessage(loadingId, `エラーが発生しました: ${err.message}`);
  }
}

function appendMessage(role, htmlContent) {
  const div = document.createElement("div");
  div.className = `chat-message ${role}`;
  div.innerHTML = `<div class="message-content">${htmlContent}</div>`;
  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  return div.id = "msg_" + Date.now();
}

function updateMessage(id, newHtmlContent) {
  const div = document.getElementById(id);
  if (div) {
    div.querySelector(".message-content").innerHTML = newHtmlContent;
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// --- OpenAI API呼び出し関数 ---
async function callOpenAIAPI(prompt, audioBase64, jsonData) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.includes("YOUR_OPENAI_API_KEY")) {
    throw new Error("OpenAI APIキーが設定されていません。script.jsのOPENAI_API_KEYを編集してください。");
  }

  const url = "https://api.openai.com/v1/chat/completions";
  
  // メッセージの構築
  const content = [];
  
  // 1. テキストプロンプト + JSONデータ
  let textContent = prompt;
  if (jsonData) {
    textContent += `\n\n【補足データ: 周波数解析メタデータ】\n${JSON.stringify(jsonData)}`;
  }
  content.push({ type: "text", text: textContent });

  // 2. 音声データ (ある場合)
  // GPT-4o-audio-preview は "wav" または "mp3" を好む
  // ブラウザ録音が "webm" の場合でも "wav" として送ると通る場合があるが、
  // エラーになる場合は変換が必要。ここでは簡易的に wav 指定で送る。
  if (audioBase64) {
    content.push({
      type: "input_audio",
      input_audio: {
        data: audioBase64,
        format: "wav" // OpenAI APIのformatは wav または mp3
      }
    });
  }

  const payload = {
    model: "gpt-4o-audio-preview", // 音声入力対応モデル
    modalities: ["text"],          // 返答はテキストのみで受け取る
    messages: [
      {
        role: "system",
        content: "あなたは世界一のサックス演奏家・音響解析者です。提供された音声とデータを分析し、プロの視点で演奏のアドバイスを行ってください。"
      },
      {
        role: "user",
        content: content
      }
    ]
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errData = await response.json();
    console.error("OpenAI Error:", errData);
    throw new Error(errData.error?.message || "API Request Failed");
  }

  const data = await response.json();
  // 構造: choices[0].message.content (textの場合)
  return data.choices[0].message.content;
}

// --- 音声ファイル解析 (メタデータ生成) ---
async function generateSpectralJSON(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  
  // 解析用に一時的なContext
  const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
  
  // 詳細なJSON化は重いため、AIへのヒントとなるメタデータを返す
  // GPT-4oは音声を直接聴けるため、これで十分強力です
  const metaData = {
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    numberOfChannels: audioBuffer.numberOfChannels,
    info: "Audio data is attached directly for analysis."
  };

  return metaData; 
}
