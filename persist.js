// db.js
const Deepbase = require('deepbase');
const CryptoJS = require('crypto-js');

class Persist extends Deepbase {
    constructor(encryptionKey) {
        super();
        this.encryptionKey = encryptionKey;
    }

    encrypt(data) {
        const iv = CryptoJS.lib.WordArray.random(128/8);
        const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), this.encryptionKey, { iv });
        return iv.toString(CryptoJS.enc.Hex) + ':' + encrypted.toString();
    }

    decrypt(encryptedData) {
        const [ivHex, encrypted] = encryptedData.split(':');
        const iv = CryptoJS.enc.Hex.parse(ivHex);
        const bytes = CryptoJS.AES.decrypt(encrypted, this.encryptionKey, { iv });
        return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
    }

    // Method to set encrypted account
    secureSet(key, value) {
        const encryptedData = this.encrypt(value);
        return this.set(key, encryptedData);
    }

    // Method to retrieve encrypted account
    secureGet(key) {
        const data = this.get(key);
        if (!data) return "";
        try {
            // Attempt to decrypt
            return this.decrypt(data);
        } catch (error) {
            return null;
        }
    }
}

module.exports = Persist;
