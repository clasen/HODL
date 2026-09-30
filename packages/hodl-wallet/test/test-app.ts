import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentError } from '../agent-errors.js';
import { initialize, isPromptAborted, loadAccount, mainMenu, PromptAborted, showAccountDetails, showBalance, showTransactions, transferFunds } from '../app/index.js';
import type { Cell, HostAction, SentTransfer, SessionCapabilities, TableSpec, TransferPort, Ui, WalletSession } from '../app/index.js';
import type { NetworkPlugin } from '../network/types.js';
import type { TransferResult } from '../transfer-service.js';

type Answer = string | boolean | number | ((choices: string[]) => unknown);

class ScriptedUi implements Ui {
    readonly prompts: Array<{ kind: string; message: string; choices?: string[] }> = [];
    readonly tables: TableSpec[] = [];
    readonly printed: string[] = [];
    readonly spinners: string[] = [];
    constructor(private readonly answers: Answer[]) {}

    private next(kind: string, message: string, choices?: string[]): unknown {
        this.prompts.push({ kind, message, choices });
        assert.ok(this.answers.length, `Unexpected prompt: ${message}`);
        const answer = this.answers.shift()!;
        return typeof answer === 'function' ? answer(choices ?? []) : answer;
    }

    banner(): void {}
    print(text: string): void { this.printed.push(text); }
    table(spec: TableSpec): void { this.tables.push(spec); }
    async select<T>(question: { message: string; choices: Array<{ name: string; value: T }> }): Promise<T> {
        const names = question.choices.map(choice => choice.name);
        const answer = this.next('select', question.message, names);
        const chosen = question.choices.find(choice => choice.name === answer);
        assert.ok(chosen, `No choice "${answer}" among ${names.join(' | ')}`);
        return chosen.value;
    }
    /** Like a real prompt, an answer the validator rejects is asked for again. */
    private valid(kind: string, question: { message: string; validate?: (input: string) => true | string }): string {
        for (;;) {
            const answer = String(this.next(kind, question.message));
            const check = question.validate?.(answer) ?? true;
            if (check === true) return answer;
            this.rejected.push(check);
        }
    }
    async input(question: { message: string; validate?: (input: string) => true | string }): Promise<string> {
        return this.valid('input', question);
    }
    async password(question: { message: string; validate?: (input: string) => true | string }): Promise<string> {
        return this.valid('password', question);
    }
    async confirm(question: { message: string }): Promise<boolean> { return Boolean(this.next('confirm', question.message)); }
    async autocomplete(question: { message: string; source: (input: string) => Array<{ name: string; value: string }> }): Promise<string> {
        return String(this.next('autocomplete', question.message, question.source('').map(choice => choice.name)));
    }
    spinner(text: string) {
        this.spinners.push(text);
        return {
            succeed: (message: string) => { this.spinners.push(`ok: ${message}`); },
            fail: (message: string) => { this.spinners.push(`fail: ${message}`); },
            stop: () => {}
        };
    }
    readonly rejected: string[] = [];
    done(): void { assert.deepEqual(this.answers, [], 'Unused answers'); }
}

const plugin = {
    id: 'eth', family: 'evm', name: '[ETH] Ethereum', url: 'https://rpc.invalid', nativeToken: 'ETH',
    explorer: 'https://explorer.invalid/tx/', tokens: { USDT: { address: '0x0' } }, NetworkClass: class {}
} as unknown as NetworkPlugin;
const bitcoin = { ...plugin, id: 'btc', family: 'bitcoin', name: '[BTC] Bitcoin', nativeToken: 'BTC', tokens: {} } as unknown as NetworkPlugin;

const terminalCapabilities: SessionCapabilities = { replaceAccount: true, balanceHistory: true, switchNetworkFirst: false, exactAmounts: false };
const browserCapabilities: SessionCapabilities = { replaceAccount: false, balanceHistory: false, switchNetworkFirst: true, exactAmounts: true };

function result(overrides: Partial<TransferResult> = {}): TransferResult {
    return {
        from: 'from-address', to: 'to-address', asset: 'ETH', amount: '0.5', amountBaseUnits: '1',
        fee: { asset: 'ETH', amount: '0.001', baseUnits: '1', decimals: 18, estimated: true },
        transactionHash: '0xabc', network: 'eth', status: 'submitted', requestId: 'r1', ...overrides
    } as TransferResult;
}

