import { scryptAsync } from '@noble/hashes/scrypt';
import { webConfig } from '../config.mjs';
import { VaultError } from './vault-error.js';

/** The CLI's .HODL format (Persist.encrypt): v2:salt:iv:tag:ciphertext in hex, scrypt with Node's defaults, AES-256-GCM. */
const SCRYPT = { N: 16_384, r: 8, p: 1, dkLen: 32 };
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type HodlFile = { salt: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer>; sealed: Uint8Array<ArrayBuffer> };

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

/** The CLI profile inside the file. The caller clears it. */
export async function openHodlFile(file: HodlFile, password: string): Promise<unknown> {
    const derived = await scryptAsync(password, file.salt, SCRYPT) as Uint8Array<ArrayBuffer>;
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
        const key = await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, ['decrypt']);
        plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: file.iv, tagLength: TAG_BYTES * 8 }, key, file.sealed));
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch { throw new VaultError('Incorrect password or damaged HODL file.'); }
    finally { derived.fill(0); plaintext?.fill(0); }
}
