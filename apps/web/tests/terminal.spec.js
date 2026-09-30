import { test, expect } from '@playwright/test';
import { MAIN, choose, importPhrase, prompt, ready } from './terminal.js';

test.beforeEach(async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    // No audio hardware in test browsers: count the sounds the terminal asks for instead of playing them.
    await page.addInitScript(() => {
        window.__tones = 0;
        window.AudioContext = class {
            state = 'running'; currentTime = 0; destination = {};
            resume() { return Promise.resolve(); }
            createOscillator() { window.__tones++; return { type: '', frequency: {}, connect: node => node, start() {}, stop() {} }; }
            createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: node => node }; }
        };
    });
});

const tones = page => page.evaluate(() => window.__tones);

test('menus follow the keyboard model of the terminal wallet', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|net::ERR/.test(message.text())) errors.push(message.text()); });
    await importPhrase(page);
    const list = prompt(page, MAIN);
    const selected = () => list.locator('li.sel').innerText().then(text => text.replace(/^[❯\s]+/, ''));
    expect(await selected()).toBe('Transfer Funds');
    await page.keyboard.press('ArrowUp');
    expect(await selected()).toBe('Exit');
    await page.keyboard.press('ArrowDown');
    expect(await selected()).toBe('Transfer Funds');
    await page.keyboard.press('j');
    expect(await selected()).toBe('Show Balance');
    await page.keyboard.press('k');
    await page.keyboard.press('End');
    expect(await selected()).toBe('Exit');
    await page.keyboard.press('Home');
    await page.keyboard.press('4');
    expect(await selected()).toBe('Account Settings');
    await page.keyboard.press('Enter');
    await expect(prompt(page, 'Select an account option:')).toBeVisible();
    await page.keyboard.press('Escape');
    await ready(page);
    await choose(page, MAIN, 'Transfer Funds');
    await expect(prompt(page, 'Recipient address:')).toBeVisible();
    await page.keyboard.press('Escape');
    await ready(page);
    expect(errors).toEqual([]);
});

test('typing after clicking elsewhere still reaches the prompt, and an IME Enter does not submit it', async ({ page }) => {
    await page.goto('/');
    const field = prompt(page, 'Password:').locator('input');
    await expect(field).toBeVisible();
    await page.locator('.status').click();
    await page.keyboard.type('after a click');
    await expect(field).toHaveValue('after a click');
    await field.evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    await expect(prompt(page, 'Password:')).toBeVisible();
    await expect(field).toHaveValue('after a click');
});

test('Escape leaves a prompt empty only where empty is a valid answer', async ({ page }) => {
    await page.goto('/');
    const field = prompt(page, 'Password:').locator('input');
    await field.fill('secret');
    await page.keyboard.press('Escape');
    await expect(prompt(page, 'Password:')).toBeVisible();
    await expect(field).toHaveValue('secret');
});

test('the phosphor, glass effects and sound are chosen from the keyboard or the bezel and remembered', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-preset', 'p1');
    await page.locator('#preset').click();
    await expect(html).toHaveAttribute('data-preset', 'p3');
    await page.locator('#preset').click();
    await expect(html).toHaveAttribute('data-preset', 'ice');
    await expect(html).toHaveAttribute('data-sweep', 'off');
    await expect(page.locator('#sweep')).toHaveText('SWP:OFF');
    await expect(page.locator('.roll')).toBeHidden();
    await page.locator('#sweep').click();
    await expect(html).toHaveAttribute('data-sweep', 'full');
    await expect(page.locator('.roll')).toBeVisible();
    expect(await page.locator('.roll').evaluate(band => getComputedStyle(band).opacity)).toBe('1');
    await page.locator('#sweep').click();
    await expect(html).toHaveAttribute('data-sweep', 'soft');
    await expect(page.locator('#sweep')).toHaveText('SWP:SOFT');
    expect(await page.locator('.roll').evaluate(band => getComputedStyle(band).opacity)).toBe('0.3');
    await expect(page.locator('.flicker')).toBeVisible();
    await page.locator('#scanlines').click();
    await page.locator('#curvature').click();
    await page.locator('#sound').click();
    await expect(page.locator('#scanlines')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#sound')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.scan')).toBeHidden();
    await expect(page.locator('.roll')).toBeHidden();
    await page.reload();
    await expect(html).toHaveAttribute('data-preset', 'ice');
    await expect(html).toHaveAttribute('data-sweep', 'soft');
    await expect(html).toHaveAttribute('data-scanlines', 'off');
    await expect(html).toHaveAttribute('data-curvature', 'off');
    await expect(html).toHaveAttribute('data-sound', 'on');
    await expect(prompt(page, 'Password:')).toBeVisible();
    const before = await tones(page);
    await page.keyboard.type('typing with sound on');
    expect(await tones(page)).toBeGreaterThan(before);
});

