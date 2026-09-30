import { webConfig } from '../config.mjs';
import { VaultError } from './vault-error.js';

const config = webConfig.vault;

export type VaultEnvelope = {
    format: string;
    version: number;
    kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
    cipher: { name: 'AES-GCM'; iv: string; tagLength: number };
    ciphertext: string;
};

export function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
        throw new VaultError('Invalid backup format.');
    }
}

function base64(bytes: Uint8Array): string {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
}

function decode(value: unknown, length?: number): Uint8Array<ArrayBuffer> {
    if (typeof value !== 'string' || value.length > Math.ceil(config.maxBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new VaultError('Invalid backup format.');
    }
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    if ((length !== undefined && bytes.length !== length) || base64(bytes) !== value) {
        throw new VaultError('Invalid backup format.');
    }
    return bytes;
}

export function parseEnvelope(value: unknown): VaultEnvelope {
    if (!record(value) || value.format !== config.format || value.version !== config.version) {
        throw new VaultError('Unsupported backup. Use a HODL Web v1 backup; import CLI .HODL files with Import HODL File.');
    }
    exactKeys(value, ['format', 'version', 'kdf', 'cipher', 'ciphertext']);
    if (!record(value.kdf) || !record(value.cipher)) throw new VaultError('Invalid backup format.');
    exactKeys(value.kdf, ['name', 'hash', 'iterations', 'salt']);
    exactKeys(value.cipher, ['name', 'iv', 'tagLength']);
    if (value.kdf.name !== 'PBKDF2' || value.kdf.hash !== 'SHA-256' || value.kdf.iterations !== config.iterations ||
        value.cipher.name !== 'AES-GCM' || value.cipher.tagLength !== config.tagBits) {
        throw new VaultError('Unsupported backup parameters.');
    }
    decode(value.kdf.salt, config.saltBytes);
    decode(value.cipher.iv, config.ivBytes);
    if (decode(value.ciphertext).length < config.tagBits / 8) throw new VaultError('The backup is incomplete.');
    return {
        format: config.format,
        version: config.version,
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: config.iterations, salt: value.kdf.salt as string },
        cipher: { name: 'AES-GCM', iv: value.cipher.iv as string, tagLength: config.tagBits },
        ciphertext: value.ciphertext as string
    };
}

export function parseBackup(text: string): VaultEnvelope {
    if (new TextEncoder().encode(text).byteLength > config.maxBytes) throw new VaultError('The backup exceeds the size limit.');
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new VaultError('The backup is not a valid JSON file.'); }
    return parseEnvelope(value);
}

export function validatePassword(password: string, creating: boolean): void {
    if (!password || password.length > config.passwordMaxChars || (creating && password.length < config.passwordMinChars)) {
        throw new VaultError(creating ? `Use a password with at least ${config.passwordMinChars} characters.` : 'Enter a valid password.');
    }
}

export function newSalt(): string {
    return base64(crypto.getRandomValues(new Uint8Array(config.saltBytes)));
}

export async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
    const encoded = new TextEncoder().encode(password);
    try {
        const material = await crypto.subtle.importKey('raw', encoded, 'PBKDF2', false, ['deriveKey']);
        return await crypto.subtle.deriveKey(
            { name: 'PBKDF2', hash: 'SHA-256', iterations: config.iterations, salt: decode(salt, config.saltBytes) },
            material, { name: 'AES-GCM', length: config.keyBits }, false, ['encrypt', 'decrypt']
        );
    } finally { encoded.fill(0); }
}

function aad(envelope: VaultEnvelope): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify({
        format: envelope.format, version: envelope.version, kdf: envelope.kdf, cipher: envelope.cipher
    }));
}

export async function encrypt(data: unknown, key: CryptoKey, salt: string): Promise<VaultEnvelope> {
    const envelope: VaultEnvelope = {
        format: config.format, version: config.version,
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: config.iterations, salt },
        cipher: { name: 'AES-GCM', iv: base64(crypto.getRandomValues(new Uint8Array(config.ivBytes))), tagLength: config.tagBits },
        ciphertext: ''
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    try {
        if (plaintext.byteLength > config.maxBytes) throw new VaultError('The vault exceeds the size limit.');
        const ciphertext = await crypto.subtle.encrypt({
            name: 'AES-GCM', iv: decode(envelope.cipher.iv), additionalData: aad(envelope), tagLength: config.tagBits
        }, key, plaintext);
        envelope.ciphertext = base64(new Uint8Array(ciphertext));
        if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > config.maxBytes) {
            throw new VaultError('The vault exceeds the size limit.');
        }
        return envelope;
    } finally { plaintext.fill(0); }
}

export async function decrypt(envelope: VaultEnvelope, key: CryptoKey): Promise<unknown> {
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt({
            name: 'AES-GCM', iv: decode(envelope.cipher.iv), additionalData: aad(envelope), tagLength: config.tagBits
        }, key, decode(envelope.ciphertext)));
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch { throw new VaultError('Incorrect password or altered vault data.'); }
    finally { plaintext?.fill(0); }
}
