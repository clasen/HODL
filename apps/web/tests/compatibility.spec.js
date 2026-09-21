import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile(new URL('../dist/compatibility.json', import.meta.url), 'utf8'));

test('matches Node derivation, signatures and recovery in the browser', async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
        if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort();
        return route.continue();
    });
    await page.goto('/diagnostic.html');
    await expect(page.locator('#status')).toContainText('Checks complete');
    await expect(page.locator('#core [data-id="amounts"]')).toHaveAttribute('data-state', 'passed');
    await expect(page.locator('#core [data-id="webcrypto"]')).toHaveAttribute('data-state', 'passed');
    for (const probe of report.results) {
        await expect(page.locator(`#core [data-id="${probe.id}"]`)).toHaveAttribute('data-state', 'passed');
    }
    expect(errors).toEqual([]);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Check providers' })).toBeFocused();
    await testInfo.attach('browser-compatibility', { body: JSON.stringify(await page.locator('#core li').allTextContents(), null, 2), contentType: 'application/json' });
});

test('reports failed public requests without claiming connectivity', async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('/diagnostic.html');
    await page.getByRole('button', { name: 'Check providers' }).click();
    await expect(page.locator('#providers li')).toHaveCount(report.endpoints.length);
    await expect(page.locator('#providers [data-state="reachable"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check providers' })).toBeEnabled();
});
