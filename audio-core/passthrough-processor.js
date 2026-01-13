/**
 * PassthroughProcessor - 超低遅延パススルーAudioWorklet
 * 
 * 設計原則:
 * - 128サンプルフレーム（約2.9ms @ 44.1kHz）
 * - DSP処理なし、完全パススルー
 * - console.log/JSON/new Object禁止
 * - 遅延を最小化するための最適化
 */
class PassthroughProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // プリアロケートバッファ（GC回避）
        this._gain = 1.0;
        this._enabled = true;

        // メッセージハンドラ（最小限）
        this.port.onmessage = this._handleMessage.bind(this);
    }

    /**
     * メッセージ処理（オーディオスレッド外で実行）
     */
    _handleMessage(event) {
        const data = event.data;
        if (data.type === 'gain') {
            this._gain = data.value;
        } else if (data.type === 'enable') {
            this._enabled = data.value;
        }
    }

    /**
     * メイン処理 - 128サンプルごとに呼び出し
     * 
     * 重要: この関数内では以下を絶対に使用しない
     * - console.log
     * - JSON.stringify/parse
     * - new Object/Array
     * - array.push/shift
     */
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        // 入力がない場合は即座にreturn
        if (!input || !input[0]) {
            return true;
        }

        const inputChannel = input[0];
        const outputChannel = output[0];
        const length = inputChannel.length;
        const gain = this._gain;

        // 無効の場合は無音
        if (!this._enabled) {
            for (let i = 0; i < length; i++) {
                outputChannel[i] = 0;
            }
            return true;
        }

        // ゲインが1.0の場合は直接コピー（最速）
        if (gain === 1.0) {
            outputChannel.set(inputChannel);
        } else {
            // ゲイン適用（インライン計算）
            for (let i = 0; i < length; i++) {
                outputChannel[i] = inputChannel[i] * gain;
            }
        }

        return true;
    }
}

registerProcessor('passthrough-processor', PassthroughProcessor);
