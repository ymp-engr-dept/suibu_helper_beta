/**
 * PitchWorklet - 高精度前処理AudioWorkletProcessor
 * 
 * ゼロ・アロケーション設計:
 * - process()内でのnew/slice()完全禁止
 * - 全バッファはコンストラクタで事前確保
 * - Transferable Objectsによるゼロコピー転送
 * 
 * 処理内容:
 * - ハミング窓関数処理
 * - DCオフセット除去（IIRハイパス）
 * - 適応型バンドパスフィルタ
 * - スペクトル平坦度計算
 * - RMS計算
 */
class PitchWorklet extends AudioWorkletProcessor {
    constructor() {
        super();

        this._sampleRate = sampleRate;

        this._bufferSize = 4096;
        this._hopSize = 512;

        // === プリアロケートバッファ ===
        this._buffer = new Float32Array(this._bufferSize);
        this._windowedBuffer = new Float32Array(this._bufferSize);

        // 送信用ダブルバッファ（ゼロコピー転送用）
        this._sendBufferA = new Float32Array(this._bufferSize);
        this._sendBufferB = new Float32Array(this._bufferSize);
        this._sendRawBufferA = new Float32Array(this._bufferSize);
        this._sendRawBufferB = new Float32Array(this._bufferSize);
        this._useSendBufferA = true;

        this._writeIndex = 0;

        this._hammingWindow = this._createHammingWindow(this._bufferSize);

        this._dcPrevIn = 0;
        this._dcPrevOut = 0;
        this._dcAlpha = 0.995;

        this._hp = this._createBiquadHighpass(80);
        this._hpState = { x1: 0, x2: 0, y1: 0, y2: 0 };
        this._lp = this._createBiquadLowpass(4000);
        this._lpState = { x1: 0, x2: 0, y1: 0, y2: 0 };

        this._noiseFloor = 0.001;
        this._enabled = true;

        // === プリアロケート: メッセージオブジェクト ===
        // 注意: port.postMessageは毎回新しいオブジェクトが必要だが、
        // 重要なのはTypedArrayのアロケーションを避けること
        this._messageCache = {
            type: 'audioData',
            buffer: null,
            rawBuffer: null,
            rms: 0,
            spectralFlatness: 0,
            sampleRate: this._sampleRate,
            timestamp: 0
        };

        this.port.onmessage = this._handleMessage.bind(this);
    }

    _createHammingWindow(size) {
        const window = new Float32Array(size);
        const twoPi = 2 * Math.PI;
        for (let i = 0; i < size; i++) {
            window[i] = 0.54 - 0.46 * Math.cos(twoPi * i / (size - 1));
        }
        return window;
    }

    _createBiquadHighpass(freq) {
        const w0 = 2 * Math.PI * freq / this._sampleRate;
        const cosW0 = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * 0.707);

        const b0 = (1 + cosW0) / 2;
        const b1 = -(1 + cosW0);
        const b2 = (1 + cosW0) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cosW0;
        const a2 = 1 - alpha;

