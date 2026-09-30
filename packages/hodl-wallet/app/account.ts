import { clearSensitiveData } from '../sensitive-data.js';
import { notice, showAddress, showError } from './output.js';
import type { HostAction, WalletSession } from './session.js';
import type { Choice, Ui } from './ui.js';

type AccountAction =
    | 'create' | 'import' | 'export' | 'switch' | 'addressBook' | 'back'
    | 'importMnemonic' | 'importPrivateKey' | HostAction;

async function confirmOverwrite(ui: Ui, session: WalletSession): Promise<boolean> {
    if (!await session.hasAccount()) return true;
    return ui.confirm({
        message: 'This action will overwrite the existing account. Are you sure you want to continue?',
        default: false
    });
}

async function importFromMnemonic(ui: Ui, session: WalletSession): Promise<void> {
    const mnemonic = await ui.password({
        message: 'Enter your mnemonic phrase (12 or 24 words):',
        validate: input => {
            if (input.trim() === '') return true;
            return session.network.validateMnemonic(input) || 'Please enter a valid mnemonic phrase or leave empty to cancel.';
        }
    });
    if (!mnemonic.trim()) return;
    await session.importMnemonic(mnemonic);
    await showAddress(ui, session);
}

async function importPrivateKey(ui: Ui, session: WalletSession): Promise<void> {
    const privateKey = await ui.password({
        message: 'Private-key (leave empty to cancel):',
        validate: input => {
            if (input.trim() === '') return true;
            return session.network.validatePrivateKey(input) ||
                'Please enter a valid private-key for the selected network or leave empty to cancel.';
        }
    });
    if (!privateKey.trim()) return;
    try {
        await session.importPrivateKey(privateKey);
        await showAddress(ui, session);
    } catch {
        showError(ui, 'Invalid private-key.');
    }
}

export async function showAccountDetails(ui: Ui, session: WalletSession): Promise<void> {
    const account = await session.accountDetails();
    if (!account) {
        showError(ui, 'Account not initialized.');
        return;
    }
    const rows = [['Address', account.address], ['Private-key', account.privateKey]];
    if (account.mnemonic) {
        rows.push(['Mnemonic Phrase', account.mnemonic]);
        rows.push(['WARNING', 'Please keep your private-key and mnemonic phrase secure. Never share it.']);
    } else {
        rows.push(['WARNING', 'Please keep your private-key secure. Never share it.']);
    }
    ui.table({ head: [{ colSpan: 2, content: 'Account Details' }], tone: 'green', wordWrap: true, secret: true, rows });
    clearSensitiveData(account);
}

async function createNewAccount(ui: Ui, session: WalletSession): Promise<void> {
    let created = false;
    if (await session.hasMnemonic()) {
        const useExisting = await ui.confirm({ message: 'Use existing mnemonic to create account?', default: true });
        if (useExisting) {
            await session.createAccount('existing-mnemonic');
            created = true;
        }
    }

    if (!created) {
        const withMnemonic = await ui.confirm({ message: 'Create account with mnemonic?', default: true });
        if (withMnemonic) {
            const words = await ui.select<12 | 24>({
                message: 'Choose mnemonic phrase length:',
                choices: [
                    { name: '12 words (standard)', value: 12 },
                    { name: '24 words (more secure)', value: 24 }
                ],
                default: 12
            });
            await session.createAccount(words);
        } else {
            await session.createAccount('random');
        }
    }

    const contacts = await session.contacts?.list() ?? [];
    if (session.contacts && contacts.length > 0) {
        const clear = await ui.confirm({
            message: `Do you want to delete all ${contacts.length} addresses from the previous account?`,
            default: false
        });
        if (clear) {
            await session.contacts.clear();
            notice(ui, 'green', 'Address Book', 'All addresses deleted successfully.');
        }
    }

    let message = 'Do you want to display sensitive information (private key';
    if (await session.hasMnemonic()) message += ' and mnemonic';
    message += ')?';

    if (await ui.confirm({ message, default: false })) {
        await showAccountDetails(ui, session);
    } else {
        await showAddress(ui, session);
    }
}

export async function switchNetwork(ui: Ui, session: WalletSession, loggedIn = true): Promise<void> {
    const plugin = await ui.select({
        message: 'Select the network:',
        choices: session.networks().map(network => ({ name: network.name, value: network }))
    });
    await session.selectNetwork(plugin);

    if (await session.hasAccount()) {
        await showAddress(ui, session);
    } else {
        ui.print(`\nNo account found for ${session.plugin.name}. Please create or import an account.`);
        await loadAccount(ui, session, loggedIn);
    }
}

