import { randomUUID } from '#environment';
import { AgentError } from '../agent-errors.js';
import { normalizeDecimal } from '../amounts.js';
import type { TransferResult } from '../transfer-service.js';
import { saveContact } from './account.js';
import { errorMessage } from './format.js';
import { sentTransfersTable, showError, showTransactionError } from './output.js';
import type { TransferDraft, WalletSession } from './session.js';
import type { Ui } from './ui.js';

/** Shows the host's review of a transfer. False means the user must not be asked to send it. */
async function reviewed(ui: Ui, session: WalletSession, draft: TransferDraft, resume?: string): Promise<boolean> {
    const review = session.transfers.review;
    if (!review) return true;
    try {
        const rows = await review.call(session.transfers, draft, resume);
        ui.table({ head: [{ colSpan: 2, content: resume ? 'Saved transfer' : 'Review transfer' }], rows, tone: 'blue', wordWrap: true });
    } catch (error) {
        showTransactionError(ui, error);
        return false;
    }
    return resume ? ui.confirm({ message: 'Send the saved transaction?', default: false }) : true;
}

async function submitTransfer(ui: Ui, session: WalletSession, draft: TransferDraft, requestId: string): Promise<void> {
    const spinner = ui.spinner('Checking / sending transaction...');
    let result: TransferResult;
    try {
        result = await session.transfers.send(draft, requestId);
    } catch (error) {
        spinner.fail('Could not complete the transfer request.');
        showTransactionError(ui, error);
        if (error instanceof AgentError && error.code === 'SWAP_IN_PROGRESS') {
            ui.print(`Blocking swap: ${error.details?.requestId}`);
            ui.print('Open Swap > Track Swaps to refresh its saved status, then retry the transfer once the swap has finished.');
            return;
        }
        if (error instanceof AgentError && error.details?.transactionHash) {
            ui.print(`Saved transfer: ${error.details.requestId}`);
            ui.print(session.plugin.explorer + error.details.transactionHash);
        } else {
            ui.print(`Request ID: ${requestId}`);
        }
        ui.print('Open Transfer Funds to check or resume any saved request before creating another payment.');
        return;
    }

    spinner.succeed(result.status === 'confirmed' ? 'Transaction confirmed!' : 'Transaction submitted; awaiting confirmation.');
    try {
        const sent = await session.transfers.record(result, draft);
        ui.table(sentTransfersTable(session, [sent], { status: false, tone: 'green' }));
        await saveContact(ui, session, draft.to);
    } catch (error) {
        showError(ui, 'Transfer recorded; could not update balance, history or contact.', errorMessage(error));
    }
}

export async function transferFunds(ui: Ui, session: WalletSession): Promise<void> {
    const pending = await session.transfers.pending();
    if (pending.length) {
        const requestId = await ui.select<string>({
            message: 'A previous transfer is still pending:',
            choices: [
                ...pending.map(transfer => ({
                    name: `Check / resume ${transfer.amount} ${transfer.asset} to ${transfer.to} (${transfer.status})`,
                    value: transfer.requestId
                })),
                { name: 'New transfer', value: 'new' },
                { name: 'Go back', value: 'back', back: true }
            ]
        });
        if (requestId === 'back') return;
        if (requestId !== 'new') {
            const { to, asset, amount } = pending.find(item => item.requestId === requestId)!;
            const draft = { to, asset, amount };
            if (await reviewed(ui, session, draft, requestId)) await submitTransfer(ui, session, draft, requestId);
            return;
        }
    }

    const contacts = await session.contacts?.list() ?? [];
    const addressBook = [...contacts, { name: 'Go Back', address: '' }];

    // Address book entries first, then whatever was typed
    const recipient = await ui.autocomplete({
        message: 'Recipient address:',
        source: (input = '') => addressBook
            .filter(entry => entry.name.toLowerCase().includes(input.toLowerCase()) || entry.address.toLowerCase().includes(input.toLowerCase()))
            .map(entry => ({
                name: entry.address ? `${entry.address} (${entry.name})` : entry.name,
                value: entry.address
            }))
            .concat([{ name: input, value: input }])
    });
    if (!recipient) return;

    const plugin = session.plugin;
    const assets = Object.keys(plugin.tokens);
    assets.push(plugin.nativeToken);

    let asset = plugin.nativeToken;
    if (assets.length > 1) {
        asset = await ui.select({ message: 'Token to transfer:', choices: assets.map(name => ({ name, value: name })) });
    }

    const amount = (await ui.input({
        message: 'Amount to transfer (or max):',
        validate: value => {
            if (value.trim() === '' || value.trim().toLowerCase() === 'max') return true;
            try {
                normalizeDecimal(value.trim());
                return true;
            } catch {
                return 'Please enter a valid decimal amount, max, or leave empty to cancel.';
            }
        }
    })).trim();
    if (amount === '') return;

    const maximum = amount.toLowerCase() === 'max';
    let transferAmount = amount;
    if (maximum) {
        try {
            const preview = await session.transfers.preview({ to: recipient, asset });
            transferAmount = preview.amount;
            ui.print(`Maximum: ${preview.amount} ${asset} | Estimated fee: ${preview.fee.amount} ${preview.fee.asset}`);
        } catch (error) {
            showTransactionError(ui, error);
            return;
        }
    }

    const draft = { to: recipient, asset, amount: maximum ? 'max' : transferAmount };
    if (!await reviewed(ui, session, { ...draft, amount: transferAmount })) return;

    const confirmed = await ui.confirm({
        message: maximum
            ? `Confirm transfer of maximum available ${asset} (estimated ${transferAmount})?`
            : `Confirm transfer of ${transferAmount} ${asset}?`,
        default: true
    });
    if (!confirmed) return;

    await submitTransfer(ui, session, draft, randomUUID());
}
