import { expect } from '@playwright/test';

export const PASSWORD = 'browser-test-password';
// Public BIP39 test vector, never funded.
export const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const EVM_FROM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
export const BTC_FROM = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

export const NETWORKS = { btc: '[BTC] Bitcoin', eth: '[ETH] Ethereum', bsc: '[BSC] BNB Smart Chain', pol: '[POL] Polygon' };
export const MAIN = 'What would you like to do?';

export const out = page => page.locator('#out');
export const prompt = (page, message) => page.locator('#out .prompt:not(.done)').filter({ hasText: message });
export const shown = (page, text) => expect(out(page)).toContainText(text);

/** Types into the text prompt with this message and submits it. */
export async function answer(page, message, text) {
    const field = prompt(page, message).locator('input');
    await expect(field).toBeVisible();
    await field.fill(text);
    await page.keyboard.press('Enter');
}

/** Picks a list entry by name with the keyboard: a digit jumps to it, Enter selects it. */
export async function choose(page, message, label) {
    const list = prompt(page, message);
    await expect(list.locator('li.choice').first()).toBeVisible();
    const names = (await list.locator('li.choice').allTextContents()).map(name => name.replace(/^[❯\s]+/, '').trim());
    const index = names.findIndex(name => name === label);
    expect(index, `"${label}" among ${names.join(' | ')}`).toBeGreaterThanOrEqual(0);
    if (index < 9) {
        await page.keyboard.press(String(index + 1));
    } else {
        for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown');
    }
    await expect(list.locator('li.sel')).toContainText(label);
    await page.keyboard.press('Enter');
}

export async function confirm(page, message, yes = true) {
    const field = prompt(page, message).locator('input');
    await expect(field).toBeVisible();
    await field.fill(yes ? 'y' : 'n');
    await page.keyboard.press('Enter');
}

export const lock = page => page.keyboard.press('Control+c');

export const ready = page => expect(prompt(page, MAIN)).toBeVisible();

export async function firstRun(page, password = PASSWORD) {
    await page.goto('/');
    await answer(page, 'Password:', password);
    await answer(page, 'Repeat Password:', password);
}

export async function importPhrase(page, phrase = PHRASE, password = PASSWORD) {
    await firstRun(page, password);
    await choose(page, 'Select an account option:', 'Import Mnemonic (12 or 24 words)');
    await answer(page, 'Enter your mnemonic phrase', phrase);
    await ready(page);
}

export async function unlock(page, password = PASSWORD) {
    await answer(page, 'Password:', password);
    await ready(page);
}

export async function menu(page, ...labels) {
    await ready(page);
    await choose(page, MAIN, labels[0]);
    for (const [index, label] of labels.slice(1).entries()) {
        await choose(page, ['Select an account option:', 'Select an export option:'][index], label);
    }
}

export async function switchNetwork(page, id) {
    await ready(page);
    await choose(page, MAIN, 'Account Settings');
    await choose(page, 'Select an account option:', 'Switch Network');
    await choose(page, 'Select the network:', NETWORKS[id]);
    await shown(page, 'Address');
    await ready(page);
}
