import Deepbase from 'deepbase';
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const SEALED_SECRET_VERSION = 1;
const SENSITIVE_FIELDS = new Set(['privateKey', 'mnemonic']);

type PersistOptions = {
    path: string;
    encryptionKey: string;
};

type EncryptionKey = string | Buffer;

type SealedSecret = {
    __hodlSealed: typeof SEALED_SECRET_VERSION;
    iv: string;
    authTag: string;
    ciphertext: string;
};

class Persist extends Deepbase {
    private readonly encryptionKey: Buffer;
    private readonly memoryKey: Buffer;
    private disposed = false;

    constructor(opts: PersistOptions) {
        const encryptionKey = Buffer.from(opts.encryptionKey, 'utf8');
        const memoryKey = crypto.randomBytes(KEY_LENGTH);
        opts.encryptionKey = '';

        super({
            name: 'persist',
            path: opts.path,
            stringify: (obj: unknown) => Persist.encrypt(obj, encryptionKey),
            parse: (encryptedData: string) => Persist.decrypt(encryptedData, encryptionKey),
            encodeForMemory: (value: unknown, path: string[]) =>
                Persist.transformSecrets(value, path, secret => Persist.sealSecret(secret, memoryKey)),
            decodeFromMemory: (value: unknown, path: string[]) =>
                Persist.transformSecrets(value, path, secret => Persist.unsealSecret(secret, memoryKey))
        });

        this.encryptionKey = encryptionKey;
        this.memoryKey = memoryKey;
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }

