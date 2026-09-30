import { loadAccount } from './account.js';
import { errorMessage, formatAmount } from './format.js';
import { sentTransfersTable, showAddress, showError } from './output.js';
import type { HostAction, WalletSession } from './session.js';
import { transferFunds } from './transfer.js';
import type { Ui } from './ui.js';

/** No account exists after the account menu closed. Hosts that can show the menu again may do so quietly. */
export class AccountNotInitialized extends Error {
    constructor() {
        super('Failed to initialize account.');
        this.name = 'AccountNotInitialized';
    }
}

type MainAction = 'transferFunds' | 'balance' | 'showTransactions' | 'account' | 'exit' | HostAction;

export async function showBalance(ui: Ui, session: WalletSession): Promise<void> {
    if (!await session.hasAccount()) {
        showError(ui, 'Account not initialized.');
        return;
    }

    const balances = await session.tokenBalances();
    const exact = session.capabilities.exactAmounts;
    ui.table({
        head: ['Token', 'Balance'],
        tone: 'blue',
        colWidths: [21, 22],
        rows: balances.map(([token, balance]) => [token,
            exact ? balance : token === 'USDT' ? Number(balance).toFixed(2) : formatAmount(balance)])
    });
}

export async function showTransactions(ui: Ui, session: WalletSession): Promise<void> {
    const transfers = await session.sentTransfers();
    ui.table(sentTransfersTable(session, transfers, { status: true, tone: 'blue', empty: 'No transaction history available.' }));
}

export async function mainMenu(ui: Ui, session: WalletSession): Promise<void> {
    for (;;) {
        const action = await ui.select<MainAction>({
            message: 'What would you like to do?',
            choices: [
                { name: 'Transfer Funds', value: 'transferFunds' },
                { name: 'Show Balance', value: 'balance' },
                { name: 'Show Sent Transfers', value: 'showTransactions' },
                { name: 'Account Settings', value: 'account' },
                ...session.menuActions().map(item => ({ name: item.name, value: item as MainAction })),
                { name: 'Exit', value: 'exit' }
            ]
        });

        if (action === 'exit') return;
        if (action === 'transferFunds') await transferFunds(ui, session);
        else if (action === 'balance') await showBalance(ui, session);
        else if (action === 'showTransactions') await showTransactions(ui, session);
        else if (action === 'account') await loadAccount(ui, session, true);
        else await action.run(ui);
    }
}

export async function initialize(ui: Ui, session: WalletSession): Promise<void> {
    try {
        await session.start();
        if (await session.hasAccount()) {
            await showAddress(ui, session);
            return;
        }
        await loadAccount(ui, session);
        if (!await session.hasAccount()) {
            throw new AccountNotInitialized();
        }
    } catch (error) {
        throw new Error(`Initialization failed: ${errorMessage(error)}`, { cause: error });
    }
}

/** The signed-in experience: pick or create an account, show its address, then the main menu. */
export async function runWallet(ui: Ui, session: WalletSession): Promise<void> {
    await initialize(ui, session);
    await mainMenu(ui, session);
}
