import Deepbase from 'deepbase';
import type { ConnectResult } from 'deepbase';
import { encryptedDocument } from 'deepbase/plugins/encryption';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    HODL_FILE_IV_BYTES, HODL_FILE_KEY_BYTES, HODL_FILE_SALT_BYTES, HODL_FILE_SCRYPT,
    formatHodlFile, hodlFileHeader, isHodlFile, parseHodlFile, scryptMemory, type ScryptCost
} from './hodl-file.js';
import { clearSensitiveData } from './sensitive-data.js';
import type { WalletStore } from './wallet-store.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

type PersistOptions = {
    path: string;
    encryptionKey: string;
};

type EncryptionKey = string | Buffer;

class Persist extends Deepbase implements WalletStore {
    private readonly encryptionKey: Buffer;
    private readonly legacy: { profile?: unknown };
    private disposed = false;
    private readonly storagePath: string;

    constructor(opts: PersistOptions) {
        const encryptionKey = Buffer.from(opts.encryptionKey, 'utf8');
        const legacy: { profile?: unknown } = {};
        opts.encryptionKey = '';

        super({
            name: 'persist',
            path: opts.path,
            parse: (text: string) => {
                if (!Persist.isLegacyProfile(text)) return JSON.parse(text);
                legacy.profile = Persist.decryptProfile(text, encryptionKey);
                return {};
            }
        });
        this.use(encryptedDocument({ password: encryptionKey }));

        this.encryptionKey = encryptionKey;
        this.legacy = legacy;
        this.storagePath = opts.path;
    }

    /** Opens the profile, rejecting a wrong password, and rewrites one saved before the encrypted document format. */
    override async connect(): Promise<ConnectResult> {
        const result = await super.connect();
        const { profile } = this.legacy;
        delete this.legacy.profile;
        if (profile === undefined) {
            clearSensitiveData(await this.get());
        } else {
            try {
                await this.set(profile);
                await this.flush();
            } finally { clearSensitiveData(profile); }
        }
        return result;
    }

    async flush(): Promise<void> {
        const descriptor = fs.openSync(path.join(this.storagePath, 'persist.json'), 'r');
        try {
            fs.fchmodSync(descriptor, 0o600);
            fs.fsyncSync(descriptor);
        } finally { fs.closeSync(descriptor); }
        const directory = fs.openSync(this.storagePath, 'r');
        try { fs.fsyncSync(directory); }
        finally { fs.closeSync(directory); }
    }

    /** Whether the password is the one this profile is encrypted with. */
    matchesPassword(password: string): boolean {
        const candidate = Buffer.from(password, 'utf8');
        try {
            return candidate.length === this.encryptionKey.length && crypto.timingSafeEqual(candidate, this.encryptionKey);
        } finally {
            candidate.fill(0);
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }

        try {
            await super.dispose({ clearMemory: true, releaseInstance: true });
        } finally {
            this.encryptionKey.fill(0);
            this.disposed = true;
        }
    }

    static clearSensitiveData(value: unknown): void {
        clearSensitiveData(value);
    }

    /** A .HODL file in the current format, v3. */
    static encrypt(obj: unknown, encryptionKey: EncryptionKey): string {
        const salt = crypto.randomBytes(HODL_FILE_SALT_BYTES);
        const iv = crypto.randomBytes(HODL_FILE_IV_BYTES);
        const header = hodlFileHeader(salt);
        const key = Persist.fileKey(encryptionKey, salt, HODL_FILE_SCRYPT);
        let serialized: Buffer | undefined;

        try {
            serialized = Buffer.from(JSON.stringify(obj), 'utf8');
            const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
            cipher.setAAD(Buffer.from(header, 'utf8'));
            const encrypted = Buffer.concat([
                cipher.update(serialized),
                cipher.final()
            ]);

            return formatHodlFile(header, iv, cipher.getAuthTag(), encrypted);
        } finally {
            key.fill(0);
            serialized?.fill(0);
        }
    }

    private static isLegacyProfile(text: string): boolean {
        return /^v\d+:/.test(text);
    }

    /** Whether the text is a v2 or v3 .HODL file. */
    static isCurrentFormat(encryptedData: string): boolean {
        return isHodlFile(encryptedData);
    }

    /** A v2 or v3 .HODL file. Profiles saved before v2 are read with decryptProfile. */
    static decrypt(encryptedData: string, encryptionKey: EncryptionKey): unknown {
        const file = parseHodlFile(encryptedData);
        const key = Persist.fileKey(encryptionKey, file.salt, file.cost);
        let decrypted: Buffer | undefined;

        try {
            const decipher = crypto.createDecipheriv(ALGORITHM, key, file.iv);
            if (file.additionalData) decipher.setAAD(file.additionalData);
            decipher.setAuthTag(file.tag);

            decrypted = Buffer.concat([
                decipher.update(file.ciphertext),
                decipher.final()
            ]);

            return JSON.parse(decrypted.toString('utf8'));
        } finally {
            key.fill(0);
            decrypted?.fill(0);
        }
    }

    private static fileKey(encryptionKey: EncryptionKey, salt: Uint8Array, cost: ScryptCost): Buffer {
        return crypto.scryptSync(encryptionKey, salt, HODL_FILE_KEY_BYTES, { ...cost, maxmem: scryptMemory(cost) });
    }

    /** A profile saved as a v2 or older string, before the encrypted document format. */
    static decryptProfile(encryptedData: string, encryptionKey: EncryptionKey): unknown {
        return Persist.isCurrentFormat(encryptedData)
            ? Persist.decrypt(encryptedData, encryptionKey)
            : Persist.decryptLegacy(encryptedData, encryptionKey);
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
}

export default Persist;
