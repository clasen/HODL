import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile(new URL('../dist/compatibility.json', import.meta.url), 'utf8'));

test('records live public connectivity without broadcasting', async ({ page }, testInfo) => {
    test.skip(process.env.HODL_LIVE_PROBES !== '1', 'Live connectivity is an explicit diagnostic.');
    const failures = [];
    const unexpectedRequests = [];
    page.on('requestfailed', request => failures.push({ url: request.url(), failure: request.failure() }));
    await page.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).hostname === '127.0.0.1') return route.continue();
        const endpoint = report.endpoints.find(endpoint => new URL(endpoint.url).href === request.url());
        if (!endpoint || request.method() !== (endpoint.method ?? 'GET') ||
            (endpoint.body && request.postData() !== JSON.stringify(endpoint.body))) {
            unexpectedRequests.push({ url: request.url(), method: request.method() });
            return route.abort();
        }
        return route.continue();
    });
    await page.goto('/diagnostic.html');
    await page.getByRole('button', { name: 'Check providers' }).click();
    await expect(page.locator('#providers li')).toHaveCount(report.endpoints.length, { timeout: report.timeoutMs + 5_000 });
    const results = await page.locator('#providers li').allTextContents();
    await testInfo.attach('public-connectivity', { body: JSON.stringify({ origin: page.url(), results, failures }, null, 2), contentType: 'application/json' });
    console.log(results.join('\n'));
    expect(unexpectedRequests).toEqual([]);
});
