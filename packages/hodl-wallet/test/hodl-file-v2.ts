import crypto from 'node:crypto';

/** A .HODL file as releases before v3 wrote it: scrypt with Node's defaults, no additional data. */
export function sealV2HodlFile(value: unknown, password: string): string {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(password, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    key.fill(0);
    return ['v2', salt, iv, cipher.getAuthTag(), ciphertext].map(part => typeof part === 'string' ? part : part.toString('hex')).join(':');
}
