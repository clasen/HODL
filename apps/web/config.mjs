export const webConfig = {
    previewPort: 4173,
    testTimeoutMs: 30_000,
    serverTimeoutMs: 120_000,
    transfer: {
        requestTimeoutMs: 15_000,
        reviewTtlMs: 60_000
    },
    terminal: {
        displayStorageKey: 'hodl-web:display',
        secretMs: 15_000,
        scrollbackMax: 400,
        spinnerMs: 80,
        presets: ['p1', 'p3', 'ice'],
        sweeps: ['full', 'soft', 'off'],
        textScales: [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8],
        defaults: { preset: 'p1', sweep: 'off', textScale: 1.1, scanlines: true, curvature: true, sound: false }
    },
    vault: {
        format: 'hodl-web-vault',
        version: 1,
        iterations: 600_000,
        saltBytes: 16,
        ivBytes: 12,
        keyBits: 256,
        tagBits: 128,
        idleMs: 300_000,
        passwordMinChars: 12,
        passwordMaxChars: 1024,
        nameMaxChars: 64,
        defaultName: 'My wallet',
        maxBytes: 8 * 1024 * 1024,
        maxJsonDepth: 32,
        database: 'hodl-web',
        databaseVersion: 1,
        store: 'vaults',
        record: 'primary',
        lock: 'hodl-web:primary'
    }
};
