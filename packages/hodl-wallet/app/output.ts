import { errorMessage, formatAmount, formatDate } from './format.js';
import type { SentTransfer, WalletSession } from './session.js';
import type { Cell, TableSpec, Tone, Ui } from './ui.js';

export const WELCOME_ART = ` ░░░░░░░░░░░░░░ █ █\u2003█▀█\u2003█▀▄\u2003█   ░░░░░░░░░░░░░░
 ░░░░░░░░░░░░░░ █▀█\u2003█▄█\u2003█▄▀\u2003█▄▄ ░░░░░░░░░░░░░░
 ░░░░░░░░░░░░░░ ──────── WALLET ░░░░░░░░░░░░░░`;

const EXIT_PHRASES = [
    "Buy the rumor, sell the news",
    "The trend is your friend",
    "Don't fight the tape",
    "Cut your losses and let your profits run",
    "Be fearful when others are greedy, and greedy when others are fearful",
    "The market can remain irrational longer than you can remain solvent",
    "Bulls make money, bears make money, pigs get slaughtered",
    "No one is bigger than the market",
    "Don't catch a falling knife",
    "Past performance is not indicative of future results",
    "The stock market is a device for transferring money from the impatient to the patient",
    "Time in the market beats timing the market",
    "Buy low, sell high",
    "Diversification is the only free lunch in investing",
    "The four most dangerous words in investing are: 'This time it's different'",
    "Markets can remain irrational a lot longer than you and I can remain solvent",
    "Risk comes from not knowing what you're doing",
    "In the short run, the market is a voting machine. In the long run, it's a weighing machine",
    "Invest in yourself. Your career is the engine of your wealth",
    "Who has the gold makes the rules",
    "The best time to invest was yesterday. The second best time is now",
    "Don't put all your eggs in one basket",
    "Knowledge is power in the world of investing",
    "Patience is a virtue in the stock market",
    "The market is never wrong, but opinions often are"
];

export function welcome(ui: Ui): void {
    ui.banner(WELCOME_ART);
}

export function farewell(ui: Ui): void {
    ui.table({
        head: ['✨ Good bye!'],
        tone: 'yellow',
        wordWrap: true,
        rows: [[EXIT_PHRASES[Math.floor(Math.random() * EXIT_PHRASES.length)]]]
    });
}

export function notice(ui: Ui, tone: Tone, head: string, text: string): void {
    ui.table({ head: [head], tone, rows: [[text]] });
}

export function showError(ui: Ui, message: string, data?: unknown): void {
    ui.table({ head: [message], tone: 'red', wordWrap: true, ...(data ? { rows: [[String(data)]] } : {}) });
}

export function showTransactionError(ui: Ui, error: unknown): void {
    const reason = typeof error === 'object' && error !== null && 'reason' in error
        ? String(error.reason)
        : null;
    const message = error instanceof Error ? error.message : errorMessage(error);
    const data = reason ? reason.replace(/(\w+):/g, "\n$1:").trim() : null;
    showError(ui, message, data);
}

export async function showAddress(ui: Ui, session: WalletSession): Promise<void> {
    ui.table({ head: [`${session.plugin.name} Address`], tone: 'green', rows: [[await session.address()]] });
}

/** Sent transfers, one row each followed by its explorer link. Columns follow what the host records. */
export function sentTransfersTable(
    session: Pick<WalletSession, 'capabilities' | 'contacts'>,
    transfers: SentTransfer[],
    options: { status: boolean; tone: Tone; empty?: string }
): TableSpec {
    const withContact = Boolean(session.contacts);
    const withBalance = session.capabilities.balanceHistory;
    const head = ['Date', 'Recipient', ...(withContact ? ['Contact'] : []), 'Token', 'Amount',
        ...(withBalance ? ['Balance'] : []), ...(options.status ? ['Status'] : [])];
    const rows: Cell[][] = [];
    if (options.empty && transfers.length === 0) rows.push([{ colSpan: head.length, content: options.empty }]);
    for (const tx of transfers) {
        rows.push([
            formatDate(tx.timestamp), tx.recipient,
            ...(withContact ? [tx.contact ?? '-'] : []),
            tx.token, formatAmount(tx.amount),
            ...(withBalance ? [tx.balance !== undefined ? formatAmount(tx.balance) : '-'] : []),
            ...(options.status ? [tx.status || '-'] : [])
        ]);
        rows.push([{ colSpan: head.length, content: tx.url }]);
    }
    return { head, rows, tone: options.tone };
}
