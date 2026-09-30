import { scryptAsync } from '@noble/hashes/scrypt';
import { webConfig } from '../config.mjs';
import { VaultError } from './vault-error.js';

/** The CLI's .HODL format (Persist.encrypt): v2:salt:iv:tag:ciphertext in hex, scrypt with Node's defaults, AES-256-GCM. */
const SCRYPT = { N: 16_384, r: 8, p: 1, dkLen: 32 };
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type HodlFile = { salt: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer>; sealed: Uint8Array<ArrayBuffer> };

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hex(value: string, length?: number): Uint8Array<ArrayBuffer> {
    if (!/^(?:[0-9a-f]{2})+$/i.test(value) || (length !== undefined && value.length !== length * 2)) {
        throw new VaultError('Invalid HODL file.');
    }
    return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16));
}

export function parseHodlFile(text: string): HodlFile {
    if (new TextEncoder().encode(text).byteLength > webConfig.vault.maxBytes) throw new VaultError('The HODL file exceeds the size limit.');
    const parts = text.trim().split(':');
    if (parts[0] !== 'v2' || parts.length !== 5) {
        throw new VaultError('Unsupported HODL file. Files saved in the legacy format can no longer be imported.');
    }
    const ciphertext = hex(parts[4]);
    const tag = hex(parts[3], TAG_BYTES);
    const sealed = new Uint8Array(ciphertext.length + tag.length);
    sealed.set(ciphertext);
    sealed.set(tag, ciphertext.length);
    return { salt: hex(parts[1], SALT_BYTES), iv: hex(parts[2], IV_BYTES), sealed };
}

async function fileKey(password: string, salt: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
    const derived = await scryptAsync(password, salt, SCRYPT) as Uint8Array<ArrayBuffer>;
    try { return await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, [usage]); }
    finally { derived.fill(0); }
}

/** A CLI profile as a .HODL file the CLI imports. */
export async function sealHodlFile(profile: unknown, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await fileKey(password, salt, 'encrypt');
    const plaintext = new TextEncoder().encode(JSON.stringify(profile));
    try {
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8 }, key, plaintext));
        const split = sealed.length - TAG_BYTES;
        return `v2:${toHex(salt)}:${toHex(iv)}:${toHex(sealed.subarray(split))}:${toHex(sealed.subarray(0, split))}`;
    } finally { plaintext.fill(0); }
}

/** The CLI profile inside the file. The caller clears it. */
export async function openHodlFile(file: HodlFile, password: string): Promise<unknown> {
    const key = await fileKey(password, file.salt, 'decrypt');
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: file.iv, tagLength: TAG_BYTES * 8 }, key, file.sealed));
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch { throw new VaultError('Incorrect password or damaged HODL file.'); }
    finally { plaintext?.fill(0); }
}
