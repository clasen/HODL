import { test, expect } from '@playwright/test';
import { webConfig } from '../config.mjs';
import { mockNetworks, importFixture, unlockFixture, reviewTransfer, sendTransfer, fillTransfer, storedTransfers, EVM_TO, PHRASE } from './transfer-fixture.js';
import { MAIN, PASSWORD, answer, choose, confirm, lock, prompt, ready, shown, switchNetwork } from './terminal.js';

const PENDING = 'A previous transfer is still pending:';
async function resume(page, status) {
    await ready(page);
    await choose(page, MAIN, 'Transfer Funds');
    await choose(page, PENDING, `Check / resume 0.1 BNB to ${EVM_TO} (${status})`);
    await expect(prompt(page, 'Send the saved transaction?')).toBeVisible();
}

for (const [network, asset, amount, expected] of [
    ['bsc', 'BNB', '0.1', 'Transaction confirmed!'],
    ['bsc', 'USDT', '1.2', 'Transaction confirmed!'],
    ['btc', 'BTC', '0.001', 'Transaction submitted; awaiting confirmation.']
]) {
    test(`${network} ${asset} confirms once and persists before broadcast`, async ({ page, context }) => {
        const state = await mockNetworks(context, page);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await importFixture(page);
        await reviewTransfer(page, network, amount, asset);
        expect(state.hashes).toHaveLength(0);
        expect(await storedTransfers(page)).toHaveLength(0);
        // A repeated Enter must not send a second time.
        await prompt(page, 'Confirm transfer of').locator('input').fill('y');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await shown(page, expected);
        await ready(page);
        expect(state.hashes).toHaveLength(1);
        expect(state.unexpected).toEqual([]);
        const stored = await storedTransfers(page);
        expect(stored).toHaveLength(1);
        expect(await page.locator('body').textContent()).not.toContain(stored[0].rawTransaction);
        expect(errors).toEqual([]);
    });
}

test('rejects invalid destination, insufficient funds, higher fees and expired review', async ({ page, context }) => {
    await page.clock.install();
    const state = await mockNetworks(context, page);
    await importFixture(page);
    await switchNetwork(page, 'bsc');
    await fillTransfer(page, { to: 'invalid' });
    await shown(page, 'Enter a valid recipient address');
    state.balance = 0n;
    await ready(page);
    await fillTransfer(page, { to: EVM_TO });
    await shown(page, 'Insufficient funds');
    state.balance = 1000000000000000000n;
    await ready(page);
    await fillTransfer(page, { to: EVM_TO });
    await expect(prompt(page, 'Confirm transfer of')).toBeVisible();
    state.gasPrice *= 2n;
    await sendTransfer(page);
    await shown(page, 'fee increased');
    expect(state.hashes).toHaveLength(0);
    expect(await storedTransfers(page)).toHaveLength(0);
    await ready(page);
    await fillTransfer(page, { to: EVM_TO });
    await expect(prompt(page, 'Confirm transfer of')).toBeVisible();
    await page.clock.fastForward(webConfig.transfer.reviewTtlMs + 1);
    await sendTransfer(page);
    await shown(page, 'review expired');
    expect(state.hashes).toHaveLength(0);
    expect(await storedTransfers(page)).toHaveLength(0);
});

test('max resolves the amount before review and sends exactly what was reviewed', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    await importFixture(page);
    await switchNetwork(page, 'bsc');
    await fillTransfer(page, { to: EVM_TO, asset: 'BNB', amount: 'max' });
    await shown(page, 'Maximum:');
    await expect(prompt(page, 'Confirm transfer of maximum available BNB')).toBeVisible();
    expect(state.hashes).toHaveLength(0);
    expect(await storedTransfers(page)).toHaveLength(0);
    await confirm(page, 'Confirm transfer of maximum');
    await shown(page, 'Transaction confirmed!');
    expect(state.hashes).toHaveLength(1);
});

