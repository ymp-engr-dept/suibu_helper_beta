/**
 * KalmanFilter - 1次元カルマンフィルタによるピッチ安定化
 * 信頼度低下時に直前のトレンドからピッチを予測
 */
class KalmanFilter {
    constructor(options = {}) {
        this.processNoise = options.processNoise ?? 0.01;
        this.measurementNoise = options.measurementNoise ?? 0.1;
        this.initialEstimate = options.initialEstimate ?? 0;
        this.initialErrorCovariance = options.initialErrorCovariance ?? 1;

        this.estimate = this.initialEstimate;
        this.errorCovariance = this.initialErrorCovariance;
        this.velocity = 0;
        this.lastTimestamp = 0;
    }

    predict(timestamp) {
        const dt = this.lastTimestamp > 0 ? (timestamp - this.lastTimestamp) / 1000 : 0;
        if (dt > 0 && dt < 1) {
            this.estimate += this.velocity * dt;
        }
        this.errorCovariance += this.processNoise;
    }

    update(measurement, confidence, timestamp) {
        const dt = this.lastTimestamp > 0 ? (timestamp - this.lastTimestamp) / 1000 : 0;

        const effectiveMeasurementNoise = this.measurementNoise / Math.max(confidence, 0.1);
        const kalmanGain = this.errorCovariance / (this.errorCovariance + effectiveMeasurementNoise);

        const prevEstimate = this.estimate;
        this.estimate = this.estimate + kalmanGain * (measurement - this.estimate);
        this.errorCovariance = (1 - kalmanGain) * this.errorCovariance;

        if (dt > 0 && dt < 1 && confidence > 0.5) {
            const newVelocity = (this.estimate - prevEstimate) / dt;
            this.velocity = 0.7 * this.velocity + 0.3 * newVelocity;
        }

        this.lastTimestamp = timestamp;
        return this.estimate;
    }

    filter(measurement, confidence, timestamp) {
        if (this.estimate === 0) {
            this.estimate = measurement;
            this.lastTimestamp = timestamp;
            return measurement;
        }

        this.predict(timestamp);
        return this.update(measurement, confidence, timestamp);
    }

    getState() {
        return {
            estimate: this.estimate,
            velocity: this.velocity,
            errorCovariance: this.errorCovariance
        };
    }

    reset() {
        this.estimate = this.initialEstimate;
        this.errorCovariance = this.initialErrorCovariance;
        this.velocity = 0;
        this.lastTimestamp = 0;
    }

    setProcessNoise(value) {
        this.processNoise = value;
    }

    setMeasurementNoise(value) {
        this.measurementNoise = value;
    }
}

/**
 * ViterbiDecoder - 隠れマルコフモデルによる軌跡最適化
 * フレーム間ピッチ差へのペナルティで音楽的に自然な遷移を維持
 */
class ViterbiDecoder {
    constructor(options = {}) {
        this.numStates = options.numStates ?? 360;
        this.minFreq = options.minFreq ?? 50;
        this.maxFreq = options.maxFreq ?? 2000;
        this.transitionPenalty = options.transitionPenalty ?? 0.1;
        this.selfTransitionProb = options.selfTransitionProb ?? 0.99;

        this._freqBins = this._createFreqBins();
        this._history = [];
        this._maxHistory = options.maxHistory ?? 10;
        this._prevState = -1;
        this._prevCost = new Float32Array(this.numStates);
        this._currCost = new Float32Array(this.numStates);
        this._backpointer = [];
    }

    _createFreqBins() {
        const bins = new Float32Array(this.numStates);
        const minCents = 1200 * Math.log2(this.minFreq / 440);
        const maxCents = 1200 * Math.log2(this.maxFreq / 440);
        const step = (maxCents - minCents) / (this.numStates - 1);

        for (let i = 0; i < this.numStates; i++) {
            const cents = minCents + step * i;
            bins[i] = 440 * Math.pow(2, cents / 1200);
        }
        return bins;
    }

    _freqToState(freq) {
        if (freq < this.minFreq) return 0;
        if (freq > this.maxFreq) return this.numStates - 1;

        const cents = 1200 * Math.log2(freq / 440);
        const minCents = 1200 * Math.log2(this.minFreq / 440);
        const maxCents = 1200 * Math.log2(this.maxFreq / 440);
        const step = (maxCents - minCents) / (this.numStates - 1);

        return Math.round((cents - minCents) / step);
    }

    _stateToFreq(state) {
        return this._freqBins[Math.max(0, Math.min(state, this.numStates - 1))];
    }

    _emissionProb(state, observation, confidence) {
        const stateFreq = this._stateToFreq(state);
        const centsDiff = Math.abs(1200 * Math.log2(observation / stateFreq));
        const sigma = 20 / confidence;
        return Math.exp(-centsDiff * centsDiff / (2 * sigma * sigma));
    }

    _transitionCost(fromState, toState) {
        const diff = Math.abs(fromState - toState);
        if (diff === 0) return -Math.log(this.selfTransitionProb);
        return diff * this.transitionPenalty;
    }

    decode(freq, confidence) {
        if (freq <= 0 || confidence < 0.1) {
            if (this._prevState >= 0) {
                return this._stateToFreq(this._prevState);
            }
            return 0;
        }

        const observationState = this._freqToState(freq);

        if (this._prevState < 0) {
            this._prevState = observationState;
            this._prevCost.fill(Infinity);
            this._prevCost[observationState] = -Math.log(Math.max(confidence, 0.01));
            return freq;
        }

        this._currCost.fill(Infinity);

        const searchRange = Math.min(50, this.numStates);
        const centerState = this._prevState;
        const startState = Math.max(0, centerState - searchRange);
        const endState = Math.min(this.numStates, centerState + searchRange);

        for (let j = startState; j < endState; j++) {
            const emission = -Math.log(Math.max(this._emissionProb(j, freq, confidence), 1e-10));

            let minCost = Infinity;
            for (let i = startState; i < endState; i++) {
                const transition = this._transitionCost(i, j);
                const cost = this._prevCost[i] + transition + emission;
                if (cost < minCost) {
                    minCost = cost;
                }
            }
            this._currCost[j] = minCost;
        }

        let bestState = observationState;
        let bestCost = this._currCost[observationState];
        for (let j = startState; j < endState; j++) {
            if (this._currCost[j] < bestCost) {
                bestCost = this._currCost[j];
                bestState = j;
            }
        }

        [this._prevCost, this._currCost] = [this._currCost, this._prevCost];
        this._prevState = bestState;

        return this._stateToFreq(bestState);
    }

    reset() {
        this._prevState = -1;
        this._prevCost.fill(0);
        this._currCost.fill(0);
        this._backpointer = [];
    }
}

if (typeof window !== 'undefined') {
    window.KalmanFilter = KalmanFilter;
    window.ViterbiDecoder = ViterbiDecoder;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KalmanFilter, ViterbiDecoder };
}
