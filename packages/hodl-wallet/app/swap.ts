import { randomUUID } from '#environment';
import { formatUnits, normalizeDecimal, parseDecimalToUnits } from '../amounts.js';
import { swapConfig } from '../swap/config.js';
import type { SwapService } from '../swap/service.js';
import { terminalSwapStates } from '../swap/types.js';
import { errorMessage } from './format.js';
import type { SwapState } from '../swap/types.js';
import { isPromptAborted } from './ui.js';
import type { Choice, Ui } from './ui.js';

/** What the swap flows need from a swap service. */
export type SwapPort = Pick<SwapService, 'route' | 'list' | 'status' | 'resume' | 'availableBalance' | 'destination' | 'quote' | 'execute'>;

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
const providerNames = { chainflip: 'Chainflip', thorchain: 'THORChain', 'near-intents': 'NEAR Intents' };

async function withSpinner<T>(ui: Ui, text: string, work: () => Promise<T>): Promise<T> {
    const spinner = ui.spinner(text);
    try { return await work(); }
    finally { spinner.stop(); }
}

/** Prompt aborts end the flow like any other prompt; anything else is reported and returns to the menu. */
function report(ui: Ui, error: unknown, fallback: string): void {
    if (isPromptAborted(error)) throw error;
    ui.print(error instanceof Error ? errorMessage(error) : fallback);
}

export async function swapMenu(ui: Ui, service: SwapPort): Promise<void> {
    const { source, destination } = service.route;
    const route = await ui.select({
        message: 'Swap:',
        choices: [
            { name: `${source.label} → ${destination.label}`, value: 'new' },
            { name: 'Track Swaps', value: 'track' },
            { name: 'Go Back', value: 'back', back: true }
        ]
    });
    if (route === 'back') return;
    if (route === 'track') await trackSwaps(ui, service);
    else await startSwap(ui, service);
}

