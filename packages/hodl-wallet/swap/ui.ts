import crypto from 'node:crypto';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import ora from 'ora';
import { formatUnits, normalizeDecimal, parseDecimalToUnits } from '../amounts.js';
import { swapConfig } from './config.js';
import { terminalSwapStates } from './types.js';
import type { SwapState } from './types.js';
import { SwapService } from './service.js';

const labels: Record<SwapState, string> = {
    quoted: 'Quote ready', preparing: 'Preparing deposit', approval_pending: 'Waiting for token approval',
    deposit_pending: 'Deposit sent · waiting for confirmation', deposit_confirmed: 'Deposit recognized',
    swapping: 'Exchanging assets', payout_pending: 'Preparing payout', btc_pending: 'BTC sent · waiting for inclusion',
    btc_confirming: 'BTC received · confirming', output_pending: 'Payout sent · waiting for inclusion',
    output_confirming: 'Payout received · confirming', completed: 'Completed', partial_pending: 'Payout and refund · awaiting confirmation',
    partial_completed: 'Partially exchanged · payout received and remainder returned', refund_pending: 'Refund pending',
    refunded: 'Swap refunded', failed: 'Not completed · deposit not transferred', needs_attention: 'Needs attention'
};

type SwapView = Awaited<ReturnType<SwapService['status']>>;
const providerNames = { chainflip: 'Chainflip', thorchain: 'THORChain' };

async function withSpinner<T>(text: string, work: () => Promise<T>): Promise<T> {
    const spinner = ora({ text, spinner: 'dots' }).start();
    try { return await work(); }
    finally { spinner.stop(); }
}

