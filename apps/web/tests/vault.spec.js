import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { webConfig } from '../config.mjs';

// Public BIP39 test vector, never funded.
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const password = 'browser-test-password';
const address = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

async function action(page, name) {
    await page.locator('#view').focus();
    await page.keyboard.press('/');
    await page.locator('#action-search').fill(name);
    await page.keyboard.press('Enter');
}
async function credentials(page) {
    await page.locator('#password').fill(password);
    await page.locator('#confirmation').fill(password);
}
async function imported(page) {
    await page.goto('/');
    await action(page, 'Import phrase');
    await page.locator('#mnemonic').fill(phrase);
    await credentials(page);
    await page.getByRole('button', { name: 'Import wallet', exact: true }).click();
    await expect(page.locator('#address-evm')).toHaveValue(address);
}
async function raw(page) {
    return page.evaluate(config => new Promise((resolve, reject) => {
        const request = indexedDB.open(config.database, config.databaseVersion);
        request.onerror = () => reject(new Error('read failed'));
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(config.store, 'readonly');
            const get = tx.objectStore(config.store).get(config.record);
            tx.oncomplete = () => { db.close(); resolve(get.result); };
        };
    }), webConfig.vault);
}
async function backup(page) {
    await action(page, 'Save encrypted backup');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download encrypted backup' }).click();
    return readFile(await (await downloaded).path(), 'utf8');
}
async function restore(page, text, pass = password) {
    await page.locator('#backup-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await page.locator('#password').fill(pass);
    await page.getByRole('button', { name: 'Restore wallet', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('encrypted roundtrip, authentication, reload and fresh IVs', async ({ page, browser }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await imported(page);
    const btc = await page.locator('#address-bitcoin').inputValue();
    const first = await backup(page);
    const second = await backup(page);
    expect(JSON.parse(first).cipher.iv).not.toBe(JSON.parse(second).cipher.iv);
    expect(await raw(page)).toEqual(JSON.parse(second));
    for (const secret of [phrase, password, address, btc]) expect(second.includes(secret)).toBe(false);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your wallet is locked' })).toBeVisible();
    await page.locator('#password').fill('incorrect-password');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Incorrect password');
    expect(await raw(page)).toEqual(JSON.parse(second));
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.locator('#address-bitcoin')).toHaveValue(btc);
    const clean = await browser.newContext();
    try {
        const other = await clean.newPage();
        await other.goto(page.url());
        await action(other, 'Restore backup');
        const altered = JSON.parse(second);
        altered.ciphertext = (altered.ciphertext[0] === 'A' ? 'B' : 'A') + altered.ciphertext.slice(1);
        await restore(other, JSON.stringify(altered));
        await expect(other.locator('#notice')).toContainText('Incorrect password');
        expect(await raw(other)).toBeUndefined();
        altered.kdf.iterations++;
        await restore(other, JSON.stringify(altered));
        await expect(other.locator('#notice')).toContainText('parameters');
        await restore(other, second);
        await expect(other.locator('#address-evm')).toHaveValue(address);
        await expect(other.locator('#address-bitcoin')).toHaveValue(btc);
    } finally { await clean.close(); }
    expect(errors).toEqual([]);
});

test('exclusive tab ownership and inactivity lock', async ({ page, context }) => {
    await imported(page);
    const other = await context.newPage();
    await other.clock.install();
    await other.goto(page.url());
    await other.locator('#password').fill(password);
    await other.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(other.locator('#notice')).toContainText('another tab');
    await page.locator('#lock').click();
    await expect(page.locator('#address-evm')).toHaveCount(0);
    await other.locator('#password').fill(password);
    await other.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(other.locator('#address-evm')).toHaveValue(address);
    await other.clock.fastForward(webConfig.vault.idleMs + 1);
    await expect(other.getByRole('heading', { name: 'Your wallet is locked' })).toBeVisible();
});

test('create with keyboard and cancel without retaining inputs', async ({ page }) => {
    await page.goto('/');
    await action(page, 'Create wallet');
    await page.keyboard.type('Keyboard wallet');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await page.keyboard.type(password);
    await page.keyboard.press('Tab');
    await page.keyboard.type(password);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('#address-evm')).toBeVisible();
    await expect(page.locator('#address-bitcoin')).toBeVisible();
    await action(page, 'Lock wallet');
    await expect(page.locator('#password')).toHaveValue('');
    await expect(page.locator('#session-state')).toHaveText('Locked');
});

test('failed durable write never reports an opened wallet', async ({ page }) => {
    await page.addInitScript(() => {
        IDBObjectStore.prototype.add = function () { this.transaction.abort(); throw new DOMException('test storage failure', 'QuotaExceededError'); };
    });
    await page.goto('/');
    await action(page, 'Create wallet');
    await credentials(page);
    await page.getByRole('button', { name: 'Create wallet', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Could not save');
    await expect(page.locator('#session-state')).toHaveText('Locked');
    expect(await raw(page)).toBeUndefined();
});

for (const family of ['evm', 'bitcoin']) {
    test(`imports ${family} private key and rejects invalid key`, async ({ page }) => {
        await page.goto('/');
        await action(page, 'Import private key');
        await page.locator('#family').selectOption(family);
        await page.locator('#private-key').fill('invalid');
        await credentials(page);
        await page.getByRole('button', { name: 'Import wallet', exact: true }).click();
        await expect(page.locator('#notice')).toContainText('private key is invalid');
        expect(await raw(page)).toBeUndefined();
        await page.locator('#family').selectOption(family);
        // Scalar 1 is a public test key; do not fund it.
        await page.locator('#private-key').fill(family === 'evm'
            ? '0x' + '0'.repeat(63) + '1'
            : 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn');
        await credentials(page);
        await page.getByRole('button', { name: 'Import wallet', exact: true }).click();
        await expect(page.locator(`#address-${family}`)).toBeVisible();
        await expect(page.locator(`#address-${family === 'evm' ? 'bitcoin' : 'evm'}`)).toHaveCount(0);
        await page.reload();
        await page.locator('#password').fill(password);
        await page.getByRole('button', { name: 'Unlock', exact: true }).click();
        await expect(page.locator(`#address-${family}`)).toBeVisible();
    });
}

test('cancel during key derivation prevents persistence and releases ownership', async ({ page }) => {
    await page.addInitScript(() => {
        const original = SubtleCrypto.prototype.deriveKey;
        SubtleCrypto.prototype.deriveKey = async function (...args) {
            await new Promise(resolve => { window.continueDerivation = resolve; });
            return original.apply(this, args);
        };
    });
    await page.goto('/');
    await action(page, 'Create wallet');
    await credentials(page);
    await page.getByRole('button', { name: 'Create wallet', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof window.continueDerivation)).toBe('function');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.continueDerivation());
    await expect(page.locator('#lock')).toBeHidden();
    expect(await raw(page)).toBeUndefined();
    await expect.poll(() => page.evaluate(() => navigator.locks.request('hodl-web:primary', { ifAvailable: true }, lock => Boolean(lock)))).toBe(true);
    await expect(page.locator('input[type=password]')).toHaveCount(0);
});
