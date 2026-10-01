import { test, expect } from '@playwright/test';
import { MAIN, choose, importPhrase, prompt, ready } from './terminal.js';

test.beforeEach(async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    // No audio hardware in test browsers: count the sounds the terminal asks for instead of playing them.
    await page.addInitScript(() => {
        window.__tones = 0;
        window.AudioContext = class {
            state = 'running'; currentTime = 0; sampleRate = 8000; destination = {};
            resume() { return Promise.resolve(); }
            createOscillator() { window.__tones++; return { type: '', frequency: {}, connect: node => node, start() {}, stop() {} }; }
            createBufferSource() { window.__tones++; return { buffer: null, connect: node => node, start() {}, stop() {} }; }
            createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
            createBiquadFilter() { return { type: '', frequency: {}, Q: {}, connect: node => node }; }
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
    await field.blur();
    const screen = await page.locator('#term').boundingBox();
    await page.mouse.click(screen.x + screen.width / 2, screen.y + screen.height - 10);
    await expect(field).toBeFocused();
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

test('a secret prompt masks what is typed without a password field that password managers would take over', async ({ page }) => {
    await page.goto('/');
    const field = prompt(page, 'Password:').locator('input');
    await field.fill('secret');
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    expect(await field.evaluate(input => getComputedStyle(input).getPropertyValue('-webkit-text-security'))).toBe('disc');
    expect(await field.evaluate(input => input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true })))).toBe(false);
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
    await expect(page.locator('#sweep')).toHaveAttribute('data-level', 'off');
    await expect(page.locator('.roll')).toBeHidden();
    await page.locator('#sweep').click();
    await expect(html).toHaveAttribute('data-sweep', 'full');
    await expect(page.locator('.roll')).toBeVisible();
    expect(await page.locator('.roll').evaluate(band => getComputedStyle(band).opacity)).toBe('1');
    await page.locator('#sweep').click();
    await expect(html).toHaveAttribute('data-sweep', 'soft');
    await expect(page.locator('#sweep')).toHaveAttribute('data-level', 'soft');
    await expect(page.locator('#sweep')).toHaveText('SWP');
    await expect(page.locator('#sound')).toHaveText('SND');
    expect(await page.locator('.roll').evaluate(band => getComputedStyle(band).opacity)).toBe('0.3');
    await expect(page.locator('.flicker')).toBeVisible();
    await page.locator('#scanlines').click();
    await page.locator('#curvature').click();
    await page.locator('#sound').click();
    await expect(page.locator('#scanlines')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#sound')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.scan')).toBeHidden();
    await expect(page.locator('.roll')).toBeHidden();
    await page.reload();
    await expect(html).toHaveAttribute('data-preset', 'ice');
    await expect(html).toHaveAttribute('data-sweep', 'soft');
    await expect(html).toHaveAttribute('data-scanlines', 'off');
    await expect(html).toHaveAttribute('data-curvature', 'off');
    await expect(html).toHaveAttribute('data-sound', 'off');
    await expect(prompt(page, 'Password:')).toBeVisible();
    const before = await tones(page);
    await page.keyboard.type('typing with sound off');
    expect(await tones(page)).toBe(before);
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

test('the bezel keys leave focus where it was', async ({ page }) => {
    await page.goto('/');
    const field = prompt(page, 'Password:').locator('input');
    await expect(field).toBeFocused();
    await page.locator('#preset').click();
    await page.locator('#text-larger').click();
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'p3');
    await expect(field).toBeFocused();
    await field.blur();
    await page.locator('#scanlines').click();
    await expect(page.locator('html')).toHaveAttribute('data-scanlines', 'off');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('the prompt scrolls into view when it takes focus and when a keyboard shrinks the screen', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 839 });
    await page.goto('/');
    const field = prompt(page, 'Password:').locator('input');
    await expect(field).toBeFocused();
    await page.locator('#out').evaluate(out => { for (let i = 0; i < 120; i++) out.prepend(Object.assign(document.createElement('div'), { className: 'l', textContent: `line ${i}` })); });
    await page.locator('#term').evaluate(el => { el.scrollTop = 0; });
    await field.blur();
    await expect(field).not.toBeInViewport();
    const screen = await page.locator('#term').boundingBox();
    await page.mouse.click(screen.x + screen.width / 2, screen.y + 20);
    await expect(field).toBeFocused();
    await expect(field).toBeInViewport();
    await page.setViewportSize({ width: 412, height: 420 });
    await expect(field).toBeInViewport();
});

test.describe('on a touch screen', () => {
    test.use({ hasTouch: true, viewport: { width: 412, height: 839 } });

    test('a swipe moves through a menu, a tap anywhere answers it, even on a link or another choice, and text prompts still scroll', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'touch input is driven through the Chromium DevTools protocol');
        await importPhrase(page);
        const list = prompt(page, MAIN);
        const selected = () => list.locator('li.sel').innerText().then(text => text.replace(/^[❯\s]+/, ''));
        const term = await page.locator('#term').boundingBox();
        const x = term.x + term.width / 2;
        const y = term.y + term.height / 2;
        const cdp = await page.context().newCDPSession(page);
        const touch = (type, at) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at === undefined ? [] : [{ x, y: at }] });
        const swipe = async distance => {
            await touch('touchStart', y);
            for (let i = 1; i <= 8; i++) await touch('touchMove', y + i * distance / 8);
            await touch('touchEnd');
        };
        expect(await selected()).toBe('Transfer Funds');
        await swipe(80);
        expect(await selected()).toBe('Show Sent Transfers');
        await swipe(-40);
        expect(await selected()).toBe('Show Balance');
        await swipe(80);
        expect(await selected()).toBe('Account Settings');
        const pages = [];
        page.context().on('page', opened => pages.push(opened));
        await page.locator('#out').evaluate(out => {
            const line = Object.assign(document.createElement('div'), { className: 'l' });
            line.append(Object.assign(document.createElement('a'), { href: 'https://example.test/tx/1', target: '_blank', textContent: 'https://example.test/tx/1' }));
            out.querySelector('.prompt:not(.done)').before(line);
        });
        const link = await page.locator('#out a[href="https://example.test/tx/1"]').boundingBox();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: link.x + 5, y: link.y + link.height / 2 }] });
        await touch('touchEnd');
        await expect(prompt(page, 'Select an account option:')).toBeVisible();
        expect(pages).toHaveLength(0);
        await page.keyboard.press('Escape');
        await ready(page);
        await swipe(110);
        expect(await selected()).toBe('Account Settings');
        const exit = await list.locator('li', { hasText: 'Exit' }).boundingBox();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: exit.x + 10, y: exit.y + exit.height / 2 }] });
        await touch('touchEnd');
        await expect(prompt(page, 'Select an account option:')).toBeVisible();
        await page.keyboard.press('Escape');
        await ready(page);
        await choose(page, MAIN, 'Transfer Funds');
        const field = prompt(page, 'Recipient address:').locator('input');
        await page.locator('#out').evaluate(out => { for (let i = 0; i < 80; i++) out.prepend(Object.assign(document.createElement('div'), { className: 'l', textContent: `line ${i}` })); });
        const scroller = page.locator('#term');
        await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
        const bottom = await scroller.evaluate(el => el.scrollTop);
        await swipe(200);
        await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeLessThan(bottom);
        await expect(field).toBeVisible();
    });
});

test('keys sound by default', async ({ page }) => {
    await page.goto('/');
    await expect(prompt(page, 'Password:')).toBeVisible();
    await page.keyboard.type('clicky typing');
    expect(await tones(page)).toBeGreaterThan(0);
});

test('the main menu leaves display settings to the bezel, which works without locking the wallet', async ({ page }) => {
    await importPhrase(page);
    await expect(prompt(page, MAIN).locator('li')).not.toContainText(['Display Settings']);
    await page.locator('#preset').click();
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'p3');
    await page.locator('#sweep').click();
    await expect(page.locator('html')).toHaveAttribute('data-sweep', 'full');
    await page.locator('#text-larger').click();
    await expect(page.locator('html')).toHaveCSS('--text-scale', '1.2');
    await page.locator('#sound').click();
    await expect(page.locator('html')).toHaveAttribute('data-sound', 'off');
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