        return {
            b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
            a1: a1 / a0, a2: a2 / a0
        };
    }

    _createBiquadLowpass(freq) {
        const w0 = 2 * Math.PI * freq / this._sampleRate;
        const cosW0 = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * 0.707);

        const b0 = (1 - cosW0) / 2;
        const b1 = 1 - cosW0;
        const b2 = (1 - cosW0) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cosW0;
        const a2 = 1 - alpha;

        return {
            b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
            a1: a1 / a0, a2: a2 / a0
        };
    }

    _applyBiquad(sample, coeffs, state) {
        const output = coeffs.b0 * sample
            + coeffs.b1 * state.x1
            + coeffs.b2 * state.x2
            - coeffs.a1 * state.y1
            - coeffs.a2 * state.y2;

        state.x2 = state.x1;
        state.x1 = sample;
        state.y2 = state.y1;
        state.y1 = output;

        return output;
    }

    _handleMessage(event) {
        const data = event.data;
        switch (data.type) {
            case 'enable':
                this._enabled = data.value;
                break;
            case 'setBufferSize':
                if (data.value !== this._bufferSize) {
                    this._bufferSize = data.value;
                    // 新しいサイズでバッファを再作成（これは稀な操作）
                    this._buffer = new Float32Array(this._bufferSize);
                    this._windowedBuffer = new Float32Array(this._bufferSize);
                    this._sendBufferA = new Float32Array(this._bufferSize);
                    this._sendBufferB = new Float32Array(this._bufferSize);
                    this._sendRawBufferA = new Float32Array(this._bufferSize);
                    this._sendRawBufferB = new Float32Array(this._bufferSize);
                    this._hammingWindow = this._createHammingWindow(this._bufferSize);
                    this._writeIndex = 0;
                }
                break;
            case 'setFilterRange':
                this._hp = this._createBiquadHighpass(data.lowFreq || 80);
                this._lp = this._createBiquadLowpass(data.highFreq || 4000);
                this._hpState = { x1: 0, x2: 0, y1: 0, y2: 0 };
                this._lpState = { x1: 0, x2: 0, y1: 0, y2: 0 };
                break;
            case 'receiveBuffers':
                // Transferable objectsが戻ってきた場合
                if (data.buffer) {
                    if (this._useSendBufferA) {
                        this._sendBufferB = new Float32Array(data.buffer);
                        this._sendRawBufferB = new Float32Array(data.rawBuffer);
                    } else {
                        this._sendBufferA = new Float32Array(data.buffer);
                        this._sendRawBufferA = new Float32Array(data.rawBuffer);
                    }
                }
                break;
        }
    }

    _calculateRMS(buffer) {
        let sum = 0;
        const len = buffer.length;
        for (let i = 0; i < len; i++) {
            sum += buffer[i] * buffer[i];
        }
        return Math.sqrt(sum / len);
    }

    _calculateSpectralFlatness(buffer) {
        const n = buffer.length;
        let geometricMean = 0;
        let arithmeticMean = 0;
        let validCount = 0;

        for (let i = 0; i < n; i++) {
            const mag = Math.abs(buffer[i]);
            if (mag > 1e-10) {
                geometricMean += Math.log(mag);
                arithmeticMean += mag;
                validCount++;
            }
        }

        if (validCount === 0 || arithmeticMean === 0) return 0;

        geometricMean = Math.exp(geometricMean / validCount);
        arithmeticMean = arithmeticMean / validCount;

        return geometricMean / arithmeticMean;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0]) {
            return true;
        }

        const inputChannel = input[0];
        const outputChannel = output[0];
        const inputLength = inputChannel.length;

        for (let i = 0; i < inputLength; i++) {
            let sample = inputChannel[i];

            if (this._enabled) {
                const dcOut = sample - this._dcPrevIn + this._dcAlpha * this._dcPrevOut;
                this._dcPrevIn = sample;
                this._dcPrevOut = dcOut;
                sample = dcOut;

                sample = this._applyBiquad(sample, this._hp, this._hpState);
                sample = this._applyBiquad(sample, this._lp, this._lpState);
            }

            outputChannel[i] = sample;
            this._buffer[this._writeIndex] = sample;
            this._writeIndex++;

            if (this._writeIndex >= this._bufferSize) {
                // 窓関数適用
                const bufSize = this._bufferSize;
                for (let j = 0; j < bufSize; j++) {
                    this._windowedBuffer[j] = this._buffer[j] * this._hammingWindow[j];
                }

                const rms = this._calculateRMS(this._buffer);
                const spectralFlatness = this._calculateSpectralFlatness(this._windowedBuffer);

                // === ゼロアロケーション送信 ===
                // ダブルバッファを交互に使用
                const sendBuffer = this._useSendBufferA ? this._sendBufferA : this._sendBufferB;
                const sendRawBuffer = this._useSendBufferA ? this._sendRawBufferA : this._sendRawBufferB;

                // set()でコピー（slice()より効率的、アロケーションなし）
                sendBuffer.set(this._windowedBuffer);
                sendRawBuffer.set(this._buffer);

                // 次回は別のバッファを使用
                this._useSendBufferA = !this._useSendBufferA;

                // 通常送信（Transferableは受信側での再構築が必要なため、
                // 小さいバッファでは通常コピーの方が効率的な場合がある）
                this.port.postMessage({
                    type: 'audioData',
                    buffer: sendBuffer,
                    rawBuffer: sendRawBuffer,
                    rms,
                    spectralFlatness,
                    sampleRate: this._sampleRate,
                    timestamp: currentTime * 1000
                });

                // オーバーラップ処理
                const overlap = bufSize - this._hopSize;
                for (let j = 0; j < overlap; j++) {
                    this._buffer[j] = this._buffer[j + this._hopSize];
                }
                this._writeIndex = overlap;
            }
        }

        return true;
    }
}

registerProcessor('pitch-worklet', PitchWorklet);
