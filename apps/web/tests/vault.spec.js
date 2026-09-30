import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { webConfig } from '../config.mjs';
import { BTC_FROM, EVM_FROM, MAIN, PASSWORD, PHRASE, answer, choose, confirm, firstRun, importPhrase, lock, out, prompt, ready, shown, switchNetwork, unlock } from './terminal.js';

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
    await ready(page);
    await choose(page, MAIN, 'Account Settings');
    await choose(page, 'Select an account option:', 'Export Options');
    const downloaded = page.waitForEvent('download');
    await choose(page, 'Select an export option:', 'Export Backup File');
    const text = await readFile(await (await downloaded).path(), 'utf8');
    await ready(page);
    return text;
}
async function restore(page, text, pass = PASSWORD) {
    await choose(page, 'Select an account option:', 'Import Backup File');
    await prompt(page, 'Backup file:').locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await answer(page, 'Backup password', pass);
}

test.beforeEach(async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('encrypted roundtrip, authentication, reload and fresh IVs', async ({ page, browser }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await importPhrase(page);
    await shown(page, BTC_FROM);
    const first = await backup(page);
    const second = await backup(page);
    expect(JSON.parse(first).cipher.iv).not.toBe(JSON.parse(second).cipher.iv);
    expect(await raw(page)).toEqual(JSON.parse(second));
    for (const secret of [PHRASE, PASSWORD, EVM_FROM, BTC_FROM]) expect(second.includes(secret)).toBe(false);
    const visible = await page.locator('body').innerText();
    expect(visible).not.toContain(PHRASE);
    expect(visible).not.toContain(PASSWORD);
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    await page.reload();
    await answer(page, 'Password:', 'incorrect-password');
    await shown(page, 'Incorrect password');
    expect(await raw(page)).toEqual(JSON.parse(second));
    await unlock(page);
    await shown(page, BTC_FROM);
    const clean = await browser.newContext();
    try {
        const other = await clean.newPage();
        await other.goto(page.url());
        await firstRun(other, 'another-password-123');
        const altered = JSON.parse(second);
        altered.ciphertext = (altered.ciphertext[0] === 'A' ? 'B' : 'A') + altered.ciphertext.slice(1);
        await restore(other, JSON.stringify(altered));
        await shown(other, 'Incorrect password');
        expect(await raw(other)).toBeUndefined();
        altered.kdf.iterations++;
        await restore(other, JSON.stringify(altered));
        await shown(other, 'parameters');
        await restore(other, second);
        await ready(other);
        await shown(other, BTC_FROM);
        await switchNetwork(other, 'eth');
        await shown(other, EVM_FROM);
    } finally { await clean.close(); }
    expect(errors).toEqual([]);
});

test('exclusive tab ownership and inactivity lock', async ({ page, context }) => {
    await importPhrase(page);
    const other = await context.newPage();
    await other.clock.install();
    await other.goto(page.url());
    await answer(other, 'Password:', PASSWORD);
    await shown(other, 'another tab');
    await lock(page);
    await expect(prompt(page, 'Password:')).toBeVisible();
    await expect(page.locator('#session-state')).toHaveText('LOCKED');
    await answer(other, 'Password:', PASSWORD);
    await ready(other);
    await shown(other, BTC_FROM);
    await other.clock.fastForward(webConfig.vault.idleMs + 1);
    await expect(prompt(other, 'Password:')).toBeVisible();
    await expect(other.locator('#session-state')).toHaveText('LOCKED');
    await expect(other.locator('#out')).not.toContainText(BTC_FROM);
});

test('create with the keyboard only and lock without retaining inputs', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page, 'Password:')).toBeVisible();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await expect(prompt(page, 'Repeat Password:')).toBeVisible();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await expect(prompt(page, 'Select an account option:')).toBeVisible();
    await page.keyboard.press('Enter'); // Create New Account
    await expect(prompt(page, 'Create account with mnemonic?')).toBeVisible();
    await page.keyboard.press('Enter'); // yes
    await expect(prompt(page, 'Choose mnemonic phrase length:')).toBeVisible();
    await page.keyboard.press('Enter'); // 12 words
    await expect(prompt(page, 'display sensitive information')).toBeVisible();
    await page.keyboard.press('Enter'); // no
    await ready(page);
    await shown(page, 'Address');
    await expect(page.locator('#session-state')).toHaveText('UNLOCKED');
    await lock(page);
    await expect(prompt(page, 'Password:').locator('input')).toHaveValue('');
    await expect(page.locator('#session-state')).toHaveText('LOCKED');
    await expect(page.locator('#out .tbl')).toHaveCount(0);
});