async function startSwap(ui: Ui, service: SwapPort): Promise<void> {
    const { source, destination } = service.route;
    try {
        const existing = (await withSpinner(ui, 'Checking existing swaps…', () => service.list())).find(swap => !terminalSwapStates.includes(swap.state));
        if (existing) {
            ui.print(`An unfinished swap already exists: ${existing.requestId}. Open Track Swaps to check its status.`);
            return;
        }
        const available = await withSpinner(ui, 'Checking available balance…', () => service.availableBalance());
        if (available <= 0n) { ui.print(`No ${source.label} available to swap.`); return; }
        const balance = formatUnits(available, source.decimals);
        const amount = await ui.input({
            message: `${source.label} to exchange (max, empty to cancel):`,
            validate(value: string) {
                if (!value.trim() || value.trim().toLowerCase() === 'max') return true;
                try {
                    return parseDecimalToUnits(normalizeDecimal(value.trim()), source.decimals) <= available
                        || `Insufficient ${source.label}. Available: ${balance}.`;
                } catch (error) { return (error as Error).message; }
            }
        });
        if (!amount.trim()) return;
        const ownAddress = await withSpinner(ui, `Loading ${destination.label} account…`, () => service.destination());
        const addresses = ownAddress ? [{ name: 'My account', address: ownAddress }] : [];
        if (!ownAddress) ui.print(`No ${destination.label} account is configured in this profile. Create or import an account on that network, then return to Swap; or enter an external address.`);
        const to = await ui.autocomplete({
            message: `Receive ${destination.label} at:`,
            source: input => {
                const search = input.trim();
                const matches: Array<Choice<string>> = addresses.filter(entry =>
                    entry.name.toLowerCase().includes(search.toLowerCase()) || entry.address.toLowerCase().includes(search.toLowerCase())
                ).map(entry => ({ name: `${entry.name} (${entry.address})`, value: entry.address }));
                if (search && !matches.some(entry => entry.value === search)) matches.push({ name: search, value: search });
                return [
                    ...(!ownAddress && !search ? [{ name: 'My account', value: '', disabled: `${destination.label} account not configured` }] : []),
                    ...matches, { name: 'Go Back', value: '', back: true }
                ];
            }
        });
        if (!to) return;
        const maximum = amount.trim().toLowerCase() === 'max';
        let comparison = await withSpinner(ui, 'Comparing Chainflip, THORChain and NEAR Intents, including network fees…', () => service.quote(maximum ? balance : amount.trim(), to));
        if (maximum && source.asset === 'BTC' && comparison.quotes.length) {
            const reserve = comparison.quotes.reduce((largest, quote) => {
                const fee = parseDecimalToUnits(quote.funding.budget, source.decimals);
                return fee > largest ? fee : largest;
            }, 0n) + BigInt(swapConfig.bitcoin.changeDustSats);
            if (available <= reserve) { ui.print('Insufficient BTC for the network fee and required change.'); return; }
            const maximumAmount = formatUnits(available - reserve, source.decimals);
            ui.print(`Max: ${maximumAmount} BTC · reserving ${formatUnits(reserve, source.decimals)} BTC for network fees and required change.`);
            comparison = await withSpinner(ui, 'Updating quotes for max amount…', () => service.quote(maximumAmount, to));
        }
        for (const unavailable of comparison.unavailable) ui.print(`${unavailable.provider}: ${unavailable.reason}`);
        comparison.quotes = comparison.quotes.filter(quote => {
            if (quote.sufficientAsset && quote.sufficientFee) return true;
            ui.print(`${providerNames[quote.provider]}: insufficient ${!quote.sufficientAsset ? source.label : quote.funding.asset + ' for the deposit and network fee budget'}.`);
            return false;
        });
        if (!comparison.quotes.length) { ui.print('No executable quote available. No funds were sent.'); return; }
        comparison.recommendedQuoteId = comparison.quotes[0].quoteId;
        const quoteId = await ui.select({
            message: 'Choose a quote:',
            choices: [
                ...comparison.quotes.map(quote => ({
                    name: `${providerNames[quote.provider]} · ≈ ${quote.destination.estimated} ${quote.destination.asset} · ≈ ${quote.estimatedTotalCost.percent}% cost${quote.quoteId === comparison.recommendedQuoteId ? ' · best after gas' : ''}`,
                    value: quote.quoteId
                })), { name: 'Cancel', value: 'cancel', back: true }
            ]
        });
        if (quoteId === 'cancel') return;
        const quote = comparison.quotes.find(item => item.quoteId === quoteId)!;
        ui.table({
            head: [{ colSpan: 2, content: `${quote.source.amount} ${quote.source.asset} → ≈ ${quote.destination.estimated} ${quote.destination.asset}` }],
            tone: 'blue',
            rows: [
                ['Route', `${source.label} → ${destination.label} · ${providerNames[quote.provider]} · ${quote.execution}`],
                ['From', quote.from], ['To', quote.to],
                ['Minimum', `${quote.destination.minimum} ${quote.destination.asset} · full swap · ${quote.slippagePercent}% tolerance`],
                ['Cost', `≈ ${quote.estimatedTotalCost.percent}% (USD ${Number(quote.estimatedTotalCost.usd).toFixed(2)}) · incl. price impact + gas`],
                ['Network fee', `Up to ${quote.funding.budget} ${quote.funding.asset} extra on ${quote.source.network.toUpperCase()}`],
                ['Time', `${quote.estimatedSeconds === null ? '' : `≈ ${Math.ceil(quote.estimatedSeconds / 60)} min + `}${quote.destination.confirmations} ${quote.destination.asset} confirmations to complete`],
                ['Refund', `${source.label} → sender above, minus fees`],
                ['Expires', new Date(quote.expiresAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')]
            ]
        });
        ui.print(`Provider fees already deducted from estimated ${destination.asset}. Source network fee is extra.`);
        if (quote.refund.partialResultPossible) {
            ui.print(`Partial fill possible: ${destination.asset} received + remaining ${source.asset} refunded minus fees.`);
            ui.print('The minimum above applies only to a full swap.');
        }
        ui.print(`Once exchanged, delayed ${destination.asset} cannot auto-refund to ${source.asset}.`);
        const confirmed = await ui.confirm({ message: 'Accept destination, cost and minimum, and swap?', default: false });
        if (!confirmed) return;
        const operation = await withSpinner(ui, 'Preparing and submitting swap…', () => service.execute(quoteId, randomUUID()));
        showSwap(ui, operation);
        if (!terminalSwapStates.includes(operation.state)) await followSwap(ui, service, operation, true);
    } catch (error) { report(ui, error, 'Swap could not be started.'); }
}

async function trackSwaps(ui: Ui, service: SwapPort): Promise<void> {
    try {
        const refreshed = new Set<string>();
        const swaps = await withSpinner(ui, 'Updating swap statuses…', async () => {
            const entries = await service.list();
            for (let i = 0; i < entries.length; i++) {
                if (!terminalSwapStates.includes(entries[i].state)) {
                    entries[i] = await service.status(entries[i].requestId);
                    refreshed.add(entries[i].requestId);
                }
            }
            return entries;
        });
        if (!swaps.length) { ui.print('No swaps recorded.'); return; }
        const requestId = await ui.select({
            message: 'Select a swap:',
            choices: [
                ...swaps.map(swap => ({ name: swapRow(swap), value: swap.requestId })),
                { name: 'Go back', value: 'back', back: true }
            ]
        });
        if (requestId === 'back') return;
        const current = refreshed.has(requestId) ? swaps.find(swap => swap.requestId === requestId)! :
            await withSpinner(ui, 'Checking swap status…', () => service.status(requestId));
        showSwap(ui, current, current.state !== swaps.find(swap => swap.requestId === requestId)!.state);
        if (terminalSwapStates.includes(current.state)) return;
        await followSwap(ui, service, current, false);
    } catch (error) { report(ui, error, 'Could not update swaps.'); }
}

/** Waits, or less once the person leaves. */
function pause(ms: number, leaving: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([leaving, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })])
        .finally(() => clearTimeout(timer));
}

