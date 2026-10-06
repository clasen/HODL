import { AccountNotInitialized, farewell, initialize, isPromptAborted, mainMenu, showError, welcome } from 'hodl-wallet/browser';
import { webConfig } from '../config.mjs';
import { BrowserSession } from './session.js';
import type { DomTerminal } from './terminal/terminal.js';
import { VaultError, userMessage } from './vault-error.js';
import type { BrowserWallet } from './wallet.js';

const vault = webConfig.vault;
const lockedNotice = 'Wallet locked.';

export interface Status {
    setSession(state: 'locked' | 'setup' | 'unlocked'): void;
    setNetwork(name: string | undefined): void;
}

/** The message a person should see: what the vault said, or a neutral one. Never an internal error. */
function describe(error: unknown): string {
    for (let current = error; current instanceof Error; current = current.cause) {
        if (current instanceof VaultError) return current.message;
    }
    return userMessage(error);
}

function validNewPassword(input: string): true | string {
    if (input.length < vault.passwordMinChars || input.length > vault.passwordMaxChars) {
        return `Use ${vault.passwordMinChars} to ${vault.passwordMaxChars} characters. You will need it to unlock your wallet.`;
    }
    return true;
}

/** Asks for the password: unlocks an existing vault, or holds a new one's password until its first account exists. */
async function openSession(terminal: DomTerminal, wallet: BrowserWallet, status: Status): Promise<BrowserSession> {
    const exists = await wallet.exists();
    const onNetwork = (name: string): void => status.setNetwork(name);
    for (;;) {
        const password = await terminal.password({ message: 'Password:', ...(exists ? {} : { validate: validNewPassword }) });
        if (!exists) {
            const repeated = await terminal.password({ message: 'Repeat Password:' });
            if (repeated !== password) {
                showError(terminal, 'Passwords do not match. Please try again.');
                continue;
            }
            return new BrowserSession(wallet, terminal, onNetwork, { password });
        }
        const spinner = terminal.spinner('Unlocking…');
        try {
            return new BrowserSession(wallet, terminal, onNetwork, { snapshot: await wallet.unlock(password) });
        } catch (error) {
            showError(terminal, describe(error));
        } finally {
            spinner.stop();
        }
    }
}

/**
 * Runs an interactive step again after it failed, as long as the person had a chance to act since it began.
 * A step that fails before asking anything would only fail again.
 */
async function retrying(terminal: DomTerminal, step: () => Promise<void>): Promise<void> {
    for (;;) {
        const answered = terminal.answered;
        try {
            await step();
            return;
        } catch (error) {
            if (terminal.isAborted || isPromptAborted(error)) throw error;
            if (!(error instanceof Error && error.cause instanceof AccountNotInitialized)) showError(terminal, describe(error));
            if (terminal.answered === answered) throw error;
        }
    }
}

/**
 * The web host: a locked terminal that asks for the password, runs the shared wallet flows, and locks again.
 * Leaving by Exit returns to the first screen with the TUI's farewell, by Ctrl+C to the bare first screen; any other lock says so.
 */
export async function runHost(terminal: DomTerminal, wallet: BrowserWallet, status: Status): Promise<never> {
    let notice: string | undefined;
    let interrupted = false;
    let left = false;
    terminal.onInterrupt = () => {
        interrupted = true;
        wallet.lock();
    };
    for (;;) {
        terminal.reset();
        terminal.clear();
        status.setSession('locked');
        status.setNetwork(undefined);
        welcome(terminal);
        if (left) farewell(terminal);
        if (notice) terminal.print(notice);
        notice = undefined;
        interrupted = false;
        left = false;
        try {
            const session = await openSession(terminal, wallet, status);
            if (session.isNew) status.setSession('setup');
            await retrying(terminal, () => initialize(terminal, session));
            status.setSession('unlocked');
            await retrying(terminal, () => mainMenu(terminal, session));
            left = true;
        } catch (error) {
            if (!terminal.isAborted && !isPromptAborted(error)) notice = describe(error);
            else if (!interrupted) notice = lockedNotice;
        } finally {
            wallet.lock();
        }
    }
}