export async function startSwapMenu(service: SwapService): Promise<void> {
    try {
        const { source, destination } = service.route;
        const { route } = await inquirer.prompt({
            type: 'list', name: 'route', message: 'Swap:',
            choices: [
                { name: `${source.label} → ${destination.label}`, value: 'new' },
                { name: 'Track Swaps', value: 'track' },
                { name: 'Go Back', value: 'back' }
            ]
        });
        if (route === 'back') return;
        if (route === 'track') {
            await trackSwapsMenu(service);
            return;
        }
        const existing = (await withSpinner('Checking existing swaps…', () => service.list())).find(swap => !terminalSwapStates.includes(swap.state));
        if (existing) {
            console.log(`An unfinished swap already exists: ${existing.requestId}. Open Track Swaps to check its status.`);
            return;
        }
        const available = await withSpinner('Checking available balance…', () => service.availableBalance());
        if (available <= 0n) { console.log(`No ${source.label} available to swap.`); return; }
        const balance = formatUnits(available, source.decimals);
        const { amount }: { amount: string } = await inquirer.prompt({
            type: 'input', name: 'amount', message: `${source.label} to exchange (max, empty to cancel):`,
            validate(value: string) {
                if (!value.trim() || value.trim().toLowerCase() === 'max') return true;
                try {
                    return parseDecimalToUnits(normalizeDecimal(value.trim()), source.decimals) <= available
                        || `Insufficient ${source.label}. Available: ${balance}.`;
                } catch (error) { return (error as Error).message; }
            }
        });
        if (!amount.trim()) return;
        const ownAddress = await withSpinner(`Loading ${destination.label} account…`, () => service.destination());
        const addresses = ownAddress ? [{ name: 'My account', address: ownAddress }] : [];
        if (!ownAddress) console.log(`No ${destination.label} account is configured in this profile. Create or import an account on that network, then return to Swap; or enter an external address.`);
        const { destination: to }: { destination: string } = await inquirer.prompt({
            type: 'autocomplete', name: 'destination', message: `Receive ${destination.label} at:`,
            source: (_answers: Record<string, unknown>, input = '') => {
                const search = (input || '').trim();
                const matches = addresses.filter(entry =>
                    entry.name.toLowerCase().includes(search.toLowerCase()) || entry.address.toLowerCase().includes(search.toLowerCase())
                ).map(entry => ({ name: `${entry.name} (${entry.address})`, value: entry.address }));
                if (search && !matches.some(entry => entry.value === search)) matches.push({ name: search, value: search });
                return [
                    ...(!ownAddress && !search ? [{ name: 'My account', value: '', disabled: `${destination.label} account not configured` }] : []),
                    ...matches, { name: 'Go Back', value: '' }
                ];
            }
        });
        if (!to) return;
        const maximum = amount.trim().toLowerCase() === 'max';
        let comparison = await withSpinner('Comparing Chainflip and THORChain, including network fees…', () => service.quote(maximum ? balance : amount.trim(), to));
        if (maximum && source.asset === 'BTC' && comparison.quotes.length) {
            const reserve = comparison.quotes.reduce((largest, quote) => {
                const fee = parseDecimalToUnits(quote.funding.budget, source.decimals);
                return fee > largest ? fee : largest;
            }, 0n) + BigInt(swapConfig.bitcoin.changeDustSats);
            if (available <= reserve) { console.log('Insufficient BTC for the network fee and required change.'); return; }
            const maximumAmount = formatUnits(available - reserve, source.decimals);
            console.log(`Max: ${maximumAmount} BTC · reserving ${formatUnits(reserve, source.decimals)} BTC for network fees and required change.`);
            comparison = await withSpinner('Updating quotes for max amount…', () => service.quote(maximumAmount, to));
        }
        for (const unavailable of comparison.unavailable) console.log(`${unavailable.provider}: ${unavailable.reason}`);
        comparison.quotes = comparison.quotes.filter(quote => {
            if (quote.sufficientAsset && quote.sufficientFee) return true;
            console.log(`${providerNames[quote.provider]}: insufficient ${!quote.sufficientAsset ? source.label : quote.funding.asset + ' for the deposit and network fee budget'}.`);
            return false;
        });
        if (!comparison.quotes.length) { console.log('No executable quote available. No funds were sent.'); return; }
        comparison.recommendedQuoteId = comparison.quotes[0].quoteId;
        const { quoteId }: { quoteId: string } = await inquirer.prompt({
            type: 'list', name: 'quoteId', message: 'Choose a quote:',
            choices: [
                ...comparison.quotes.map(quote => ({
                    name: `${providerNames[quote.provider]} · ≈ ${quote.destination.estimated} ${quote.destination.asset} · ≈ ${quote.estimatedTotalCost.percent}% cost${quote.quoteId === comparison.recommendedQuoteId ? ' · best after gas' : ''}`,
                    value: quote.quoteId
                })), { name: 'Cancel', value: 'cancel' }
            ]
        });
        if (quoteId === 'cancel') return;
        const quote = comparison.quotes.find(item => item.quoteId === quoteId)!;
        console.log(`\n  ${quote.source.amount} ${quote.source.asset} → ≈ ${quote.destination.estimated} ${quote.destination.asset}`);
        console.log(`  ${source.label} → ${destination.label} · ${providerNames[quote.provider]} · ${quote.execution}\n`);
        const table = new Table({
            wordWrap: true,
            colWidths: [11, Math.max(40, Math.min(70, (process.stdout.columns || 80) - 14))],
            chars: { 'top-left': '╭', 'top-right': '╮', 'bottom-left': '╰', 'bottom-right': '╯' },
            style: { 'padding-left': 1, 'padding-right': 1, compact: true }
        });
        table.push(
            { From: quote.from }, { To: quote.to },
            { Minimum: `${quote.destination.minimum} ${quote.destination.asset} · full swap · ${quote.slippagePercent}% tolerance` },
            { Cost: `≈ ${quote.estimatedTotalCost.percent}% (USD ${Number(quote.estimatedTotalCost.usd).toFixed(2)}) · incl. price impact + gas` },
            { 'Network fee': `Up to ${quote.funding.budget} ${quote.funding.asset} extra on ${quote.source.network.toUpperCase()}` },
            { Time: `${quote.estimatedSeconds === null ? '' : `≈ ${Math.ceil(quote.estimatedSeconds / 60)} min + `}${quote.destination.confirmations} ${quote.destination.asset} confirmations to complete` },
            { Refund: `${source.label} → sender above, minus fees` },
            { Expires: new Date(quote.expiresAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') }
        );
        console.log(table.toString());
        console.log(`\n  Provider fees already deducted from estimated ${destination.asset}. Source network fee is extra.`);
        if (quote.refund.partialResultPossible) console.log(`  Partial fill possible: ${destination.asset} received + remaining ${source.asset} refunded minus fees.\n  The minimum above applies only to a full swap.`);
        console.log(`  Once exchanged, delayed ${destination.asset} cannot auto-refund to ${source.asset}.\n`);
        const { confirmed }: { confirmed: boolean } = await inquirer.prompt({
            type: 'confirm', name: 'confirmed', default: false, message: 'Accept destination, cost and minimum, and swap?'
        });
        if (!confirmed) return;
        const operation = await withSpinner('Preparing and submitting swap…', () => service.execute(quoteId, crypto.randomUUID()));
        showSwap(operation);
        if (!terminalSwapStates.includes(operation.state)) await followSwap(service, operation, true);
    } catch (error) { console.error(error instanceof Error ? error.message : 'Swap could not be started.'); }
}

export async function trackSwapsMenu(service: SwapService): Promise<void> {
    try {
        const refreshed = new Set<string>();
        const swaps = await withSpinner('Updating swap statuses…', async () => {
            const entries = await service.list();
            for (let i = 0; i < entries.length; i++) {
                if (!terminalSwapStates.includes(entries[i].state)) {
                    entries[i] = await service.status(entries[i].requestId);
                    refreshed.add(entries[i].requestId);
                }
            }
            return entries;
        });
        if (!swaps.length) { console.log('No swaps recorded.'); return; }
        const { requestId }: { requestId: string } = await inquirer.prompt({
            type: 'list', name: 'requestId', message: 'Select a swap:',
            choices: [
                ...swaps.map(swap => ({ name: `${swap.createdAt} · ${swap.quote.source.amount} ${swap.quote.source.asset} (${swap.quote.source.network}) → ${swap.quote.destination.asset} (${swap.quote.destination.network}) · ${labels[swap.state]}${swap.updateError ? ' · Status update unavailable' : ''} · ${swap.requestId}`, value: swap.requestId })),
                { name: 'Go back', value: 'back' }
            ]
        });
        if (requestId === 'back') return;
        const current = refreshed.has(requestId) ? swaps.find(swap => swap.requestId === requestId)! :
            await withSpinner('Checking swap status…', () => service.status(requestId));
        showSwap(current, current.state !== swaps.find(swap => swap.requestId === requestId)!.state);
        if (terminalSwapStates.includes(current.state)) return;
        await followSwap(service, current, false);
    } catch (error) { console.error(error instanceof Error ? error.message : 'Could not update swaps.'); }
}

async function followSwap(service: SwapService, initial: SwapView, resume: boolean): Promise<void> {
    console.log('Updating automatically. Press Enter to return to the menu. Leaving this screen does not cancel funds already sent.');
    const controller = new AbortController();
    const spinner = ora({ text: 'Updating swap…', spinner: 'dots', discardStdin: false }).start();
    controller.signal.addEventListener('abort', () => spinner.stop(), { once: true });
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    input.once('line', () => controller.abort());
    input.once('close', () => controller.abort());
    let previous = swapDisplayKey(initial);
    try {
        while (!controller.signal.aborted) {
            const operation = await (resume ? service.resume(initial.requestId) : service.status(initial.requestId));
            if (controller.signal.aborted) return;
            const signature = swapDisplayKey(operation);
            if (signature !== previous) { spinner.stop(); showSwap(operation); previous = signature; }
            if (terminalSwapStates.includes(operation.state) || operation.state === 'needs_attention') return;
            spinner.start(`${labels[operation.state]}${operation.message ? ` · ${operation.message}` : ''} · Enter to return`);
            try { await delay(swapConfig.pollIntervalMs, undefined, { signal: controller.signal }); }
            catch { if (!controller.signal.aborted) throw new Error('Progress timer failed.'); }
        }
    } finally { spinner.stop(); input.close(); }
}

function swapDisplayKey(operation: SwapView): string {
    return JSON.stringify([operation.state, operation.confirmations, operation.updateError, operation.transactions, operation.delayed, operation.message, operation.payout, operation.refund, operation.refundConfirmations]);
}

function showSwap(swap: SwapView, showHeading = true): void {
    if (showHeading) console.log(`\nSwap ${swap.requestId}: ${labels[swap.state]} · ${swap.quote.source.asset} (${swap.quote.source.network}) → ${swap.quote.destination.asset} (${swap.quote.destination.network})`);
    if (swap.payout) console.log(`${swap.quote.destination.asset} confirmations: ${swap.confirmations}/${swap.requiredConfirmations}`);
    for (const transaction of swap.transactions) console.log(`${transaction.kind}: ${transaction.explorer}`);
    if (swap.payout) console.log(`${swap.quote.destination.asset} payout: ${swap.payout.amount} ${swap.quote.destination.asset} · ${swap.payout.explorer}`);
    if (swap.refund) {
        console.log(`${swap.quote.source.asset} refund: ${swap.refund.amount} ${swap.quote.source.asset} · ${swap.refund.explorer}`);
        console.log(`${swap.quote.source.network.toUpperCase()} refund confirmations: ${swap.refundConfirmations}/${swap.requiredRefundConfirmations}`);
    }
    if (swap.message) console.log(swap.message);
    if (swap.updateError) console.log(`Could not update or continue: ${swap.updateError} Last successful check: ${swap.lastCheckedAt || 'none'}.`);
    if (swap.delayed) console.log('This swap is taking longer than expected. Keep its ID and transaction links; do not send another deposit.');
}