function fakeSession(
    { transfers: transferOverrides, ...overrides }: Omit<Partial<WalletSession>, 'transfers'> & { transfers?: Partial<TransferPort> } = {}
): WalletSession & { calls: string[] } {
    const calls: string[] = [];
    let hasAccount = true;
    const transfers: TransferPort = {
        pending: async () => [],
        preview: async () => ({ amount: '9', fee: { amount: '0.1', asset: 'ETH' } }),
        send: async (draft, requestId) => { calls.push(`send ${draft.to} ${draft.asset} ${draft.amount} ${requestId.length > 8 ? 'id' : requestId}`); return result(); },
        record: async (sent, draft): Promise<SentTransfer> => ({
            timestamp: '2026-01-02T03:04:00Z', recipient: draft.to, token: draft.asset, amount: sent.amount, status: sent.status, url: `https://explorer.invalid/tx/${sent.transactionHash}`
        }),
        ...transferOverrides
    };
    const session: WalletSession & { calls: string[] } = {
        calls,
        capabilities: terminalCapabilities,
        plugin,
        transfers,
        network: { validateMnemonic: (value: string) => value === 'valid words', validatePrivateKey: (value: string) => value === 'valid key' } as never,
        start: async () => { calls.push('start'); },
        networks: () => [plugin, bitcoin],
        selectNetwork: async () => { calls.push('select'); },
        hasAccount: async () => hasAccount,
        address: async () => 'my-address',
        hasMnemonic: async () => false,
        createAccount: async kind => { calls.push(`create ${kind}`); hasAccount = true; },
        importMnemonic: async mnemonic => { calls.push(`mnemonic ${mnemonic}`); hasAccount = true; },
        importPrivateKey: async key => { calls.push(`key ${key}`); hasAccount = true; },
        accountDetails: async () => ({ address: 'my-address', privateKey: 'secret-key', mnemonic: 'secret words' }),
        tokenBalances: async () => [['ETH', '1.5'], ['USDT', '20']],
        sentTransfers: async () => [],
        importActions: () => [],
        exportActions: () => [],
        menuActions: () => [],
        ...overrides
    };
    return session;
}

const messages = (ui: ScriptedUi) => ui.prompts.map(prompt => prompt.message);

test('main menu offers host actions before Exit and runs them', async () => {
    const ran: string[] = [];
    const swap: HostAction = { name: 'Swap', run: async () => { ran.push('swap'); } };
    const ui = new ScriptedUi(['Swap', 'Exit']);
    await mainMenu(ui, fakeSession({ menuActions: () => [swap] }));
    assert.deepEqual(ui.prompts[0].choices, ['Transfer Funds', 'Show Balance', 'Show Sent Transfers', 'Account Settings', 'Swap', 'Exit']);
    assert.deepEqual(ran, ['swap']);
    ui.done();
});

test('account menus follow the host capabilities', async () => {
    const backup: HostAction = { name: 'Import Backup File', run: async () => true };
    const firstRun = new ScriptedUi(['Switch Network', '[BTC] Bitcoin']);
    let has = false;
    const session = fakeSession({
        capabilities: browserCapabilities, importActions: () => [backup],
        hasAccount: async () => has, selectNetwork: async () => { has = true; }
    });
    await loadAccount(firstRun, session);
    assert.deepEqual(firstRun.prompts[0].choices, ['Create New Account', 'Import Backup File', 'Import Mnemonic (12 or 24 words)', 'Import Private-key', 'Switch Network']);

    const loggedIn = new ScriptedUi(['Import Options', 'Import Backup File', true]);
    await loadAccount(loggedIn, fakeSession({ capabilities: browserCapabilities, importActions: () => [backup] }), true);
    assert.deepEqual(loggedIn.prompts[0].choices, ['Import Options', 'Export Options', 'Switch Network', 'Go Back']);
    assert.match(loggedIn.prompts[2].message, /without a backup it cannot be recovered/);
    assert.equal(loggedIn.tables.at(-1)!.head[0], '[ETH] Ethereum Address');
    loggedIn.done();

    const terminal = new ScriptedUi(['Go Back']);
    await loadAccount(terminal, fakeSession({ contacts: { list: async () => [], get: async () => undefined, set: async () => {}, delete: async () => {}, clear: async () => {} } }), true);
    assert.deepEqual(terminal.prompts[0].choices, ['Create New Account', 'Import Options', 'Export Options', 'Switch Network', 'Manage Address Book', 'Go Back']);
});

