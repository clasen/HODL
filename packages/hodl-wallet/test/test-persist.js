#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Persist from '../persist.js';

const PASSWORD = 'test-password';
const PRIVATE_KEY = '0x0123456789abcdef';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * @param {Buffer} password
 * @param {Buffer} salt
 * @param {number} keyLength
 * @param {number} ivLength
 */
function evpBytesToKey(password, salt, keyLength, ivLength) {
    let derived = Buffer.alloc(0);
    let block = Buffer.alloc(0);

    while (derived.length < keyLength + ivLength) {
        const hash = crypto.createHash('md5');
        hash.update(block);
        hash.update(password);
        hash.update(salt);
        block = hash.digest();
        derived = Buffer.concat([derived, block]);
    }

    return {
        key: derived.subarray(0, keyLength),
        iv: derived.subarray(keyLength, keyLength + ivLength)
    };
}

/**
 * @param {unknown} value
 * @param {string} password
 */
function encryptLegacy(value, password) {
    const salt = crypto.randomBytes(8);
    const passwordBuffer = Buffer.from(password, 'utf8');
    const { key, iv } = evpBytesToKey(passwordBuffer, salt, 32, 16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');

    try {
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const payload = Buffer.concat([Buffer.from('Salted__'), salt, ciphertext]);
        return `v1:${payload.toString('base64')}`;
    } finally {
        passwordBuffer.fill(0);
        key.fill(0);
        iv.fill(0);
        plaintext.fill(0);
    }
}

/** @param {string} directory */
function storedEnvelope(directory) {
    return JSON.parse(fs.readFileSync(path.join(directory, 'persist.json'), 'utf8')).$deepbase;
}

async function testEncryptedDocumentAndRoundTrip() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-persist-'));
    const db = new Persist({ path: directory, encryptionKey: PASSWORD });

    try {
        await db.connect();
        await db.set('account', 'Web3Network', {
            address: '0x1234',
            privateKey: PRIVATE_KEY,
            mnemonic: MNEMONIC
        });
        await db.set('mnemonic', MNEMONIC);

        const driver = /** @type {import('deepbase').DeepBaseDriver & { obj: Record<string, unknown> }} */ (db.getDriver());
        assert.deepEqual(Object.keys(driver.obj), ['$deepbase']);
        const encryptedFile = fs.readFileSync(path.join(directory, 'persist.json'), 'utf8');
        for (const stored of [JSON.stringify(driver.obj), encryptedFile]) {
            for (const plaintext of [PRIVATE_KEY, MNEMONIC, '0x1234', 'Web3Network', 'account']) {
                assert.equal(stored.includes(plaintext), false);
            }
        }
        assert.equal(storedEnvelope(directory).kdf.N, 2 ** 17);

        const account = await db.get('account', 'Web3Network');
        assert.equal(account.privateKey, PRIVATE_KEY);
        assert.equal(account.mnemonic, MNEMONIC);
        assert.equal(db.getSync('mnemonic'), MNEMONIC);

        Persist.clearSensitiveData(account);
        assert.equal(account.privateKey, '');
        assert.equal(account.mnemonic, '');
    } finally {
        await db.dispose();
    }

    const disposedDriver = /** @type {import('deepbase').DeepBaseDriver & { obj: unknown }} */ (db.getDriver());
    assert.deepEqual(disposedDriver.obj, {});
    await assert.rejects(db.get('mnemonic'), /disposed/);

    const reopened = new Persist({ path: directory, encryptionKey: PASSWORD });
    try {
        await reopened.connect();
        assert.equal(await reopened.get('mnemonic'), MNEMONIC);
        assert.equal(reopened.matchesPassword(PASSWORD), true);
        for (const other of ['', 'wrong-password', `${PASSWORD}x`, PASSWORD.slice(0, -1)]) {
            assert.equal(reopened.matchesPassword(other), false);
        }
    } finally {
        await reopened.dispose();
    }

    const before = fs.readFileSync(path.join(directory, 'persist.json'), 'utf8');
    const wrongPassword = new Persist({ path: directory, encryptionKey: 'wrong-password' });
    try {
        await assert.rejects(wrongPassword.connect());
    } finally {
        await wrongPassword.dispose();
    }
    assert.equal(fs.readFileSync(path.join(directory, 'persist.json'), 'utf8'), before);

    const envelope = storedEnvelope(directory);
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    for (const tampered of [{ ...envelope, ciphertext: ciphertext.toString('base64') }, { ...envelope, kdf: { ...envelope.kdf, N: 2 ** 18 } }]) {
        fs.writeFileSync(path.join(directory, 'persist.json'), JSON.stringify({ $deepbase: tampered }));
        const db = new Persist({ path: directory, encryptionKey: PASSWORD });
        try {
            await assert.rejects(db.connect(), { code: 'ENCRYPTION_AUTHENTICATION_FAILED' });
        } finally {
            await db.dispose();
        }
    }
    fs.rmSync(directory, { recursive: true, force: true });
}

async function testLegacyMigration() {
    for (const [format, encrypt] of /** @type {const} */ ([['v1', encryptLegacy], ['v2', Persist.encrypt]])) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-legacy-'));
        const filePath = path.join(directory, 'persist.json');
        fs.writeFileSync(filePath, encrypt({ mnemonic: MNEMONIC }, PASSWORD));

        const wrongPassword = new Persist({ path: directory, encryptionKey: 'wrong-password' });
        try {
            await assert.rejects(wrongPassword.connect());
        } finally {
            await wrongPassword.dispose();
        }
        assert.equal(fs.readFileSync(filePath, 'utf8').startsWith(`${format}:`), true);

        const db = new Persist({ path: directory, encryptionKey: PASSWORD });
        try {
            await db.connect();
            assert.equal(await db.get('mnemonic'), MNEMONIC);
        } finally {
            await db.dispose();
        }

        assert.equal(fs.readFileSync(filePath, 'utf8').includes(MNEMONIC), false);
        assert.equal(storedEnvelope(directory).plugin, 'encryption');
        const reopened = new Persist({ path: directory, encryptionKey: PASSWORD });
        try {
            await reopened.connect();
            assert.equal(await reopened.get('mnemonic'), MNEMONIC);
        } finally {
            await reopened.dispose();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
    assert.throws(() => Persist.decrypt(encryptLegacy({ mnemonic: MNEMONIC }, PASSWORD), PASSWORD), /Unsupported encrypted payload format/);
}

await testEncryptedDocumentAndRoundTrip();
await testLegacyMigration();
console.log('Persist encrypted document tests passed');
