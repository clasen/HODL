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
/** Opens Export HODL File and accepts the suggested name; returns the name. */
async function startExport(page) {
    await ready(page);
    await choose(page, MAIN, 'Account Settings');
    await choose(page, 'Select an account option:', 'Export Options');
    await choose(page, 'Select an export option:', 'Export HODL File');
    const name = await prompt(page, 'Enter the name for the HODL file:').locator('input').inputValue();
    await page.keyboard.press('Enter');
    return name;
}
/** Exports a .HODL file under its suggested name, sealed like the CLI with the wallet password; returns the name and the file's text. */
async function exportHodl(page) {
    const name = await startExport(page);
    const downloaded = page.waitForEvent('download');
    await answer(page, 'Password:', PASSWORD);
    const download = await downloaded;
    const text = await readFile(await download.path(), 'utf8');
    await shown(page, `Download started: ${name}.HODL`);
    expect(download.suggestedFilename()).toBe(`${name}.HODL`);
    await ready(page);
    return { name, text };
}
/** A .HODL file as the CLI writes it, from a profile shaped like ~/.HODL. */
async function hodlFile(profile, password = HODL_PASSWORD) {
    const { default: Persist } = await import('hodl-wallet/dist/persist.js');
    return Persist.encrypt(profile, password);
}
async function networks() {
    const [evm, btc] = await Promise.all(['eth', 'btc'].map(async id => (await import(`hodl-wallet/dist/network/${id}.js`)).default));
    return { evm: new evm.NetworkClass(evm), btc: new btc.NetworkClass(btc), evmKey: evm.NetworkClass.name, btcKey: btc.NetworkClass.name };
}
/** The file prompt opens the picker by itself, straight from the action that asks for the file. */
async function pickFile(page, open, file) {
    const chooser = page.waitForEvent('filechooser');
    await open();
    await (await chooser).setFiles(file);
}
async function importHodl(page, open, text, pass = HODL_PASSWORD) {
    await pickFile(page, open, { name: 'wallet.HODL', mimeType: 'application/octet-stream', buffer: Buffer.from(text) });
    if (pass !== null) await answer(page, 'Password:', pass);
}
async function replaceWith(page, label) {
    await ready(page);
    await choose(page, MAIN, 'Account Settings');
    await choose(page, 'Select an account option:', 'Import Options');
    await choose(page, 'Select an import option:', label);
    await confirm(page, 'overwrite the existing account');
}
const HODL_PASSWORD = 'cli-pass';