        try {
            await super.dispose({ clearMemory: true, releaseInstance: true });
        } finally {
            this.encryptionKey.fill(0);
            this.memoryKey.fill(0);
            this.disposed = true;
        }
    }

    static clearSensitiveData(value: unknown): void {
        if (Array.isArray(value)) {
            value.forEach(item => Persist.clearSensitiveData(item));
            return;
        }

        if (!Persist.isRecord(value)) {
            return;
        }

        for (const [key, item] of Object.entries(value)) {
            if (SENSITIVE_FIELDS.has(key)) {
                value[key] = '';
            } else {
                Persist.clearSensitiveData(item);
            }
        }
    }

    static encrypt(obj: unknown, encryptionKey: EncryptionKey): string {
        const salt = crypto.randomBytes(SALT_LENGTH);
        const iv = crypto.randomBytes(IV_LENGTH);
        const key = crypto.scryptSync(encryptionKey, salt, KEY_LENGTH);
        let serialized: Buffer | undefined;

        try {
            serialized = Buffer.from(JSON.stringify(obj), 'utf8');
            const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
            const encrypted = Buffer.concat([
                cipher.update(serialized),
                cipher.final()
            ]);
            const authTag = cipher.getAuthTag();

            return `v2:${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
        } finally {
            key.fill(0);
            serialized?.fill(0);
        }
    }

    static decrypt(encryptedData: string, encryptionKey: EncryptionKey): unknown {
        const parts = encryptedData.split(':');

        if (parts[0] === 'v2' && parts.length === 5) {
            const [, saltHex, ivHex, authTagHex, encryptedHex] = parts;
            const salt = Buffer.from(saltHex, 'hex');
            const iv = Buffer.from(ivHex, 'hex');
            const authTag = Buffer.from(authTagHex, 'hex');
            const encrypted = Buffer.from(encryptedHex, 'hex');
            const key = crypto.scryptSync(encryptionKey, salt, KEY_LENGTH);
            let decrypted: Buffer | undefined;

            try {
                const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
                decipher.setAuthTag(authTag);

                decrypted = Buffer.concat([
                    decipher.update(encrypted),
                    decipher.final()
                ]);

                return JSON.parse(decrypted.toString('utf8'));
            } finally {
                key.fill(0);
                decrypted?.fill(0);
            }
        }

        return Persist.decryptLegacy(encryptedData, encryptionKey);
    }

    static decryptLegacy(encryptedData: string, encryptionKey: EncryptionKey): unknown {
        const [, encrypted] = encryptedData.split(':');
        const payload = Buffer.from(encrypted, 'base64');

        const saltedPrefix = payload.subarray(0, 8).toString('utf8');
        if (saltedPrefix !== 'Salted__') {
            throw new Error('Unsupported encrypted payload format');
        }

        const salt = payload.subarray(8, 16);
        const ciphertext = payload.subarray(16);
        const password = Buffer.isBuffer(encryptionKey)
            ? Buffer.from(encryptionKey)
            : Buffer.from(encryptionKey, 'utf8');
        const { key, iv } = Persist.evpBytesToKey(
            password,
            salt,
            KEY_LENGTH,
            16
        );
        let decrypted: Buffer | undefined;

        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return JSON.parse(decrypted.toString('utf8'));
        } finally {
            password.fill(0);
            key.fill(0);
            iv.fill(0);
            decrypted?.fill(0);
        }
    }

    static evpBytesToKey(
        password: Buffer,
        salt: Buffer,
        keyLen: number,
        ivLen: number
    ): { key: Buffer; iv: Buffer } {
        let derived = Buffer.alloc(0);
        let block = Buffer.alloc(0);

        while (derived.length < keyLen + ivLen) {
            const hash = crypto.createHash('md5');
            hash.update(block);
            hash.update(password);
            hash.update(salt);
            block = hash.digest();
            derived = Buffer.concat([derived, block]);
        }

        return {
            key: derived.subarray(0, keyLen),
            iv: derived.subarray(keyLen, keyLen + ivLen)
        };
    }

    private static transformSecrets(
        value: unknown,
        path: string[],
        transform: (secret: string | SealedSecret) => string | SealedSecret
    ): unknown {
        if (Persist.isSensitivePath(path)) {
            return transform(value as string | SealedSecret);
        }

        if (Array.isArray(value)) {
            return value.map((item, index) =>
                Persist.transformSecrets(item, [...path, String(index)], transform)
            );
        }

        if (Persist.isRecord(value)) {
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    key,
                    Persist.transformSecrets(item, [...path, key], transform)
                ])
            );
        }

        return value;
    }

    private static isSensitivePath(path: string[]): boolean {
        const field = path.at(-1);
        return field !== undefined && SENSITIVE_FIELDS.has(field);
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private static isSealedSecret(value: unknown): value is SealedSecret {
        if (!Persist.isRecord(value)) {
            return false;
        }

        return (
            value.__hodlSealed === SEALED_SECRET_VERSION &&
            typeof value.iv === 'string' &&
            typeof value.authTag === 'string' &&
            typeof value.ciphertext === 'string'
        );
    }

    private static sealSecret(secret: string | SealedSecret, memoryKey: Buffer): SealedSecret {
        if (typeof secret !== 'string') {
            throw new TypeError('Sensitive values must be strings before entering memory');
        }

        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, memoryKey, iv);
        const plaintext = Buffer.from(secret, 'utf8');

        try {
            const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

            return {
                __hodlSealed: SEALED_SECRET_VERSION,
                iv: iv.toString('hex'),
                authTag: cipher.getAuthTag().toString('hex'),
                ciphertext: ciphertext.toString('hex')
            };
        } finally {
            plaintext.fill(0);
        }
    }

    private static unsealSecret(secret: string | SealedSecret, memoryKey: Buffer): string {
        if (!Persist.isSealedSecret(secret)) {
            throw new TypeError('Sensitive value is not sealed in memory');
        }

        const iv = Buffer.from(secret.iv, 'hex');
        const authTag = Buffer.from(secret.authTag, 'hex');
        const ciphertext = Buffer.from(secret.ciphertext, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, memoryKey, iv);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        try {
            return plaintext.toString('utf8');
        } finally {
            plaintext.fill(0);
        }
    }
}

export default Persist;
