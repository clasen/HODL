import { scryptAsync } from '@noble/hashes/scrypt';
import {
    HODL_FILE_IV_BYTES, HODL_FILE_KEY_BYTES, HODL_FILE_SALT_BYTES, HODL_FILE_SCRYPT, HODL_FILE_TAG_BYTES,
    formatHodlFile, hodlFileHeader, isHodlFile, parseHodlFile as parseFile, type HodlFile, type ScryptCost
} from 'hodl-wallet/browser';
import { webConfig } from '../config.mjs';
import { VaultError } from './vault-error.js';

export type { HodlFile };

export function parseHodlFile(text: string): HodlFile {
    if (new TextEncoder().encode(text).byteLength > webConfig.vault.maxBytes) throw new VaultError('The HODL file exceeds the size limit.');
    if (!isHodlFile(text)) throw new VaultError('Unsupported HODL file. Files saved in the legacy format can no longer be imported.');
    try { return parseFile(text); }
    catch { throw new VaultError('Invalid HODL file.'); }
}

async function fileKey(password: string, salt: Uint8Array, cost: ScryptCost, usage: KeyUsage): Promise<CryptoKey> {
    const derived = await scryptAsync(password, salt, { ...cost, dkLen: HODL_FILE_KEY_BYTES }) as Uint8Array<ArrayBuffer>;
    try { return await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, [usage]); }
    finally { derived.fill(0); }
}

/** A CLI profile as a .HODL file the CLI imports. */
export async function sealHodlFile(profile: unknown, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(HODL_FILE_SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(HODL_FILE_IV_BYTES));
    const header = hodlFileHeader(salt);
    const key = await fileKey(password, salt, HODL_FILE_SCRYPT, 'encrypt');
    const plaintext = new TextEncoder().encode(JSON.stringify(profile));
    try {
        const sealed = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(header), tagLength: HODL_FILE_TAG_BYTES * 8 }, key, plaintext));
        const split = sealed.length - HODL_FILE_TAG_BYTES;
        return formatHodlFile(header, iv, sealed.subarray(split), sealed.subarray(0, split));
    } finally { plaintext.fill(0); }
}

/** The CLI profile inside the file. The caller clears it. */
export async function openHodlFile(file: HodlFile, password: string): Promise<unknown> {
    const key = await fileKey(password, file.salt, file.cost, 'decrypt');
    const sealed = new Uint8Array(file.ciphertext.length + file.tag.length);
    sealed.set(file.ciphertext);
    sealed.set(file.tag, file.ciphertext.length);
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt({
            name: 'AES-GCM', iv: file.iv as Uint8Array<ArrayBuffer>, tagLength: HODL_FILE_TAG_BYTES * 8,
            ...(file.additionalData ? { additionalData: file.additionalData as Uint8Array<ArrayBuffer> } : {})
        }, key, sealed));
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch { throw new VaultError('Incorrect password or damaged HODL file.'); }
    finally { plaintext?.fill(0); }
}