test('switching network before any account keeps offering the first-run choices', async () => {
    let has = false;
    const session = fakeSession({
        capabilities: browserCapabilities, hasAccount: async () => has,
        importPrivateKey: async () => { has = true; },
        selectNetwork: async () => { has = false; }
    });
    const ui = new ScriptedUi(['Switch Network', '[ETH] Ethereum', 'Import Private-key', 'valid key']);
    await loadAccount(ui, session);
    assert.deepEqual(ui.prompts.filter(prompt => prompt.message === 'Select an account option:').map(prompt => prompt.choices),
        Array(2).fill(['Create New Account', 'Import Mnemonic (12 or 24 words)', 'Import Private-key', 'Switch Network']));
    assert.equal(ui.printed[0], '\nNo account found for [ETH] Ethereum. Please create or import an account.');
    ui.done();
});

test('importing validates input, skips empty input and reports an invalid private key', async () => {
    const session = fakeSession({ hasAccount: async () => false });
    const empty = new ScriptedUi(['Import Mnemonic (12 or 24 words)', '  ']);
    await loadAccount(empty, session);
    assert.deepEqual(empty.rejected, []);
    assert.deepEqual(session.calls, []);

    const invalid = new ScriptedUi(['Import Mnemonic (12 or 24 words)', 'bad words', 'valid words']);
    await loadAccount(invalid, session);
    assert.deepEqual(invalid.rejected, ['Please enter a valid mnemonic phrase or leave empty to cancel.']);
    assert.deepEqual(session.calls, ['mnemonic valid words']);
    assert.equal(invalid.tables.at(-1)!.head[0], '[ETH] Ethereum Address');

    const failing = fakeSession({ hasAccount: async () => false, importPrivateKey: async () => { throw new Error('rejected'); } });
    const rejected = new ScriptedUi(['Import Private-key', 'valid key']);
    await loadAccount(rejected, failing);
    assert.equal(rejected.tables.at(-1)!.head[0], 'Invalid private-key.');
});

test('account details are shown as a secret table and cleared afterwards', async () => {
    let details: { privateKey: string; mnemonic?: string } | undefined;
    const session = fakeSession({ accountDetails: async () => (details = { address: 'a', privateKey: 'secret-key', mnemonic: 'secret words' } as never) });
    const ui = new ScriptedUi([]);
    await showAccountDetails(ui, session);
    const table = ui.tables[0];
    assert.equal(table.secret, true);
    assert.deepEqual(table.rows!.map(row => row[0]), ['Address', 'Private-key', 'Mnemonic Phrase', 'WARNING']);
    assert.equal(details!.privateKey, '');
    assert.equal(details!.mnemonic, '');
});

test('balance uses two decimals for USDT and the shared amount format elsewhere', async () => {
    const ui = new ScriptedUi([]);
    await showBalance(ui, fakeSession());
    assert.deepEqual(ui.tables[0].rows, [['ETH', '1.50'], ['USDT', '20.00']]);
});

test('hosts that show exact amounts never round a balance or a sent transfer', async () => {
    const dust = fakeSession({
        capabilities: browserCapabilities,
        tokenBalances: async () => [['BTC', '0.00012345'], ['USDT', '20.123456']],
        sentTransfers: async () => [{ timestamp: new Date(2026, 0, 2, 3, 4), recipient: 'to', token: 'BTC', amount: '0.00001234', url: 'https://x/1' }]
    });
    const balance = new ScriptedUi([]);
    await showBalance(balance, dust);
    assert.deepEqual(balance.tables[0].rows, [['BTC', '0.00012345'], ['USDT', '20.123456']]);
    const sent = new ScriptedUi([]);
    await showTransactions(sent, dust);
    assert.equal((sent.tables[0].rows![0] as string[])[3], '0.00001234');

    const rounded = new ScriptedUi([]);
    await showBalance(rounded, fakeSession({ tokenBalances: async () => [['BTC', '0.00012345']] }));
    assert.deepEqual(rounded.tables[0].rows, [['BTC', '0.00']]);
});

