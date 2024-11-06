import Deepbase from 'deepbase';
import CryptoJS from 'crypto-js';

class Persist extends Deepbase {
    constructor(opts) {
        opts.name = 'persist';
        opts.stringify = (obj) => Persist.encrypt(obj, opts.encryptionKey);
        opts.parse = (encryptedData) => Persist.decrypt(encryptedData, opts.encryptionKey);
        super(opts);
    }

    static encrypt(obj, encryptionKey) {
        const iv = CryptoJS.lib.WordArray.random(128 / 8);
        const encrypted = CryptoJS.AES.encrypt(JSON.stringify(obj), encryptionKey, { iv });
        return iv.toString(CryptoJS.enc.Hex) + ':' + encrypted.toString();
    }

    static decrypt(encryptedData, encryptionKey) {
        const [ivHex, encrypted] = encryptedData.split(':');
        const iv = CryptoJS.enc.Hex.parse(ivHex);
        const bytes = CryptoJS.AES.decrypt(encrypted, encryptionKey, { iv });
        return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
    }
}

export default Persist;