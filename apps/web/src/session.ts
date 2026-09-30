import {
    AgentError, NetworkRegistry, clearSensitiveData, showError, type AccountDetails, type BaseNetworkContract, type Cell,
    type HostAction, type NetworkPlugin, type NewAccount, type SentTransfer, type SessionCapabilities, type TransferDraft,
    type TransferPort, type TransferResult, type Ui, type WalletSession
} from 'hodl-wallet/browser';
import { webConfig } from '../config.mjs';
import type { Display, Preset, Sweep, Toggle } from './terminal/display.js';
import { parseHodlFile, type HodlFile } from './hodl-file.js';
import type { DomTerminal } from './terminal/terminal.js';
import { VaultError, userMessage } from './vault-error.js';
import type { BrowserWallet, PublicWallet } from './wallet.js';
import type { TransferReview } from './transfers.js';

const vault = webConfig.vault;
const broadcastNotice = 'Broadcast started. Locking or closing this page will not cancel the transfer.';

function download(text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `hodl-backup-${new Date().toISOString().slice(0, 10)}.hodl-web.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The browser vault as a wallet session. A wallet that does not exist yet stays pending, holding the password
 * the user chose, until the first account is created or imported; only then is the vault written.
 */
export class BrowserSession implements WalletSession {
    readonly capabilities: SessionCapabilities = { replaceAccount: false, balanceHistory: false, switchNetworkFirst: true, exactAmounts: true };
    readonly transfers: TransferPort;

    private readonly registry = new NetworkRegistry();
    private password: string | undefined;
    private snapshot: PublicWallet | undefined;
    private selected!: NetworkPlugin;
    private instance!: BaseNetworkContract;
    private review: { value: TransferReview; draft: TransferDraft } | undefined;

    constructor(
        private readonly wallet: BrowserWallet,
        private readonly terminal: DomTerminal,
        private readonly display: Display,
        private readonly onNetwork: (name: string) => void,
        opened: { snapshot: PublicWallet } | { password: string }
    ) {
        if ('snapshot' in opened) this.snapshot = opened.snapshot;
        else this.password = opened.password;
        this.transfers = this.transferPort();
    }

    /** No vault exists yet; it is written when the first account is created or imported. */
    get isNew(): boolean { return this.snapshot === undefined; }

    get plugin(): NetworkPlugin { return this.selected; }
    get network(): BaseNetworkContract { return this.instance; }

    async start(): Promise<void> {
        await this.selectNetwork(this.networks()[0]);
    }

    networks(): NetworkPlugin[] {
        if (!this.snapshot) return this.registry.list();
        return this.snapshot.networks.map(network => this.registry.get(network.id));
    }

    async selectNetwork(plugin: NetworkPlugin): Promise<void> {
        this.selected = plugin;
        this.instance = new plugin.NetworkClass(plugin);
        this.instance.name = plugin.name;
        this.review = undefined;
        this.onNetwork(plugin.name);
    }

    async hasAccount(): Promise<boolean> {
        return this.snapshot !== undefined && this.snapshot.networks.some(network => network.id === this.selected.id);
    }

    async address(): Promise<string> {
        const address = await this.wallet.address(this.selected.id);
        if (!address) throw new VaultError('This wallet has no account for the selected network.');
        return address;
    }

    async hasMnemonic(): Promise<boolean> {
        return this.snapshot?.kind === 'mnemonic';
    }

    /** Opens the vault behind a spinner: deriving its key takes a moment. */
    private async protect<T>(text: string, work: () => Promise<T>): Promise<T> {
        const spinner = this.terminal.spinner(text);
        try {
            return await work();
        } finally {
            spinner.stop();
        }
    }

    private async opened(snapshot: PublicWallet): Promise<void> {
        this.snapshot = snapshot;
        this.password = undefined;
        if (!(await this.hasAccount())) await this.selectNetwork(this.networks()[0]);
    }

    private pendingPassword(): string {
        if (this.password === undefined) throw new VaultError('This wallet already has its accounts.');
        return this.password;
    }

    async createAccount(kind: NewAccount): Promise<void> {
        const password = this.pendingPassword();
        if (kind === 12 || kind === 24) {
            await this.opened(await this.protect('Protecting your wallet on this device…', () => this.wallet.create(vault.defaultName, password, kind)));
        } else if (kind === 'random') {
            const account = await this.instance.createAccount();
            try {
                await this.opened(await this.protect('Protecting your wallet on this device…',
                    () => this.wallet.importPrivateKey(vault.defaultName, password, this.selected.family, account.privateKey)));
            } finally { clearSensitiveData(account); }
        } else {
            throw new VaultError('This wallet has no recovery phrase to reuse.');
        }
    }

    /** Imports write the pending wallet, or replace the open one keeping its password. */
    async importMnemonic(mnemonic: string): Promise<void> {
        const password = this.password;
        await this.opened(await this.protect('Protecting your wallet on this device…', () => this.wallet.importMnemonic(vault.defaultName, password, mnemonic)));
    }

    async importPrivateKey(privateKey: string): Promise<void> {
        const password = this.password;
        await this.opened(await this.protect('Protecting your wallet on this device…',
            () => this.wallet.importPrivateKey(vault.defaultName, password, this.selected.family, privateKey)));
    }

    accountDetails(): Promise<AccountDetails | null> {
        return this.wallet.accountDetails(this.selected.id);
    }

    async tokenBalances(): Promise<Array<[string, string]>> {
        const rows = await this.wallet.balances(this.selected.id);
        if (rows.some(row => !row.balance)) throw new VaultError('Balance unavailable. Check your connection or try again.');
        if (rows.some(row => row.error)) this.terminal.print('Refresh failed. Showing cached balances that may be outdated.');
        return rows.map(row => [row.asset, row.balance!.amount]);
    }

    async sentTransfers(): Promise<SentTransfer[]> {
        const address = await this.address();
        const history = await this.protect('Checking saved transfers…', () => this.wallet.transferHistory(true, this.selected.id));
        const failed = history.find(entry => entry.error);
        if (failed) this.terminal.print(`Could not update every transfer: ${failed.error}`);
        return history
            .filter(entry => entry.network === this.selected.id && entry.from === address)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map(entry => ({
                timestamp: entry.createdAt, recipient: entry.to, token: entry.asset, amount: entry.amount,
                status: entry.status, url: entry.explorer + entry.transactionHash
            }));
    }

    importActions(): HostAction[] {
        return [
            { name: 'Import Backup File', run: () => this.restoreBackup() },
            { name: 'Import HODL File', run: () => this.importHodlFile() }
        ];
    }

    exportActions(): HostAction[] {
        return [{ name: 'Export Backup File', run: () => this.exportBackup() }];
    }

    menuActions(): HostAction[] {
        return [{ name: 'Display Settings', run: ui => this.settings(ui) }];
    }

    private async restoreBackup(): Promise<boolean> {
        const file = await this.terminal.chooseFile('Backup file:', '.json,application/json');
        if (!file) return false;
        if (file.size > vault.maxBytes) {
            showError(this.terminal, 'The backup exceeds the size limit.');
            return false;
        }
        const text = await file.text();
        const password = await this.terminal.password({ message: 'Backup password (becomes your wallet password):' });
        try {
            await this.opened(await this.protect('Opening the backup…', () => this.wallet.restore(text, password)));
            return true;
        } catch (error) {
            showError(this.terminal, userMessage(error));
            return false;
        }
    }

    private async importHodlFile(): Promise<boolean> {
        const chosen = await this.terminal.chooseFile('HODL file:', '.hodl');
        if (!chosen) return false;
        if (chosen.size > vault.maxBytes) {
            showError(this.terminal, 'The HODL file exceeds the size limit.');
            return false;
        }
        let file: HodlFile;
        try {
            file = parseHodlFile(await chosen.text());
        } catch (error) {
            showError(this.terminal, userMessage(error));
            return false;
        }
        const password = await this.terminal.password({ message: 'HODL file password:' });
        const pending = this.password;
        try {
            await this.opened(await this.protect('Opening the HODL file…',
                () => this.wallet.importHodlFile(vault.defaultName, pending, file, password)));
            return true;
        } catch (error) {
            showError(this.terminal, userMessage(error));
            return false;
        }
    }

    private async exportBackup(): Promise<void> {
        const text = await this.protect('Preparing the encrypted backup…', () => this.wallet.exportBackup());
        download(text);
        this.terminal.table({
            head: ['Backup File Exported'],
            tone: 'green',
            rows: [['Your encrypted backup download has started. Keep it somewhere safe; there is no remote recovery.']]
        });
    }

    private async settings(ui: Ui): Promise<void> {
        for (;;) {
            const state = this.display.state;
            const on = (value: boolean): string => value ? 'ON' : 'OFF';
            const choice = await ui.select<Toggle | 'preset' | 'sweep' | 'back'>({
                message: 'Display settings:',
                choices: [
                    { name: `Phosphor: ${this.display.presets.find(preset => preset.id === state.preset)!.name}`, value: 'preset' },
                    { name: `Scanlines and glow: ${on(state.scanlines)}`, value: 'scanlines' },
                    { name: `Rolling sweep bar: ${this.display.sweeps.find(sweep => sweep.id === state.sweep)!.name}`, value: 'sweep' },
                    { name: `Screen curvature, bezel and flicker: ${on(state.curvature)}`, value: 'curvature' },
                    { name: `Sound: ${on(state.sound)}`, value: 'sound' },
                    { name: 'Go Back', value: 'back', back: true }
                ]
            });
            if (choice === 'back') return;
            if (choice === 'preset') {
                const preset = await ui.select<Preset>({
                    message: 'Phosphor:',
                    choices: this.display.presets.map(item => ({ name: item.name, value: item.id })),
                    default: state.preset
                });
                this.display.setPreset(preset);
            } else if (choice === 'sweep') {
                const sweep = await ui.select<Sweep>({
                    message: 'Rolling sweep bar:',
                    choices: this.display.sweeps.map(item => ({ name: item.name, value: item.id })),
                    default: state.sweep
                });
                this.display.setSweep(sweep);
            } else {
                this.display.toggle(choice);
            }
        }
    }

    private rows(review: TransferReview, saved: boolean): Cell[][] {
        return [
            ['Network', review.networkName],
            ['From', review.from],
            ['To', review.to],
            ['Amount', `${review.amount} ${review.asset}`],
            ['Maximum fee', `${review.fee.amount} ${review.fee.asset}`],
            ['Review expires', new Date(review.expiresAt).toLocaleTimeString('en-US')],
            ...(saved && review.transactionHash ? [['Saved transaction', review.transactionHash]] : [])
        ];
    }

    private transferPort(): TransferPort {
        return {
            pending: async () => (await this.wallet.unresolvedTransfers(this.selected.id)).map(transfer => ({
                requestId: transfer.requestId!, to: transfer.to, asset: transfer.asset, amount: transfer.amount, status: transfer.status
            })),
            preview: async ({ to, asset }) => this.wallet.previewTransfer(this.selected.id, to, asset),
            review: async (draft: TransferDraft, resume?: string) => {
                this.review = undefined;
                const review = resume
                    ? await this.wallet.reviewSavedTransfer(this.selected.id, resume)
                    : await this.wallet.estimateTransfer({ network: this.selected.id, to: draft.to, asset: draft.asset, amount: draft.amount });
                this.review = { value: review, draft: { ...draft } };
                return this.rows(review, resume !== undefined);
            },
            send: async (draft, requestId) => {
                const reviewed = this.review;
                this.review = undefined;
                // `max` was resolved to a concrete amount before the review; anything else must match what was reviewed.
                if (!reviewed || reviewed.draft.to !== draft.to || reviewed.draft.asset !== draft.asset ||
                    (draft.amount !== 'max' && reviewed.draft.amount !== draft.amount)) {
                    throw new VaultError('Review this transfer before confirming it.');
                }
                const outcome = await this.wallet.confirmTransfer(reviewed.value.id, () => { this.terminal.print(broadcastNotice); });
                if (outcome.warning) {
                    throw new AgentError('BROADCAST_UNKNOWN', outcome.warning, 5,
                        { requestId: outcome.transfer.requestId ?? requestId, transactionHash: outcome.transfer.transactionHash });
                }
                return outcome.transfer;
            },
            record: async (result: TransferResult, draft: TransferDraft): Promise<SentTransfer> => ({
                timestamp: new Date(), recipient: draft.to, token: draft.asset, amount: result.amount, status: result.status,
                url: this.selected.explorer + result.transactionHash
            })
        };
    }
}
