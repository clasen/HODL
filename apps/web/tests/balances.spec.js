import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { BTC_FROM, EVM_FROM, MAIN, choose, importPhrase, out, prompt, ready, shown, switchNetwork } from './terminal.js';

const bitcoin = createRequire(import.meta.resolve('hodl-wallet'))('bitcoinjs-lib');

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

test('transfers list what came in and went out, on Bitcoin and as tokens on EVM networks', async ({ page }) => {
    const own = Buffer.from(bitcoin.address.toOutputScript(BTC_FROM)).toString('hex');
    const sender = { scriptpubkey: '0014' + '11'.repeat(20), scriptpubkey_address: 'bc1qzygsszygsszygsszygsszygsszygszrqkfm8t', value: 1 };
    const transactions = [
        { txid: 'a'.repeat(64), vin: [{ is_coinbase: false, prevout: sender }], vout: [{ scriptpubkey: own, value: 25_000 }], status: { confirmed: false } },
        { txid: 'b'.repeat(64), vin: [{ is_coinbase: false, prevout: { ...sender, scriptpubkey: own } }], vout: [{ ...sender, value: 7_000 }, { scriptpubkey: own, value: 1 }], status: { confirmed: true, block_time: 1_700_000_000 } }
    ];
    const topic = address => '0x' + address.slice(2).toLowerCase().padStart(64, '0');
    const usdtLog = {
        address: '0x55d398326f99059fF775485246999027B3197955', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic('0x1111111111111111111111111111111111111111'), topic(EVM_FROM)],
        data: '0x' + (5n * 10n ** 18n).toString(16).padStart(64, '0'), blockNumber: '0x64', blockHash: '0x' + 'c'.repeat(64), transactionHash: '0x' + 'd'.repeat(64),
        transactionIndex: '0x0', logIndex: '0x0', removed: false, blockTimestamp: '0x6553f100'
    };
    let offline = false;
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1') return route.continue();
        if (offline) return route.abort();
        if (url.hostname === 'blockstream.info' && url.pathname === `/api/address/${BTC_FROM}/txs`) return route.fulfill({ json: transactions });
        if (url.hostname === 'bsc-rpc.publicnode.com') {
            const { id, method, params } = route.request().postDataJSON();
            const result = method === 'eth_blockNumber' ? '0x64'
                : method === 'eth_call' ? '0x' + (18).toString(16).padStart(64, '0')
                : params[0].topics[2] === topic(EVM_FROM) ? [usdtLog] : [];
            return route.fulfill({ json: { jsonrpc: '2.0', id, result } });
        }
        return route.abort();
    });
    await importPhrase(page);
    await ready(page);
    await choose(page, MAIN, 'Show Transfers');
    let table = page.locator('#out .tbl').last();
    await expect(table.locator('tr').nth(1)).toContainText(`${sender.scriptpubkey_address}-BTC0.00007✔`);
    await expect(table.locator('tr').nth(3)).toHaveText(`-${sender.scriptpubkey_address}-BTC+0.00025…`);
    await expect(table).toContainText(`https://btcscan.org/tx/${'a'.repeat(64)}`);
    await switchNetwork(page, 'bsc');
    await choose(page, MAIN, 'Show Transfers');
    table = page.locator('#out .tbl').last();
    await expect(table.locator('tr').nth(1)).toContainText('0x1111111111111111111111111111111111111111-USDT+5.00✔');
    await expect(table).toContainText(`https://bscscan.com/tx/0x${'d'.repeat(64)}`);

    // What a scan found is saved, so it still shows when the network cannot be reached.
    offline = true;
    await choose(page, MAIN, 'Show Transfers');
    await shown(page, 'Could not check recent transfers');
    table = page.locator('#out .tbl').last();
    await expect(table.locator('tr').nth(1)).toContainText('0x1111111111111111111111111111111111111111-USDT+5.00✔');
});