test('a lost response reloads as unknown and only explicit recovery sends the same transaction', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    state.mode = 'lost';
    state.status = 'not_found';
    await importFixture(page);
    await reviewTransfer(page);
    await sendTransfer(page);
    await shown(page, 'Saved transfer:');
    await shown(page, 'broadcast outcome is unknown');
    const originalSigns = state.methods.filter(method => method === 'eth_getTransactionCount').length;
    await page.reload();
    await unlockFixture(page);
    expect(state.hashes).toHaveLength(1);
    await switchNetwork(page, 'bsc');
    await choose(page, MAIN, 'Transfer Funds');
    await choose(page, PENDING, 'New transfer');
    await answer(page, 'Recipient address:', EVM_TO);
    await choose(page, 'Token to transfer:', 'BNB');
    await answer(page, 'Amount to transfer (or max):', '0.2');
    await shown(page, 'Resolve the saved transfer');
    await resume(page, 'broadcast_unknown');
    state.mode = 'success';
    state.beforeBroadcast = async () => { state.status = 'confirmed'; };
    await confirm(page, 'Send the saved transaction?');
    await shown(page, 'Transaction confirmed!');
    expect(state.hashes).toHaveLength(2);
    expect(new Set(state.hashes).size).toBe(1);
    expect(state.methods.filter(method => method === 'eth_getTransactionCount')).toHaveLength(originalSigns);
    expect(await storedTransfers(page)).toHaveLength(1);
});

for (const failAt of [1, 2]) {
    test(`storage failure at write ${failAt} does not broadcast and restores committed state`, async ({ page, context }) => {
        await page.addInitScript(failAt => {
            const original = IDBObjectStore.prototype.put;
            let count = 0;
            window.failWriteAt = failAt;
            IDBObjectStore.prototype.put = function (...args) {
                if (++count === window.failWriteAt) { this.transaction.abort(); throw new DOMException('fixture storage failure', 'QuotaExceededError'); }
                return original.apply(this, args);
            };
        }, failAt);
        const state = await mockNetworks(context, page);
        await importFixture(page);
        await reviewTransfer(page);
        await sendTransfer(page);
        await shown(page, 'Could not save');
        expect(state.hashes).toHaveLength(0);
        const saved = await storedTransfers(page);
        expect(saved).toHaveLength(failAt === 1 ? 0 : 1);
        if (failAt === 2) {
            expect(saved[0].state).toBe('prepared');
            await resume(page, 'prepared');
            await confirm(page, 'Send the saved transaction?');
            await shown(page, 'Transaction confirmed!');
            expect(state.hashes).toHaveLength(1);
        }
    });
}

test('locking during preparation prevents broadcast and another tab cannot unlock concurrently', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    await importFixture(page);
    await reviewTransfer(page);
    const other = await context.newPage();
    await other.goto(page.url());
    await answer(other, 'Password:', PASSWORD);
    await shown(other, 'another tab');
    let release;
    state.gate = () => new Promise(resolve => { release = resolve; });
    await sendTransfer(page);
    await expect.poll(() => Boolean(release)).toBe(true);
    await lock(page);
    state.gate = undefined;
    release();
    await expect(prompt(page, 'Password:')).toBeVisible();
    expect(state.hashes).toHaveLength(0);
    expect(await storedTransfers(page)).toHaveLength(0);
    await unlockFixture(other);
    await expect(other.locator('#session-state')).toHaveText('UNLOCKED');
});

test('closing after broadcast recovers from the durable journal without retransmitting', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    await importFixture(page);
    await reviewTransfer(page, 'btc', '0.001', 'BTC');
    let release;
    state.beforeBroadcast = () => new Promise(resolve => { release = resolve; });
    await sendTransfer(page);
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.close();
    release();
    const reopened = await context.newPage();
    state.page = reopened;
    await reopened.goto('http://127.0.0.1:4173/');
    await unlockFixture(reopened);
    await choose(reopened, MAIN, 'Show Sent Transfers');
    await expect(reopened.locator('#out .tbl tbody').last()).toContainText('confirmed');
    const explorer = reopened.locator('#out .tbl tbody').last().locator('a[href^="https://"]');
    await expect(explorer).toHaveCount(1);
    await expect(explorer).toHaveAttribute('target', '_blank');
    expect(state.hashes).toHaveLength(1);
    expect((await storedTransfers(reopened))[0].state).toBe('confirmed');
});

test('an unresolved transfer blocks replacing the wallet', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    state.mode = 'lost';
    state.status = 'not_found';
    await importFixture(page);
    await reviewTransfer(page);
    await sendTransfer(page);
    await shown(page, 'broadcast outcome is unknown');
    await ready(page);
    await choose(page, MAIN, 'Account Settings');
    await choose(page, 'Select an account option:', 'Import Options');
    await choose(page, 'Select an import option:', 'Import Mnemonic (12 or 24 words)');
    await confirm(page, 'overwrite the existing account');
    await answer(page, 'Enter your mnemonic phrase', PHRASE);
    await shown(page, 'Resolve the saved transfers in local activity before replacing this wallet.');
    expect(await storedTransfers(page)).toHaveLength(1);
});