test.beforeEach(async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('encrypted roundtrip, authentication, reload and fresh IVs', async ({ page, browser }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await importPhrase(page);
    await shown(page, BTC_FROM);
    const stored = await raw(page);
    let downloads = 0;
    page.on('download', () => downloads++);
    await startExport(page);
    await answer(page, 'Password:', HODL_PASSWORD);
    await shown(page, 'The password is incorrect');
    const first = await exportHodl(page);
    const { name, text: second } = await exportHodl(page);
    expect(name).toBe(BTC_FROM.slice(-6).toUpperCase());
    const [, firstSalt, firstIv] = first.text.split(':');
    const [, secondSalt, secondIv] = second.split(':');
    expect([secondSalt, secondIv]).not.toEqual([firstSalt, firstIv]);
    for (const secret of [PHRASE, PASSWORD, HODL_PASSWORD, EVM_FROM, BTC_FROM]) {
        expect(second.includes(secret)).toBe(false);
        expect(JSON.stringify(stored).includes(secret)).toBe(false);
    }
    const { default: Persist } = await import('hodl-wallet/dist/persist.js');
    const { evmKey, btcKey } = await networks();
    expect(downloads).toBe(2);
    const profile = Persist.decrypt(second, PASSWORD);
    expect(profile.mnemonic).toBe(PHRASE);
    expect(Object.keys(profile.account).sort()).toEqual([evmKey, btcKey].sort());
    expect(profile.account[evmKey].address).toBe(EVM_FROM);
    expect(profile.account[btcKey].address).toBe(BTC_FROM);
    const visible = await page.locator('body').innerText();
    expect(visible).not.toContain(PHRASE);
    expect(visible).not.toContain(PASSWORD);
    await expect(page.locator('input.masked')).toHaveCount(0);
    await page.reload();
    await answer(page, 'Password:', 'incorrect-password');
    await shown(page, 'Incorrect password');
    expect(await raw(page)).toEqual(stored);
    await unlock(page);
    await shown(page, BTC_FROM);
    const clean = await browser.newContext();
    try {
        const other = await clean.newPage();
        await other.goto(page.url());
        await firstRun(other, 'another-password-123');
        const openHodl = () => choose(other, 'Select an account option:', 'Import HODL File');
        const altered = second.slice(0, -1) + (second.endsWith('0') ? '1' : '0');
        await importHodl(other, openHodl, altered, PASSWORD);
        await shown(other, 'Incorrect password or damaged HODL file');
        expect(await raw(other)).toBeUndefined();
        await importHodl(other, openHodl, second, PASSWORD);
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
    await shown(other, 'Wallet locked.');
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
    await expect(out(page)).not.toContainText('Wallet locked.');
});

test('exit returns to the first screen without a lock notice', async ({ page }) => {
    await importPhrase(page);
    await choose(page, MAIN, 'Exit');
    await expect(prompt(page, 'Password:').locator('input')).toHaveValue('');
    await expect(page.locator('#session-state')).toHaveText('LOCKED');
    await expect(out(page)).not.toContainText('Wallet locked.');
    await expect(out(page)).not.toContainText(BTC_FROM);
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
    await expect(page.locator('input.masked')).toHaveCount(1);
    await expect(page.locator('input.masked')).toHaveValue('');
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

test('CLI .HODL files import on first run and replace an open wallet keeping its password', async ({ page }) => {
    const { evm, btc, evmKey, btcKey } = await networks();
    const fromPhrase = { [evmKey]: await evm.accountFromMnemonic(PHRASE), [btcKey]: await btc.accountFromMnemonic(PHRASE) };
    const phraseFile = await hodlFile({ account: fromPhrase, mnemonic: PHRASE, networkUsage: { '[ETH] Ethereum': { count: 1, lastUsed: 1 } } });
    const key = await evm.createAccount();
    const keyFile = await hodlFile({ account: { [evmKey]: key } });
    const mixedFile = await hodlFile({ account: { ...fromPhrase, [btcKey]: await btc.createAccount() }, mnemonic: PHRASE });

    await firstRun(page);
    const openHodl = () => choose(page, 'Select an account option:', 'Import HODL File');
    await importHodl(page, openHodl, 'U2FsdGVkX1:' + Buffer.from('Salted__legacy').toString('base64'), null);
    await shown(page, 'legacy format can no longer be imported');
    await importHodl(page, openHodl, phraseFile, 'wrong-password');
    await shown(page, 'Incorrect password or damaged HODL file');
    expect(await raw(page)).toBeUndefined();
    await importHodl(page, openHodl, phraseFile);
    await ready(page);
    await switchNetwork(page, 'eth');
    await shown(page, EVM_FROM);

    const replaceHodl = () => replaceWith(page, 'Import HODL File');
    await importHodl(page, replaceHodl, mixedFile);
    await shown(page, 'separate keys per network');
    await importHodl(page, replaceHodl, keyFile);
    await shown(page, key.address);
    await ready(page);
    for (const secret of [key.privateKey, PHRASE]) expect(JSON.stringify(await raw(page)).includes(secret)).toBe(false);

    await page.reload();
    await unlock(page);
    await shown(page, key.address);
    await choose(page, MAIN, 'Account Settings');
    await choose(page, 'Select an account option:', 'Switch Network');
    await expect(prompt(page, 'Select the network:').locator('li.choice', { hasText: 'Bitcoin' })).toHaveCount(0);
});

test('the address book travels in CLI .HODL files and survives replacing the wallet with a phrase', async ({ page }) => {
    const { evm, btc, evmKey, btcKey } = await networks();
    const contact = '0x2222222222222222222222222222222222222222';
    const book = { '[ERC-20] Ethereum': { [contact]: { name: 'Alice' } } };
    const account = { [evmKey]: await evm.accountFromMnemonic(PHRASE), [btcKey]: await btc.accountFromMnemonic(PHRASE) };
    const file = await hodlFile({ account, mnemonic: PHRASE, contact: book });
    const addressBook = async () => {
        await ready(page);
        await choose(page, MAIN, 'Account Settings');
        await choose(page, 'Select an account option:', 'Manage Address Book');
        await choose(page, 'Select an address book option:', 'Delete Address');
    };

    await firstRun(page);
    await importHodl(page, () => choose(page, 'Select an account option:', 'Import HODL File'), file);
    await switchNetwork(page, 'eth');
    await replaceWith(page, 'Import Mnemonic (12 or 24 words)');
    await answer(page, 'Enter your mnemonic phrase', PHRASE);
    await addressBook();
    await choose(page, 'Select an address to delete:', `${contact} (Alice)`);
    await confirm(page, 'Are you sure you want to delete this address?', false);

    const { default: Persist } = await import('hodl-wallet/dist/persist.js');
    expect(Persist.decrypt((await exportHodl(page)).text, PASSWORD).contact).toEqual(book);

    await addressBook();
    await choose(page, 'Select an address to delete:', `${contact} (Alice)`);
    await confirm(page, 'Are you sure you want to delete this address?');
    await shown(page, 'Address deleted successfully.');
    await page.reload();
    await unlock(page);
    await switchNetwork(page, 'eth');
    await addressBook();
    await shown(page, 'No addresses in the address book.');
});