test('sent transfers show only the columns the host records', async () => {
    const sent: SentTransfer = { timestamp: new Date(2026, 0, 2, 3, 4), recipient: 'to', contact: 'Bob', token: 'ETH', amount: '1', balance: '5', status: 'confirmed', url: 'https://x/1' };
    const terminal = new ScriptedUi([]);
    await showTransactions(terminal, fakeSession({ sentTransfers: async () => [sent], contacts: { list: async () => [], get: async () => undefined, set: async () => {}, delete: async () => {}, clear: async () => {} } }));
    assert.deepEqual(terminal.tables[0].head, ['Date', 'Recipient', 'Contact', 'Token', 'Amount', 'Balance', 'Status']);
    assert.deepEqual(terminal.tables[0].rows![0], ['2026-01-02 03:04', 'to', 'Bob', 'ETH', '1.00', '5.00', 'confirmed']);
    assert.deepEqual(terminal.tables[0].rows![1], [{ colSpan: 7, content: 'https://x/1' }]);

    const browser = new ScriptedUi([]);
    await showTransactions(browser, fakeSession({ capabilities: browserCapabilities, sentTransfers: async () => [] }));
    assert.deepEqual(browser.tables[0].head, ['Date', 'Recipient', 'Token', 'Amount', 'Status']);
    assert.deepEqual(browser.tables[0].rows, [[{ colSpan: 5, content: 'No transaction history available.' }]]);
});

test('transfer asks recipient, token, amount and confirmation, then sends and records once', async () => {
    const session = fakeSession();
    const ui = new ScriptedUi(['0xrecipient', 'USDT', ' 1.5 ', true]);
    await transferFunds(ui, session);
    assert.deepEqual(messages(ui), ['Recipient address:', 'Token to transfer:', 'Amount to transfer (or max):', 'Confirm transfer of 1.5 USDT?']);
    assert.deepEqual(session.calls, ['send 0xrecipient USDT 1.5 id']);
    assert.deepEqual(ui.spinners, ['Checking / sending transaction...', 'ok: Transaction submitted; awaiting confirmation.']);
    assert.equal(ui.tables[0].head.includes('Contact'), false);
    ui.done();
});

test('transfer is cancelled by an empty recipient, empty amount or a declined confirmation', async () => {
    const cases: Answer[][] = [[''], ['0xr', 'ETH', ''], ['0xr', 'ETH', '1', false]];
    for (const answers of cases) {
        const session = fakeSession();
        const ui = new ScriptedUi(answers);
        await transferFunds(ui, session);
        assert.deepEqual(session.calls, []);
        ui.done();
    }
});

test('max previews the fee and sends max to hosts without a review', async () => {
    const session = fakeSession();
    const ui = new ScriptedUi(['0xr', 'ETH', ' MAX ', true]);
    await transferFunds(ui, session);
    assert.deepEqual(ui.printed, ['Maximum: 9 ETH | Estimated fee: 0.1 ETH']);
    assert.equal(ui.prompts.at(-1)!.message, 'Confirm transfer of maximum available ETH (estimated 9)?');
    assert.deepEqual(session.calls, ['send 0xr ETH max id']);
});

test('a host review is shown before confirmation and can stop the transfer', async () => {
    const reviewed: string[] = [];
    const review = async (draft: { amount: string }): Promise<Cell[][]> => { reviewed.push(draft.amount); return [['To', '0xr'], ['Maximum fee', '0.1 ETH']]; };
    const session = fakeSession({ transfers: { review } });
    const ui = new ScriptedUi(['0xr', 'ETH', 'max', true]);
    await transferFunds(ui, session);
    assert.deepEqual(reviewed, ['9']);
    assert.deepEqual(ui.tables[0].rows, [['To', '0xr'], ['Maximum fee', '0.1 ETH']]);
    assert.deepEqual(session.calls, ['send 0xr ETH max id']);

    const rejecting = fakeSession({ transfers: { review: async () => { throw new Error('Insufficient funds for the amount and network fee.'); } } });
    const stopped = new ScriptedUi(['0xr', 'ETH', '1']);
    await transferFunds(stopped, rejecting);
    assert.equal(stopped.tables[0].head[0], 'Insufficient funds for the amount and network fee.');
    assert.deepEqual(rejecting.calls, []);
    stopped.done();
});