test('failed durable write never reports an opened wallet', async ({ page }) => {
    await page.addInitScript(() => {
        IDBObjectStore.prototype.add = function () { this.transaction.abort(); throw new DOMException('test storage failure', 'QuotaExceededError'); };
    });
    await firstRun(page);
    await choose(page, 'Select an account option:', 'Create New Account');
    await confirm(page, 'Create account with mnemonic?');
    await choose(page, 'Choose mnemonic phrase length:', '12 words (standard)');
    await shown(page, 'Could not save');
    await expect(page.locator('#session-state')).not.toHaveText('UNLOCKED');
    await expect(prompt(page, 'Select an account option:')).toBeVisible();
    expect(await raw(page)).toBeUndefined();
});

for (const [family, network, key] of [
    ['evm', 'eth', '0x' + '0'.repeat(63) + '1'],
    // Scalar 1 is a public test key; do not fund it.
    ['bitcoin', 'btc', 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn']
]) {
    test(`imports ${family} private key and rejects invalid key`, async ({ page }) => {
        await firstRun(page);
        await choose(page, 'Select an account option:', 'Switch Network');
        await choose(page, 'Select the network:', { eth: '[ETH] Ethereum', btc: '[BTC] Bitcoin' }[network]);
        await choose(page, 'Select an account option:', 'Import Private-key');
        const field = prompt(page, 'Private-key (leave empty to cancel):');
        await field.locator('input').fill('invalid');
        await page.keyboard.press('Enter');
        await expect(field.locator('.err')).toContainText('valid private-key');
        expect(await raw(page)).toBeUndefined();
        await field.locator('input').fill(key);
        await page.keyboard.press('Enter');
        await ready(page);
        await shown(page, family === 'evm' ? '[ETH] Ethereum Address' : '[BTC] Bitcoin Address');
        await page.reload();
        await unlock(page);
        await ready(page);
        await choose(page, MAIN, 'Account Settings');
        await choose(page, 'Select an account option:', 'Switch Network');
        const networks = (await prompt(page, 'Select the network:').locator('li.choice').allTextContents()).join('|');
        expect(networks.includes('Bitcoin')).toBe(family === 'bitcoin');
        expect(networks.includes('Ethereum')).toBe(family === 'evm');
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
    await firstRun(page);
    await choose(page, 'Select an account option:', 'Create New Account');
    await confirm(page, 'Create account with mnemonic?');
    await choose(page, 'Choose mnemonic phrase length:', '12 words (standard)');
    await expect.poll(() => page.evaluate(() => typeof window.continueDerivation)).toBe('function');
    await lock(page);
    await page.evaluate(() => window.continueDerivation());
    await expect(prompt(page, 'Password:')).toBeVisible();
    expect(await raw(page)).toBeUndefined();
    await expect.poll(() => page.evaluate(() => navigator.locks.request('hodl-web:primary', { ifAvailable: true }, lock => Boolean(lock)))).toBe(true);
    await expect(page.locator('input[type=password]')).toHaveCount(1);
    await expect(page.locator('input[type=password]')).toHaveValue('');
});

test('secret output disappears on the next key and after its time', async ({ page }) => {
    await page.clock.install();
    await importPhrase(page);
    for (const dismiss of ['key', 'time']) {
        await choose(page, MAIN, 'Account Settings');
        await choose(page, 'Select an account option:', 'Export Options');
        await choose(page, 'Select an export option:', 'Export Private-key');
        await expect(page.locator('#out .secret')).toContainText('abandon abandon');
        await expect(page.locator('#out .secret')).toContainText('SENSITIVE');
        if (dismiss === 'key') await page.keyboard.press('ArrowDown');
        else await page.clock.fastForward(webConfig.terminal.secretMs + 1000);
        await expect(page.locator('#out .secret')).toHaveCount(0);
        await expect(out(page)).not.toContainText('abandon abandon');
        await shown(page, '[sensitive output cleared]');
        await ready(page);
    }
});
