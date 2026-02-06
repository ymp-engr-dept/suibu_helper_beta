/**
 * Suiren Audio Suite - グローバル設定
 * 
 * 本番環境: DEBUG_MODE = false
 * 開発環境: DEBUG_MODE = true
 */

const SUIREN_CONFIG = Object.freeze({
    DEBUG_MODE: false,
    VERSION: '0.52.0',

    // パフォーマンス設定
    SAMPLE_RATE: 48000,
    BUFFER_SIZE: 4096,
    HOP_SIZE: 512,

    // ピッチ検出設定
    MIN_FREQ: 50,
    MAX_FREQ: 2000,
    DEFAULT_A4: 440
});

// グローバルアクセス
window.SUIREN_CONFIG = SUIREN_CONFIG;

// 条件付きログ関数（本番では完全沈黙）
window.debugLog = SUIREN_CONFIG.DEBUG_MODE
    ? (...args) => console.log('[Suiren]', ...args)
    : () => { };