test('a pending transfer is resumed with its own request id and, when reviewed, only after confirmation', async () => {
    const pending = [{ requestId: 'saved-1', to: '0xr', asset: 'ETH', amount: '1', status: 'broadcast_unknown' }];
    const plain = fakeSession({ transfers: { pending: async () => pending } });
    const ui = new ScriptedUi([(choices: string[]) => choices[0]]);
    await transferFunds(ui, plain);
    assert.deepEqual(plain.calls, ['send 0xr ETH 1 saved-1']);

    const reviewed = fakeSession({ transfers: { pending: async () => pending, review: async (_draft, resume) => [['Saved', String(resume)]] } });
    const declined = new ScriptedUi([(choices: string[]) => choices[0], false]);
    await transferFunds(declined, reviewed);
    assert.deepEqual(reviewed.calls, []);
    assert.equal(declined.prompts.at(-1)!.message, 'Send the saved transaction?');
    const accepted = new ScriptedUi([(choices: string[]) => choices[0], true]);
    await transferFunds(accepted, reviewed);
    assert.deepEqual(reviewed.calls, ['send 0xr ETH 1 saved-1']);
});

test('failed transfers keep the recovery details and never report success', async () => {
    const unknown = new AgentError('BROADCAST_UNKNOWN', 'Outcome unknown.', 5, { requestId: 'r9', transactionHash: '0xdead' });
    const session = fakeSession({ transfers: { send: async () => { throw unknown; } } });
    const ui = new ScriptedUi(['0xr', 'ETH', '1', true]);
    await transferFunds(ui, session);
    assert.deepEqual(ui.spinners, ['Checking / sending transaction...', 'fail: Could not complete the transfer request.']);
    assert.deepEqual(ui.printed, ['Saved transfer: r9', 'https://explorer.invalid/tx/0xdead',
        'Open Transfer Funds to check or resume any saved request before creating another payment.']);

    const swap = new AgentError('SWAP_IN_PROGRESS', 'Swap active.', 5, { requestId: 'swap-1' });
    const blocked = new ScriptedUi(['0xr', 'ETH', '1', true]);
    await transferFunds(blocked, fakeSession({ transfers: { send: async () => { throw swap; } } }));
    assert.equal(blocked.printed[0], 'Blocking swap: swap-1');
});

test('initialization failures keep their cause so hosts can tell a lock from an error', async () => {
    const aborted = fakeSession({ hasAccount: async () => false });
    await assert.rejects(initialize(new ScriptedUi([() => { throw new PromptAborted(); }]), aborted), error => {
        assert.match((error as Error).message, /^Initialization failed: /);
        return isPromptAborted(error);
    });
    const empty = fakeSession({ hasAccount: async () => false });
    await assert.rejects(initialize(new ScriptedUi(['Import Private-key', '']), empty), error => {
        assert.equal((error as Error).message, 'Initialization failed: Failed to initialize account.');
        return !isPromptAborted(error);
    });
});

test('initialization shows the address once, whether the account is new or existing', async () => {
    const addressTables = (ui: ScriptedUi) => ui.tables.filter(table => table.head[0] === '[ETH] Ethereum Address').length;

    let created = false;
    const fresh = fakeSession({
        hasAccount: async () => created,
        createAccount: async () => { created = true; }
    });
    const setup = new ScriptedUi(['Create New Account', false, false]);
    await initialize(setup, fresh);
    assert.equal(addressTables(setup), 1);
    setup.done();

    const existing = new ScriptedUi([]);
    await initialize(existing, fakeSession());
    assert.equal(addressTables(existing), 1);
});
