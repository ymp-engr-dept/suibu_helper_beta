/**
 * SpectralSubtractionWorklet - ゼロ・アロケーション版ノイズ除去
 * 
 * ゼロ・アロケーション設計:
 * - process()内でのnew完全禁止
 * - 全バッファはコンストラクタで事前確保
 * - スペクトル計算用バッファも事前確保
 */

class SpectralSubtractionProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        const processorOptions = options.processorOptions ?? {};

        // 固定設定
        this.fftSize = 256;
        this.halfFFT = this.fftSize / 2;
        this.calibrationTargetFrames = processorOptions.calibrationFrames ?? 30;

        // 状態
        this._noiseProfile = null;
        this._isCalibrating = false;
        this._calibrationFrameCount = 0;
        this._enabled = false;
        this._bypass = false;

        // パラメータ
        this._overSubtraction = 1.5;
        this._spectralFloor = 0.002;

        // === プリアロケートバッファ ===
        this._buffer = new Float32Array(this.fftSize);
        this._bufferPos = 0;
        this._frameCount = 0;

        // スペクトル計算用（GC回避）
        this._spectrum = new Float32Array(this.halfFFT);
        this._calibrationSpectrum = new Float32Array(this.halfFFT);

        // キャリブレーション累積用
        this._calibrationAccumulator = new Float64Array(this.halfFFT);

        // 事前計算: 三角関数テーブル（DFT用）
        this._cosTable = new Float32Array(this.fftSize * this.halfFFT);
        this._sinTable = new Float32Array(this.fftSize * this.halfFFT);
        this._buildTrigTables();

        // メッセージハンドラ
        this.port.onmessage = (event) => this._handleMessage(event.data);
    }

    /**
     * 三角関数テーブルを事前計算
     */
    _buildTrigTables() {
        const n = this.fftSize;
        const twoPi = 2 * Math.PI;

        for (let k = 0; k < this.halfFFT; k++) {
            const freq = twoPi * k / n;
            for (let i = 0; i < n; i++) {
                const idx = k * n + i;
                this._cosTable[idx] = Math.cos(freq * i);
                this._sinTable[idx] = Math.sin(freq * i);
            }
        }
    }

    _handleMessage(data) {
        switch (data.type) {
            case 'startCalibration':
                this._startCalibration();
                break;

            case 'setNoiseProfile':
                if (data.profile && data.profile.length === this.halfFFT) {
                    if (!this._noiseProfile) {
                        this._noiseProfile = new Float32Array(this.halfFFT);
                    }
                    for (let i = 0; i < this.halfFFT; i++) {
                        this._noiseProfile[i] = data.profile[i];
                    }
                    this._enabled = true;
                }
                break;

            case 'setParameters':
                if (data.overSubtraction !== undefined) {
                    this._overSubtraction = data.overSubtraction;
                }
                if (data.spectralFloor !== undefined) {
                    this._spectralFloor = data.spectralFloor;
                }
                break;

            case 'enable':
                this._enabled = data.value;
                break;

            case 'bypass':
                this._bypass = data.value;
                break;

            case 'reset':
                this._reset();
                break;
        }
    }

    _startCalibration() {
        this._isCalibrating = true;
        this._calibrationFrameCount = 0;
        this._noiseProfile = null;
        this._enabled = false;

        // 累積器をゼロクリア
        this._calibrationAccumulator.fill(0);

        this.port.postMessage({ type: 'calibrationStarted' });
    }

    _finishCalibration() {

        if (this._calibrationFrameCount === 0) {
            this.port.postMessage({
                type: 'calibrationFailed',
                reason: 'No frames collected'
            });
            return;
        }

        // 平均ノイズスペクトルを計算
        if (!this._noiseProfile) {
            this._noiseProfile = new Float32Array(this.halfFFT);
        }

        const invCount = 1 / this._calibrationFrameCount;
        for (let i = 0; i < this.halfFFT; i++) {
            this._noiseProfile[i] = this._calibrationAccumulator[i] * invCount;
        }

        this._isCalibrating = false;
        this._calibrationFrameCount = 0;
        this._enabled = true;

        // プロファイルをコピーして送信（Workerスレッドでは新規アロケーションOK）
        const profileCopy = new Float32Array(this._noiseProfile);

        this.port.postMessage({
            type: 'calibrationComplete',
            profile: profileCopy,
            numFrames: this._calibrationFrameCount
        });
    }

    _reset() {
        this._noiseProfile = null;
        this._isCalibrating = false;
        this._calibrationFrameCount = 0;
        this._enabled = false;
        this._buffer.fill(0);
        this._bufferPos = 0;
        this._calibrationAccumulator.fill(0);
    }

    /**
     * ゼロ・アロケーション版スペクトル計算
     * 結果は this._spectrum に格納される
     */
    _computeSpectrumZeroAlloc(samples) {
        const n = samples.length;
        const halfN = this.halfFFT;
        const invN = 1 / n;

        for (let k = 0; k < halfN; k++) {
            let real = 0;
            let imag = 0;
            const tableOffset = k * n;

            for (let i = 0; i < n; i++) {
                const s = samples[i];
                real += s * this._cosTable[tableOffset + i];
                imag -= s * this._sinTable[tableOffset + i];
            }

            this._spectrum[k] = Math.sqrt(real * real + imag * imag) * invN;
        }
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0] || input[0].length === 0) {
            return true;
        }

        const inputChannel = input[0];
        const outputChannel = output[0];
        const blockSize = inputChannel.length;

        // 入力をそのまま出力にコピー（パススルー）
        for (let i = 0; i < blockSize; i++) {
            outputChannel[i] = inputChannel[i];
        }

        // バッファに追加
        for (let i = 0; i < blockSize; i++) {
            this._buffer[this._bufferPos] = inputChannel[i];
            this._bufferPos++;

            // バッファが満杯になったら処理
            if (this._bufferPos >= this.fftSize) {
                this._frameCount++;

                // キャリブレーション中
                if (this._isCalibrating) {
                    // ゼロ・アロケーション版スペクトル計算
                    this._computeSpectrumZeroAlloc(this._buffer);

                    // 累積（新しい配列を作らない）
                    for (let j = 0; j < this.halfFFT; j++) {
                        this._calibrationAccumulator[j] += this._spectrum[j];
                    }

                    this._calibrationFrameCount++;

                    const progress = this._calibrationFrameCount / this.calibrationTargetFrames;

                    // 進捗を報告
                    this.port.postMessage({
                        type: 'calibrationProgress',
                        progress: Math.min(progress, 1.0)
                    });

                    // 目標フレーム数に達したら完了
                    if (this._calibrationFrameCount >= this.calibrationTargetFrames) {
                        this._finishCalibration();
                    }
                }

                // バッファをリセット
                this._bufferPos = 0;
            }
        }

        return true;
    }
}

registerProcessor('spectral-subtraction-processor', SpectralSubtractionProcessor);
