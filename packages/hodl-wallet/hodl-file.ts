/**
 * The encrypted .HODL format shared by the CLI and the web: scrypt, then AES-256-GCM, in hex.
 * v3 is `v3:N:r:p:salt:iv:tag:ciphertext` and authenticates `v3:N:r:p:salt` as additional data.
 * v2 is `v2:salt:iv:tag:ciphertext` with scrypt at N=2^14, r=8, p=1; it is read, never written.
 */

export type ScryptCost = { N: number; r: number; p: number };

export type HodlFile = {
    cost: ScryptCost;
    salt: Uint8Array;
    iv: Uint8Array;
    tag: Uint8Array;
    ciphertext: Uint8Array;
    additionalData?: Uint8Array;
};

export const HODL_FILE_SCRYPT: ScryptCost = { N: 2 ** 17, r: 8, p: 1 };
export const HODL_FILE_KEY_BYTES = 32;
export const HODL_FILE_SALT_BYTES = 16;
export const HODL_FILE_IV_BYTES = 12;
export const HODL_FILE_TAG_BYTES = 16;

const V2_SCRYPT: ScryptCost = { N: 2 ** 14, r: 8, p: 1 };
const MIN_SCRYPT_N = 2 ** 14;
const MAX_SCRYPT_P = 16;
// Bounds the header too, so a forged one cannot exhaust memory before authentication fails.
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;

const UNSUPPORTED = 'Unsupported encrypted payload format';

/** Whether the text has the shape of a v2 or v3 file. Older files start differently. */
export function isHodlFile(text: string): boolean {
    const parts = text.trim().split(':');
    return (parts[0] === 'v2' && parts.length === 5) || (parts[0] === 'v3' && parts.length === 8);
}

/** Scrypt's working memory for the cost, as Node's `maxmem` must allow it. */
export function scryptMemory({ N, r, p }: ScryptCost): number {
    return 128 * r * (N + p + 2);
}

export function parseHodlFile(text: string): HodlFile {
    if (!isHodlFile(text)) throw new Error(UNSUPPORTED);
    const parts = text.trim().split(':');
    if (parts[0] === 'v2') {
        const [, salt, iv, tag, ciphertext] = parts;
        return { cost: V2_SCRYPT, ...sealedParts(salt, iv, tag, ciphertext) };
    }
    const [, N, r, p, salt, iv, tag, ciphertext] = parts;
    const cost = { N: decimal(N), r: decimal(r), p: decimal(p) };
    if (!validCost(cost)) throw new Error(UNSUPPORTED);
    return { cost, ...sealedParts(salt, iv, tag, ciphertext), additionalData: utf8(parts.slice(0, 5).join(':')) };
}

/** The v3 header for a new file; its text is also the file's additional data. */
export function hodlFileHeader(salt: Uint8Array, cost: ScryptCost = HODL_FILE_SCRYPT): string {
    if (!validCost(cost) || salt.length !== HODL_FILE_SALT_BYTES) throw new Error(UNSUPPORTED);
    return `v3:${cost.N}:${cost.r}:${cost.p}:${toHex(salt)}`;
}

export function formatHodlFile(header: string, iv: Uint8Array, tag: Uint8Array, ciphertext: Uint8Array): string {
    return `${header}:${toHex(iv)}:${toHex(tag)}:${toHex(ciphertext)}`;
}

function sealedParts(salt: string, iv: string, tag: string, ciphertext: string) {
    return {
        salt: fromHex(salt, HODL_FILE_SALT_BYTES),
        iv: fromHex(iv, HODL_FILE_IV_BYTES),
        tag: fromHex(tag, HODL_FILE_TAG_BYTES),
        ciphertext: fromHex(ciphertext)
    };
}

function validCost({ N, r, p }: ScryptCost): boolean {
    return Number.isSafeInteger(r) && r >= 1
        && Number.isSafeInteger(p) && p >= 1 && p <= MAX_SCRYPT_P
        && Number.isSafeInteger(N) && N >= MIN_SCRYPT_N && (N & (N - 1)) === 0
        && 128 * N * r <= MAX_SCRYPT_MEMORY;
}

function decimal(value: string): number {
    return /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : NaN;
}

function utf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string, length?: number): Uint8Array {
    if (!/^(?:[0-9a-f]{2})+$/i.test(value) || (length !== undefined && value.length !== length * 2)) {
        throw new Error(UNSUPPORTED);
    }
    return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16));
}
