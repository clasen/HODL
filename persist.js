import Deepbase from 'deepbase';
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

class Persist extends Deepbase {
    constructor(opts) {
        opts.name = 'persist';
        opts.stringify = (obj) => Persist.encrypt(obj, opts.encryptionKey);
        opts.parse = (encryptedData) => Persist.decrypt(encryptedData, opts.encryptionKey);
        super(opts);
    }

    static encrypt(obj, encryptionKey) {
        const salt = crypto.randomBytes(SALT_LENGTH);
        const iv = crypto.randomBytes(IV_LENGTH);
        const key = crypto.scryptSync(encryptionKey, salt, KEY_LENGTH);

        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        const encrypted = Buffer.concat([
            cipher.update(JSON.stringify(obj), 'utf8'),
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();

        return `v2:${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
    }

    static decrypt(encryptedData, encryptionKey) {
        const parts = encryptedData.split(':');

        if (parts[0] === 'v2' && parts.length === 5) {
            const [, saltHex, ivHex, authTagHex, encryptedHex] = parts;
            const salt = Buffer.from(saltHex, 'hex');
            const iv = Buffer.from(ivHex, 'hex');
            const authTag = Buffer.from(authTagHex, 'hex');
            const encrypted = Buffer.from(encryptedHex, 'hex');
            const key = crypto.scryptSync(encryptionKey, salt, KEY_LENGTH);
            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
            decipher.setAuthTag(authTag);

            const decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ]);

            return JSON.parse(decrypted.toString('utf8'));
        }

        return Persist.decryptLegacy(encryptedData, encryptionKey);
    }

    static decryptLegacy(encryptedData, encryptionKey) {
        const [, encrypted] = encryptedData.split(':');
        const payload = Buffer.from(encrypted, 'base64');

        const saltedPrefix = payload.subarray(0, 8).toString('utf8');
        if (saltedPrefix !== 'Salted__') {
            throw new Error('Unsupported encrypted payload format');
        }

        const salt = payload.subarray(8, 16);
        const ciphertext = payload.subarray(16);
        const { key, iv } = Persist.evpBytesToKey(
            Buffer.from(encryptionKey, 'utf8'),
            salt,
            KEY_LENGTH,
            16
        );

        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
    }

    static evpBytesToKey(password, salt, keyLen, ivLen) {
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