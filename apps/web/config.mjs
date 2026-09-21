export const webConfig = {
    previewPort: 4173,
    testTimeoutMs: 30_000,
    serverTimeoutMs: 120_000,
    transfer: {
        requestTimeoutMs: 15_000,
        reviewTtlMs: 60_000
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
        maxBytes: 8 * 1024 * 1024,
        maxJsonDepth: 32,
        database: 'hodl-web',
        databaseVersion: 1,
        store: 'vaults',
        record: 'primary',
        lock: 'hodl-web:primary'
    }
};
