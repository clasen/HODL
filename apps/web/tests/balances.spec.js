import { test, expect } from '@playwright/test';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const password = 'browser-test-password';

async function importWallet(page) {
    await page.goto('/');
    await page.getByRole('button', { name: /Import phrase/ }).click();
    await page.locator('#mnemonic').fill(phrase);
    await page.locator('#password').fill(password);
    await page.locator('#confirmation').fill(password);
    await page.getByRole('button', { name: 'Import wallet', exact: true }).click();
    await expect(page.locator('#address-bitcoin')).toBeVisible();
}

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
    await importWallet(page);
    await expect(page.locator('.balance-table tbody')).toContainText('0.1');
    unavailable = true;
    await page.getByRole('button', { name: 'Refresh balances' }).click();
    await expect(page.locator('.balance-table tbody')).toContainText('Cached');
    await expect(page.locator('.balance-table tbody')).toContainText('0.1');
    await page.locator('#network').selectOption('bsc');
    await expect(page.locator('.balance-table tbody tr').filter({ hasText: 'BNB' })).toContainText('1');
    await expect(page.locator('.balance-table tbody tr').filter({ hasText: 'USDT' })).toContainText('5');
    await page.locator('#network').selectOption('pol');
    await expect(page.locator('.balance-table tbody')).toContainText('Unavailable');
    await expect(page.locator('.balance-table tbody')).not.toContainText('Cached');
    expect(errors).toEqual([]);
});

test('mobile navigation has three bottom sections and no browser status label', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const buttons = page.locator('nav button');
    await expect(buttons).toHaveCount(3);
    const bar = await page.locator('.sidebar').boundingBox();
    expect(bar.y + bar.height).toBeCloseTo(844, 0);
    expect(bar.height).toBeGreaterThanOrEqual(60);
    await expect(page.getByText('Browser online', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
