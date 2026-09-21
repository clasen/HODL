import { test, expect } from '@playwright/test';
import { webConfig } from '../config.mjs';
import { mockNetworks, importFixture, unlockFixture, reviewTransfer, storedTransfers, EVM_TO } from './transfer-fixture.js';

for (const [network, asset, amount, expectedState] of [['bsc', 'BNB', '0.1', 'confirmed'], ['bsc', 'USDT', '1.2', 'confirmed'], ['btc', 'BTC', '0.001', 'submitted']]) {
    test(`${network} ${asset} confirms once and persists before broadcast`, async ({ page, context }) => {
        const state = await mockNetworks(context, page);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await importFixture(page);
        await reviewTransfer(page, network, amount, asset);
        expect(state.hashes).toHaveLength(0);
        expect(await storedTransfers(page)).toHaveLength(0);
        await expect(page.locator('#review-back')).toBeFocused();
        await page.getByRole('button', { name: 'Confirm and send', exact: true }).evaluate(button => { button.click(); button.click(); });
        await expect(page.locator(`.transfer-state[data-state="${expectedState}"]`)).toBeVisible();
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
    await page.locator('#network').selectOption('bsc');
    await page.getByRole('button', { name: 'Send funds', exact: true }).click();
    await page.locator('#recipient').fill('invalid');
    await page.locator('#amount').fill('0.1');
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('valid recipient');
    state.balance = 0n;
    await page.locator('#recipient').fill(EVM_TO);
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Insufficient funds');
    state.balance = 1000000000000000000n;
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await expect(page.locator('#review-title')).toBeVisible();
    state.gasPrice *= 2n;
    await page.getByRole('button', { name: 'Confirm and send', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('fee increased');
    expect(state.hashes).toHaveLength(0);
    expect(await storedTransfers(page)).toHaveLength(0);
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await expect(page.locator('#review-title')).toBeVisible();
    await page.clock.fastForward(webConfig.transfer.reviewTtlMs + 1);
    await page.getByRole('button', { name: 'Confirm and send', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('review expired');
    expect(state.hashes).toHaveLength(0);
    expect(await storedTransfers(page)).toHaveLength(0);
});

test('a lost response reloads as unknown and only explicit recovery sends the same transaction', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    state.mode = 'lost';
    state.status = 'not_found';
    await importFixture(page);
    await reviewTransfer(page);
    await page.getByRole('button', { name: 'Confirm and send', exact: true }).click();
    await expect(page.locator('.transfer-state[data-state="broadcast_unknown"]')).toBeVisible();
    const originalSigns = state.methods.filter(method => method === 'eth_getTransactionCount').length;
    await page.reload();
    await unlockFixture(page);
    await expect(page.locator('.transfer-state[data-state="broadcast_unknown"]')).toBeVisible();
    expect(state.hashes).toHaveLength(1);
    await page.locator('#network').selectOption('bsc');
    await page.getByRole('button', { name: 'Send funds', exact: true }).click();
    await page.locator('#recipient').fill(EVM_TO);
    await page.locator('#amount').fill('0.2');
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Resolve the saved transfer');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Review saved transfer', exact: true }).click();
    await expect(page.getByText('This sends the exact saved transaction.', { exact: false })).toBeVisible();
    state.mode = 'success';
    state.beforeBroadcast = async () => { state.status = 'confirmed'; };
    await page.getByRole('button', { name: 'Send saved transaction', exact: true }).click();
    await expect(page.locator('.transfer-state[data-state="confirmed"]')).toBeVisible();
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
        await page.getByRole('button', { name: 'Confirm and send', exact: true }).click();
        await expect(page.locator('#notice')).toContainText('Could not save');
        expect(state.hashes).toHaveLength(0);
        const saved = await storedTransfers(page);
        expect(saved).toHaveLength(failAt === 1 ? 0 : 1);
        if (failAt === 2) {
            expect(saved[0].state).toBe('prepared');
            await page.getByRole('button', { name: 'Review saved transfer', exact: true }).click();
            await page.getByRole('button', { name: 'Send saved transaction', exact: true }).click();
            await expect(page.locator('.transfer-state[data-state="confirmed"]')).toBeVisible();
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
    await other.locator('#password').fill('browser-test-password');
    await other.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(other.locator('#notice')).toContainText('another tab');
    let release;
    state.gate = () => new Promise(resolve => { release = resolve; });
    await page.getByRole('button', { name: 'Confirm and send', exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.locator('#lock').click();
    state.gate = undefined;
    release();
    await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeEnabled();
    expect(state.hashes).toHaveLength(0);
    expect(await storedTransfers(page)).toHaveLength(0);
    await unlockFixture(other);
    await expect(other.locator('#session-state')).toHaveText('Unlocked');
});

test('closing after broadcast recovers from the durable journal without retransmitting', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    await importFixture(page);
    await reviewTransfer(page, 'btc', '0.001', 'BTC');
    let release;
    state.beforeBroadcast = () => new Promise(resolve => { release = resolve; });
    await page.getByRole('button', { name: 'Confirm and send', exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.close();
    release();
    const reopened = await context.newPage();
    state.page = reopened;
    await reopened.goto('http://127.0.0.1:4173/');
    await unlockFixture(reopened);
    await expect(reopened.locator('.transfer-state[data-state="confirmed"]')).toBeVisible();
    expect(state.hashes).toHaveLength(1);
    expect((await storedTransfers(reopened))[0].state).toBe('confirmed');
});