test('the bezel resizes the text within its limits and remembers the size', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page, 'Password:')).toBeVisible();
    const size = () => page.locator('#term').evaluate(term => parseFloat(getComputedStyle(term).fontSize));
    const start = await size();
    await page.locator('#text-larger').click();
    const larger = await size();
    expect(larger).toBeGreaterThan(start);
    for (let i = 0; i < 12; i++) {
        if (await page.locator('#text-larger').isDisabled()) break;
        await page.locator('#text-larger').click();
    }
    await expect(page.locator('#text-larger')).toBeDisabled();
    const largest = await size();
    await page.reload();
    await expect(prompt(page, 'Password:')).toBeVisible();
    expect(await size()).toBe(largest);
    for (let i = 0; i < 12; i++) {
        if (await page.locator('#text-smaller').isDisabled()) break;
        await page.locator('#text-smaller').click();
    }
    await expect(page.locator('#text-smaller')).toBeDisabled();
    await expect(page.locator('#text-larger')).toBeEnabled();
    expect(await size()).toBeLessThan(start);
});

test('the terminal stays silent until sound is switched on', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page, 'Password:')).toBeVisible();
    await page.keyboard.type('quiet typing');
    expect(await tones(page)).toBe(0);
});

test('Display Settings in the main menu change the look and keep the wallet unlocked', async ({ page }) => {
    await importPhrase(page);
    await choose(page, MAIN, 'Display Settings');
    await choose(page, 'Display settings:', 'Phosphor: Green phosphor');
    await choose(page, 'Phosphor:', 'Amber phosphor');
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'p3');
    await choose(page, 'Display settings:', 'Rolling sweep bar: Off');
    await choose(page, 'Rolling sweep bar:', 'Subtle');
    await expect(page.locator('html')).toHaveAttribute('data-sweep', 'soft');
    await expect(page.locator('.roll')).toBeVisible();
    await choose(page, 'Display settings:', 'Rolling sweep bar: Subtle');
    await choose(page, 'Rolling sweep bar:', 'Off');
    await expect(page.locator('html')).toHaveAttribute('data-sweep', 'off');
    await expect(page.locator('.roll')).toBeHidden();
    await expect(page.locator('#sweep')).toHaveText('SWP:OFF');
    await choose(page, 'Display settings:', 'Text size: 110%');
    await choose(page, 'Text size:', '150%');
    await expect(page.locator('html')).toHaveCSS('--text-scale', '1.5');
    await choose(page, 'Display settings:', 'Sound: OFF');
    await expect(page.locator('html')).toHaveAttribute('data-sound', 'on');
    await expect(page.locator('#sound')).toHaveAttribute('aria-pressed', 'true');
    await choose(page, 'Display settings:', 'Go Back');
    await ready(page);
    await expect(page.locator('#session-state')).toHaveText('UNLOCKED');
});

test('choices saved before the sweep option existed keep their values', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('hodl-web:display', JSON.stringify({ preset: 'ice', scanlines: false, curvature: true, sound: false }));
    });
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-preset', 'ice');
    await expect(html).toHaveAttribute('data-scanlines', 'off');
    await expect(html).toHaveAttribute('data-sweep', 'off');
    await expect(html).toHaveCSS('--text-scale', '1.1');
});

test('reduced motion turns off the rolling bar and flicker', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('.roll')).toBeHidden();
    await expect(page.locator('.flicker')).toBeHidden();
});

test('a phone fits the terminal without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await importPhrase(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.status')).toBeVisible();
    await expect(page.locator('#preset')).toBeVisible();
    await choose(page, MAIN, 'Show Sent Transfers');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await ready(page);
});
