import { test, expect } from '@playwright/test';
import { MAIN, choose, importPhrase, out, ready, shown, switchNetwork } from './terminal.js';

const balance = async page => { await ready(page); await choose(page, MAIN, 'Show Balance'); };

test('balances use shared networks and distinguish cached from unavailable data', async ({ page }) => {
    let unavailable = false;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1') return route.continue();
        if (url.hostname === 'blockstream.info' && url.pathname.startsWith('/api/address/')) {
            if (unavailable) return route.abort();
            return route.fulfill({ json: { chain_stats: { funded_txo_sum: 12000000, spent_txo_sum: 2000000 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } } });
        }
        if (url.hostname === 'bsc-dataseed1.binance.org') {
            const request = route.request().postDataJSON();
            const result = request.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : request.params?.[0]?.data?.startsWith('0x313ce567') ? '0x' + (18).toString(16).padStart(64, '0') : '0x' + (5000000000000000000n).toString(16).padStart(64, '0');
            return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result } });
        }
        return route.abort();
    });
    await importPhrase(page);
    await balance(page);
    await expect(page.locator('#out .tbl').last().locator('tr').filter({ hasText: 'BTC' })).toHaveText('BTC0.10');
    unavailable = true;
    await balance(page);
    await shown(page, 'Showing cached balances that may be outdated');
    await expect(page.locator('#out .tbl').last().locator('tr').filter({ hasText: 'BTC' })).toHaveText('BTC0.10');
    await switchNetwork(page, 'bsc');
    await balance(page);
    await expect(page.locator('#out .tbl').last().locator('tr').filter({ hasText: 'BNB' })).toHaveText('BNB1.00');
    await expect(page.locator('#out .tbl').last().locator('tr').filter({ hasText: 'USDT' })).toHaveText('USDT5.00');
    await switchNetwork(page, 'pol');
    await balance(page);
    await shown(page, 'Balance unavailable');
    await expect(page.locator('#out [role=alert]').last()).toContainText('Balance unavailable');
    await ready(page);
    expect(await out(page).textContent()).not.toMatch(/cached balances[^]*Balance unavailable[^]*cached balances/);
    expect(errors).toEqual([]);
});
