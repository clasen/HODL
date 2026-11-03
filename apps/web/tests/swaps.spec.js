import { test, expect } from '@playwright/test';
import { SwapService, swapConfig } from 'hodl-wallet/browser/index.js';
import { mockNetworks, importFixture, addToVault, reviewTransfer, sendTransfer, EVM_FROM, BTC_FROM } from './transfer-fixture.js';
import { MAIN, answer, choose, lock, prompt, ready, shown, switchNetwork, unlock } from './terminal.js';

const SWAP = 'Swap:';
const AMOUNT = 'USDT (BSC) to exchange (max, empty to cancel):';
const spinner = page => page.locator('#out .spin');

async function menuNames(page) {
    const names = await prompt(page, MAIN).locator('li.choice').allTextContents();
    return names.map(name => name.replace(/^[❯\s]+/, '').trim());
}

/** A swap whose deposit was sent and awaits confirmation, quoted by the shared service with a stand-in provider. */
async function pendingSwap() {
    const data = { account: { [swapConfig.source.NetworkClass.name]: { address: EVM_FROM, privateKey: 'unused' } } };
    const at = path => path.reduce((value, key) => value?.[key], data);
    const store = {
        get: async (...path) => structuredClone(at(path)),
        entries: async (...path) => Object.entries(at(path) ?? {}),
        set: async (...path) => {
            const value = path.pop();
            const key = path.pop();
            let node = data;
            for (const part of path) node = node[part] ??= {};
            node[key] = structuredClone(value);
        },
        flush: async () => {}
    };
    const service = new SwapService(store, {
        prices: async () => ({ btc: '6000000000000', bnb: '60000000000', usdt: '100000000', updatedAt: Date.now() }),
        chain: {
            estimate: async () => ({ asset: 'BNB', decimals: 18, price: 'bnb', budgetBaseUnits: '350000000000000', rate: '1000000000', units: 350_000 }),
            balance: async () => ({ sufficientAsset: true, sufficientFee: true })
        },
        providers: [{
            id: 'chainflip',
            quote: async () => ({ provider: 'chainflip', expectedBaseUnits: '1600', minimumBaseUnits: '1590',
                expiresAt: Date.now() + swapConfig.quoteLifetimeMs, estimatedSeconds: 60, fees: [], details: {} })
        }]
    });
    const { recommendedQuoteId } = await service.quote('1', BTC_FROM);
    const quote = data.swapQuote[recommendedQuoteId];
    const now = Date.now();
    return {
        swapQuote: data.swapQuote,
        swapOperation: { 'web-follow': {
            id: 'web-follow', quote, state: 'deposit_pending', createdAt: now, updatedAt: now,
            plan: { depositAddress: '0x2222222222222222222222222222222222222222', expiresAt: now + 3_600_000 },
            steps: [{ kind: 'deposit', rawTransaction: '0x00', hash: `0x${'d'.repeat(64)}`, nonce: '0', confirmed: false, broadcastAttempted: true }],
            history: [{ state: 'preparing', at: now }, { state: 'deposit_pending', at: now }]
        } }
    };
}

test('Swap runs the shared flow on its networks and sends nothing when no provider answers', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    const errors = [];
    const hosts = new Set();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => hosts.add(new URL(request.url()).hostname));
    await importFixture(page);
    await switchNetwork(page, 'eth');
    await ready(page);
    expect(await menuNames(page)).not.toContain('Swap');
    await switchNetwork(page, 'bsc');
    await ready(page);
    expect(await menuNames(page)).toContain('Swap');
    await choose(page, MAIN, 'Swap');
    await choose(page, SWAP, 'Track Swaps');
    await shown(page, 'No swaps recorded.');
    await choose(page, MAIN, 'Swap');
    await choose(page, SWAP, 'USDT (BSC) → BTC (Bitcoin)');
    await answer(page, AMOUNT, '100');
    await expect(prompt(page, AMOUNT)).toContainText('Insufficient USDT (BSC). Available: 10.');
    await answer(page, AMOUNT, '1');
    const destination = prompt(page, 'Receive BTC (Bitcoin) at:');
    await expect(destination.locator('li.sel')).toContainText(`My account (${BTC_FROM})`);
    await page.keyboard.press('Enter');
    await ready(page);
    await expect(spinner(page)).toHaveCount(0);
    expect(hosts).toContain(new URL(swapConfig.pricesUrl).hostname);
    expect(state.hashes).toEqual([]);
    expect(state.unexpected).toEqual([]);
    expect(errors).toEqual([]);
});

test('following a swap keeps updating until Enter, and locking the wallet stops it', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await importFixture(page);
    await switchNetwork(page, 'bsc');
    await ready(page);
    await lock(page);
    await expect(prompt(page, 'Password:')).toBeVisible();
    await addToVault(page, await pendingSwap());
    await page.reload();
    await unlock(page);
    for (const leave of ['Enter', 'lock']) {
        await choose(page, MAIN, 'Swap');
        await choose(page, SWAP, 'Track Swaps');
        await expect(prompt(page, 'Select a swap:').locator('li.sel')).toContainText('1 USDT → BTC · Deposit sent');
        await page.keyboard.press('Enter');
        await shown(page, 'Updating automatically. Press Enter to return to the menu.');
        await expect(spinner(page)).toContainText('Deposit sent · waiting for confirmation · Enter to return');
        if (leave === 'Enter') {
            await page.keyboard.press('Enter');
            await ready(page);
        } else {
            await lock(page);
            await expect(prompt(page, 'Password:')).toBeVisible();
        }
        await expect(spinner(page)).toHaveCount(0);
    }
    expect(state.hashes).toEqual([]);
    expect(errors).toEqual([]);
});

test('a transfer blocked by an unfinished swap names that swap and sends nothing', async ({ page, context }) => {
    const state = await mockNetworks(context, page);
    await importFixture(page);
    await switchNetwork(page, 'bsc');
    await ready(page);
    await lock(page);
    await expect(prompt(page, 'Password:')).toBeVisible();
    await addToVault(page, await pendingSwap());
    await page.reload();
    await unlock(page);
    await reviewTransfer(page);
    await sendTransfer(page);
    await shown(page, 'Finish or inspect the existing swap before another transfer.');
    await shown(page, 'Blocking swap: web-follow');
    await shown(page, 'Open Swap > Track Swaps');
    expect(state.hashes).toEqual([]);
});