/** Polls until the swap settles, needs attention, or the person leaves. A request under way always finishes first. */
async function followSwap(ui: Ui, service: SwapPort, initial: SwapView, resume: boolean): Promise<void> {
    ui.print('Updating automatically. Press Enter to return to the menu. Leaving this screen does not cancel funds already sent.');
    const watch = ui.watch('Updating swap…');
    let left = false;
    let aborted: unknown;
    const leaving = watch.left.then(() => { left = true; }, error => { aborted = error; });
    const settled = (): boolean => {
        if (aborted) throw aborted;
        return left;
    };
    let previous = swapDisplayKey(initial);
    try {
        while (!settled()) {
            const operation = await (resume ? service.resume(initial.requestId) : service.status(initial.requestId));
            if (settled()) return;
            const signature = swapDisplayKey(operation);
            if (signature !== previous) { watch.pause(); showSwap(ui, operation); previous = signature; }
            if (terminalSwapStates.includes(operation.state) || operation.state === 'needs_attention') return;
            watch.update(`${labels[operation.state]}${operation.message ? ` · ${operation.message}` : ''} · Enter to return`);
            await pause(swapConfig.pollIntervalMs, leaving);
        }
    } finally { watch.stop(); }
}

function swapRow(swap: SwapView): string {
    const stale = swap.updateError && !terminalSwapStates.includes(swap.state) ? ' · update unavailable' : '';
    return `${swap.createdAt.slice(0, 16).replace('T', ' ')} · ${swap.quote.source.amount} ${swap.quote.source.asset} → ${swap.quote.destination.asset} · ${labels[swap.state].split(' · ')[0]}${stale}`;
}

function swapDisplayKey(operation: SwapView): string {
    return JSON.stringify([operation.state, operation.confirmations, operation.updateError, operation.transactions, operation.delayed, operation.message, operation.payout, operation.refund, operation.refundConfirmations]);
}

function showSwap(ui: Ui, swap: SwapView, showHeading = true): void {
    if (showHeading) ui.print(`Swap ${swap.requestId}: ${labels[swap.state]} · ${swap.quote.source.asset} (${swap.quote.source.network}) → ${swap.quote.destination.asset} (${swap.quote.destination.network})`);
    if (swap.payout) ui.print(`${swap.quote.destination.asset} confirmations: ${swap.confirmations}/${swap.requiredConfirmations}`);
    for (const transaction of swap.transactions) ui.print(`${transaction.kind}: ${transaction.explorer}`);
    if (swap.payout) ui.print(`${swap.quote.destination.asset} payout: ${swap.payout.amount} ${swap.quote.destination.asset} · ${swap.payout.explorer}`);
    if (swap.refund) {
        ui.print(`${swap.quote.source.asset} refund: ${swap.refund.amount} ${swap.quote.source.asset} · ${swap.refund.explorer}`);
        ui.print(`${swap.quote.source.network.toUpperCase()} refund confirmations: ${swap.refundConfirmations}/${swap.requiredRefundConfirmations}`);
    }
    if (swap.message) ui.print(swap.message);
    if (swap.updateError) ui.print(`Could not update or continue: ${swap.updateError} Last successful check: ${swap.lastCheckedAt || 'none'}.`);
    if (swap.delayed) ui.print('This swap is taking longer than expected. Keep its ID and transaction links; do not send another deposit.');
}
