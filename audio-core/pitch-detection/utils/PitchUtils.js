/**
 * ArrayPool - Float32Arrayオブジェクトプーリング
 * GC回避による低遅延維持
 */
class ArrayPool {
    constructor() {
        this._pools = new Map();
    }

    acquire(size) {
        if (!this._pools.has(size)) {
            this._pools.set(size, []);
        }
        const pool = this._pools.get(size);
        return pool.length > 0 ? pool.pop() : new Float32Array(size);
    }

    release(array) {
        if (!(array instanceof Float32Array)) return;
        const size = array.length;
        if (!this._pools.has(size)) {
            this._pools.set(size, []);
        }
        const pool = this._pools.get(size);
        if (pool.length < 10) {
            array.fill(0);
            pool.push(array);
        }
    }

    clear() {
        this._pools.clear();
    }
}

/**
 * 窓関数生成器
 * 事前計算済み係数テーブル
 */
class WindowFunctions {
    static _cache = new Map();

    static hamming(size) {
        const key = `hamming_${size}`;
        if (this._cache.has(key)) return this._cache.get(key);

        const window = new Float32Array(size);
        const twoPi = 2 * Math.PI;
        for (let i = 0; i < size; i++) {
            window[i] = 0.54 - 0.46 * Math.cos(twoPi * i / (size - 1));
        }
        this._cache.set(key, window);
        return window;
    }

    static hanning(size) {
        const key = `hanning_${size}`;
        if (this._cache.has(key)) return this._cache.get(key);

        const window = new Float32Array(size);
        const twoPi = 2 * Math.PI;
        for (let i = 0; i < size; i++) {
            window[i] = 0.5 * (1 - Math.cos(twoPi * i / (size - 1)));
        }
        this._cache.set(key, window);
        return window;
    }

    static blackman(size) {
        const key = `blackman_${size}`;
        if (this._cache.has(key)) return this._cache.get(key);

        const window = new Float32Array(size);
        const twoPi = 2 * Math.PI;
        const fourPi = 4 * Math.PI;
        for (let i = 0; i < size; i++) {
            const n = i / (size - 1);
            window[i] = 0.42 - 0.5 * Math.cos(twoPi * n) + 0.08 * Math.cos(fourPi * n);
        }
        this._cache.set(key, window);
        return window;
    }

    static apply(data, windowFunc) {
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = data[i] * windowFunc[i];
        }
        return result;
    }

    static applyInPlace(data, windowFunc) {
        for (let i = 0; i < data.length; i++) {
            data[i] *= windowFunc[i];
        }
    }
}

/**
 * 高速FFT実装 - Radix-2 Cooley-Tukey
 */
class FFT {
    constructor(size) {
        this.size = size;
        this.halfSize = size / 2;
        this._bitReverseTable = this._createBitReverseTable(size);
        this._cosSinTable = this._createCosSinTable(size);
    }

    _createBitReverseTable(size) {
        const table = new Uint32Array(size);
        const bits = Math.log2(size);
        for (let i = 0; i < size; i++) {
            let reversed = 0;
            let n = i;
            for (let j = 0; j < bits; j++) {
                reversed = (reversed << 1) | (n & 1);
                n >>= 1;
            }
            table[i] = reversed;
        }
        return table;
    }

    _createCosSinTable(size) {
        const table = new Float32Array(size);
        for (let i = 0; i < size / 2; i++) {
            const angle = -2 * Math.PI * i / size;
            table[i * 2] = Math.cos(angle);
            table[i * 2 + 1] = Math.sin(angle);
        }
        return table;
    }

    forward(real, imag) {
        const n = this.size;
        const bitRev = this._bitReverseTable;
        const cosSin = this._cosSinTable;

        for (let i = 0; i < n; i++) {
            const j = bitRev[i];
            if (i < j) {
                [real[i], real[j]] = [real[j], real[i]];
                [imag[i], imag[j]] = [imag[j], imag[i]];
            }
        }

        for (let len = 2; len <= n; len *= 2) {
            const halfLen = len / 2;
            const tableStep = n / len;
            for (let i = 0; i < n; i += len) {
                for (let j = 0; j < halfLen; j++) {
                    const idx = j * tableStep * 2;
                    const cos = cosSin[idx];
                    const sin = cosSin[idx + 1];
                    const evenIdx = i + j;
                    const oddIdx = i + j + halfLen;
                    const tReal = cos * real[oddIdx] - sin * imag[oddIdx];
                    const tImag = sin * real[oddIdx] + cos * imag[oddIdx];
                    real[oddIdx] = real[evenIdx] - tReal;
                    imag[oddIdx] = imag[evenIdx] - tImag;
                    real[evenIdx] += tReal;
                    imag[evenIdx] += tImag;
                }
            }
        }
    }

    getMagnitude(real, imag, output) {
        for (let i = 0; i < this.halfSize; i++) {
            output[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        }
    }

    getPowerSpectrum(real, imag, output) {
        for (let i = 0; i < this.halfSize; i++) {
            output[i] = real[i] * real[i] + imag[i] * imag[i];
        }
    }
}

/**
 * 放物線補間 - サブサンプル精度
 * 離散ピーク間の真のピーク位置を推定
 */
class ParabolicInterpolation {
    static interpolate(array, peakIndex) {
        if (peakIndex <= 0 || peakIndex >= array.length - 1) {
            return { index: peakIndex, value: array[peakIndex] };
        }

        const y0 = array[peakIndex - 1];
        const y1 = array[peakIndex];
        const y2 = array[peakIndex + 1];

        const denominator = y0 - 2 * y1 + y2;
        if (Math.abs(denominator) < 1e-10) {
            return { index: peakIndex, value: y1 };
        }

        const delta = 0.5 * (y0 - y2) / denominator;
        const refinedValue = y1 - 0.25 * (y0 - y2) * delta;

        return {
            index: peakIndex + delta,
            value: refinedValue
        };
    }

    static interpolateTrough(array, troughIndex) {
        if (troughIndex <= 0 || troughIndex >= array.length - 1) {
            return { index: troughIndex, value: array[troughIndex] };
        }

        const y0 = array[troughIndex - 1];
        const y1 = array[troughIndex];
        const y2 = array[troughIndex + 1];

        const denominator = y0 - 2 * y1 + y2;
        if (Math.abs(denominator) < 1e-10) {
            return { index: troughIndex, value: y1 };
        }

        const delta = 0.5 * (y0 - y2) / denominator;
        const refinedValue = y1 - 0.25 * (y0 - y2) * delta;

        return {
            index: troughIndex + delta,
            value: refinedValue
        };
    }
}

if (typeof window !== 'undefined') {
    window.ArrayPool = ArrayPool;
    window.WindowFunctions = WindowFunctions;
    window.FFT = FFT;
    window.ParabolicInterpolation = ParabolicInterpolation;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ArrayPool, WindowFunctions, FFT, ParabolicInterpolation };
}