async function deleteFromAddressBook(ui: Ui, session: WalletSession): Promise<void> {
    const contacts = await session.contacts!.list();
    if (contacts.length === 0) {
        notice(ui, 'yellow', 'Address Book', 'No addresses in the address book.');
        return;
    }

    const address = await ui.select<string>({
        message: 'Select an address to delete:',
        choices: [
            ...contacts.map(contact => ({ name: `${contact.address} (${contact.name})`, value: contact.address })),
            { name: 'Go Back', value: '' }
        ]
    });
    if (!address) return;

    if (await ui.confirm({ message: 'Are you sure you want to delete this address?', default: false })) {
        await session.contacts!.delete(address);
        notice(ui, 'green', 'Address Book', 'Address deleted successfully.');
    }
}

/** Offers to name a recipient the address book does not know yet. */
export async function saveContact(ui: Ui, session: WalletSession, address: string): Promise<void> {
    if (!session.contacts || await session.contacts.get(address)) return;
    const name = await ui.input({ message: 'Name for the address book (leave empty to skip):' });
    if (name.trim() === '') return;
    await session.contacts.set(address, name);
    ui.table({
        head: [{ colSpan: 2, content: 'Recipient saved to the address book.' }],
        tone: 'green',
        rows: [[name, address]]
    });
}

async function runImport(ui: Ui, session: WalletSession, action: AccountAction): Promise<void> {
    if (action === 'importMnemonic') {
        await importFromMnemonic(ui, session);
    } else if (action === 'importPrivateKey') {
        await importPrivateKey(ui, session);
    } else if (typeof action === 'object' && await action.run(ui)) {
        await showAddress(ui, session);
    }
}

function importChoices(session: WalletSession): Array<Choice<AccountAction>> {
    return [
        ...session.importActions().map(action => ({ name: action.name, value: action as AccountAction })),
        { name: 'Import Mnemonic (12 or 24 words)', value: 'importMnemonic' },
        { name: 'Import Private-key', value: 'importPrivateKey' }
    ];
}

export async function loadAccount(ui: Ui, session: WalletSession, loggedIn = false): Promise<void> {
    if (!loggedIn && await session.hasAccount()) return;

    const choices: Array<Choice<AccountAction>> = [];
    if (!loggedIn) {
        choices.push({ name: 'Create New Account', value: 'create' }, ...importChoices(session));
        if (session.capabilities.switchNetworkFirst) choices.push({ name: 'Switch Network', value: 'switch' });
    } else {
        if (session.capabilities.replaceAccount) {
            choices.push({ name: 'Create New Account', value: 'create' }, { name: 'Import Options', value: 'import' });
        }
        choices.push({ name: 'Export Options', value: 'export' }, { name: 'Switch Network', value: 'switch' });
        if (session.contacts) choices.push({ name: 'Manage Address Book', value: 'addressBook' });
        choices.push({ name: 'Go Back', value: 'back', back: true });
    }

    const action = await ui.select({ message: 'Select an account option:', choices });

    if (action === 'back') return;

    if (action === 'addressBook') {
        const next = await ui.select<'delete' | 'back'>({
            message: 'Select an address book option:',
            choices: [{ name: 'Delete Address', value: 'delete' }, { name: 'Go Back', value: 'back', back: true }]
        });
        if (next === 'back') return loadAccount(ui, session, loggedIn);
        await deleteFromAddressBook(ui, session);
        return;
    }

    if (action === 'import') {
        const next = await ui.select<AccountAction>({
            message: 'Select an import option:',
            choices: [...importChoices(session), { name: 'Go Back', value: 'back', back: true }]
        });
        if (next === 'back') return loadAccount(ui, session, loggedIn);
        if (!await confirmOverwrite(ui, session)) return;
        await runImport(ui, session, next);
        return;
    }

    if (action === 'export') {
        const next = await ui.select<AccountAction | 'privateKey'>({
            message: 'Select an export option:',
            choices: [
                ...session.exportActions().map(item => ({ name: item.name, value: item as AccountAction })),
                { name: 'Export Private-key', value: 'privateKey' },
                { name: 'Go Back', value: 'back', back: true }
            ]
        });
        if (next === 'back') return loadAccount(ui, session, loggedIn);
        if (next === 'privateKey') await showAccountDetails(ui, session);
        else if (typeof next === 'object') await next.run(ui);
        return;
    }

    if (action === 'create') {
        if (!await confirmOverwrite(ui, session)) return;
        await createNewAccount(ui, session);
        return;
    }

    if (action === 'switch') {
        await switchNetwork(ui, session, loggedIn);
        return;
    }

    await runImport(ui, session, action);
}
