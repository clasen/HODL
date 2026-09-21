import './style.css';
import { webConfig } from '../config.mjs';
import { BrowserWallet, type PublicWallet, type BalanceRow } from './wallet.js';
import { VaultError, userMessage } from './vault-error.js';
import type { TransferInput, TransferReview, HistoryEntry, TransferOutcome } from './transfers.js';

type Page = 'home' | 'create' | 'mnemonic' | 'private-key' | 'restore' | 'unlock' | 'addresses' | 'backup' | 'send' | 'review';
const view = document.querySelector<HTMLElement>('#view')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
const palette = document.querySelector<HTMLDialogElement>('#palette')!;
const search = document.querySelector<HTMLInputElement>('#action-search')!;
const config = webConfig.vault;
let page: Page = 'home';
let exists = false;
let busy = false;
let generation = 0;
let snapshot: PublicWallet | undefined;
let nameDraft = 'My wallet';
let selectedNetwork = '';
let balanceRows: BalanceRow[] = [];
let loadingBalances = false;
let balanceRequest = 0;
let historyRows: HistoryEntry[] = [];
let tracking = false;
let historyRequest = 0;
let transferDraft: TransferInput | undefined;
let transferReview: TransferReview | undefined;
let broadcastStarted = false;

const wallet = new BrowserWallet(() => {
    generation++;
    snapshot = undefined;
    balanceRequest++;
    balanceRows = [];
    selectedNetwork = '';
    loadingBalances = false;
    historyRequest++;
    historyRows = [];
    tracking = false;
    transferDraft = undefined;
    transferReview = undefined;
    broadcastStarted = false;
    page = exists ? 'unlock' : 'home';
    closePalette();
    render();
    announce('Wallet locked.');
    void wallet.exists().then(value => {
        exists = value;
        if (!wallet.unlocked) { page = exists ? 'unlock' : 'home'; render(); }
    }).catch(error => announce(userMessage(error), true));
});

function escape(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function announce(message: string, error = false): void {
    notice.textContent = message;
    notice.classList.toggle('error', error);
}

function passwords(confirmation: boolean): string {
    return `<label for="password">${confirmation ? 'Vault password' : 'Password'}</label>
        <input id="password" name="password" type="password" required ${confirmation ? `minlength="${config.passwordMinChars}"` : ''} maxlength="${config.passwordMaxChars}" autocomplete="${confirmation ? 'new-password' : 'current-password'}" ${confirmation ? 'aria-describedby="password-help"' : ''}>
        ${confirmation ? `<p id="password-help" class="field-help">At least ${config.passwordMinChars} characters. You will need it to unlock your wallet and restore your backup.</p>
        <label for="confirmation">Confirm password</label><input id="confirmation" name="confirmation" type="password" required autocomplete="new-password" maxlength="${config.passwordMaxChars}">` : ''}`;
}

function named(): string {
    return `<label for="name">Wallet name</label><input id="name" name="name" value="${escape(nameDraft)}" required maxlength="${config.nameMaxChars}" autocomplete="off">`;
}

function form(title: string, description: string, fields: string, submit: string): string {
    return `<div class="form-layout"><div class="page-heading"><p class="eyebrow">LOCAL VAULT</p><h1>${title}</h1><p class="lede">${description}</p></div>
        <form id="wallet-form" class="wallet-form"><fieldset ${busy ? 'disabled' : ''}>${fields}
        <div class="form-actions"><button type="submit" class="primary">${busy ? 'Processing…' : submit}</button>
        ${page !== 'unlock' ? '<button type="button" data-action="back" class="quiet-button">Back</button>' : ''}</div></fieldset></form>
        ${busy ? '<p class="field-help" role="status">Protecting your data on this device. Press Esc to cancel.</p>' : ''}
        <p class="local-note">Your password and keys stay on this device.</p></div>`;
}

function addressCards(): string {
    return snapshot!.accounts.map(account => `<article class="address-card">
        <div class="address-heading"><h2>${account.family === 'bitcoin' ? 'Bitcoin' : 'EVM networks'}</h2><span class="network-tag">${account.family === 'bitcoin' ? 'BTC' : 'EVM'}</span></div>
        <p class="muted network-names">${account.networks.map(escape).join(' · ')}</p>
        <label class="sr-only" for="address-${account.family}">${account.family === 'bitcoin' ? 'Bitcoin' : 'EVM'} address</label>
        <input id="address-${account.family}" class="address" readonly value="${escape(account.address)}" spellcheck="false">
        <button data-copy="${account.family}" class="text-button" aria-label="Copy ${account.family === 'bitcoin' ? 'Bitcoin' : 'EVM'} address">Copy address <span aria-hidden="true">↗</span></button>
    </article>`).join('');
}

function balancePanel(): string {
    const network = snapshot!.networks.find(network => network.id === selectedNetwork)!;
    return `<section class="balance-panel" aria-label="Balances">
        <div class="network-controls"><div><label for="network">Network</label>
        <select id="network" ${busy ? 'disabled' : ''}>${snapshot!.networks.map(network => `<option value="${escape(network.id)}" ${network.id === selectedNetwork ? 'selected' : ''}>${escape(network.name)}</option>`).join('')}</select></div>
        <div class="balance-actions"><button data-action="refresh-balances" class="secondary" ${loadingBalances || busy ? 'disabled' : ''}>${loadingBalances ? 'Refreshing…' : 'Refresh balances'}</button>
        <button data-page="send" class="primary" ${busy || tracking ? 'disabled' : ''}>Send funds</button></div></div>
        <table class="balance-table"><thead><tr><th>Asset</th><th>Balance</th><th>Updated</th></tr></thead><tbody>
        ${network.assets.map(asset => {
            const row = balanceRows.find(row => row.asset === asset);
            return `<tr><th scope="row">${escape(asset)}</th><td>${row?.balance ? escape(row.balance.amount) : loadingBalances ? 'Loading…' : 'Unavailable'}</td>
                <td>${row?.checkedAt ? `${row.error ? 'Cached · ' : ''}${escape(new Date(row.checkedAt).toLocaleTimeString('en-US'))}` : '—'}</td></tr>`;
        }).join('')}</tbody></table>
        ${balanceRows.some(row => row.error) ? `<p class="field-help balance-error" role="status">${balanceRows.some(row => row.error && row.balance) ? 'Refresh failed. Cached balances may be outdated.' : 'Balance unavailable. Try refreshing.'}</p>` : ''}
    </section>`;
}

function transferState(status: HistoryEntry['status']): string {
    return { prepared: 'Prepared · not broadcast', broadcasting: 'Broadcast interrupted · outcome unknown',
        broadcast_unknown: 'Outcome unknown', submitted: 'Pending confirmation', confirmed: 'Confirmed',
        failed: 'Failed on chain', 'dry-run': 'Estimate' }[status];
}

function historyPanel(): string {
    return `<section class="history-panel" aria-labelledby="history-title"><div class="section-heading"><h2 id="history-title">Local activity</h2>
        <button data-action="refresh-history" class="secondary" ${tracking || busy ? 'disabled' : ''}>${tracking ? 'Checking activity…' : 'Refresh activity'}</button></div>
        <p class="field-help">Transfers recorded by this wallet, not a complete chain history.</p>
        ${historyRows.length ? `<ol class="transfer-list">${historyRows.map(transfer => `<li data-transfer-id="${escape(transfer.requestId!)}">
            <div class="transfer-heading"><strong>${escape(transfer.amount)} ${escape(transfer.asset)}</strong><span class="transfer-state" data-state="${escape(transfer.status)}">${escape(transferState(transfer.status))}</span></div>
            <p class="field-help">${escape(transfer.networkName)} · ${escape(new Date(transfer.createdAt).toLocaleString('en-US'))}</p>
            <dl class="transfer-details"><dt>To</dt><dd>${escape(transfer.to)}</dd><dt>Fee</dt><dd>${escape(transfer.fee.amount)} ${escape(transfer.fee.asset)}</dd><dt>Transaction</dt><dd><a href="${escape(transfer.explorer + encodeURIComponent(transfer.transactionHash))}" target="_blank" rel="noopener noreferrer">${escape(transfer.transactionHash)}</a></dd></dl>
            ${transfer.error ? `<p class="balance-error field-help">${escape(transfer.error)}</p>` : ''}
            ${['prepared', 'broadcasting', 'broadcast_unknown'].includes(transfer.status) ? `<button data-recover="${escape(transfer.requestId!)}" class="secondary" ${tracking || busy ? 'disabled' : ''}>Review saved transfer</button>` : ''}
        </li>`).join('')}</ol>` : `<p class="empty-activity">${tracking ? 'Reading saved transfers…' : 'No transfers recorded.'}</p>`}</section>`;
}

async function refreshHistory(refresh = true): Promise<void> {
    if (!snapshot || tracking) return;
    const request = ++historyRequest;
    tracking = true;
    if (page === 'home') render();
    try {
        const rows = await wallet.transferHistory(refresh);
        if (request === historyRequest) historyRows = rows;
    } catch (error) { if (request === historyRequest) announce(userMessage(error), true); }
    finally {
        if (request === historyRequest) {
            tracking = false;
            if (page === 'home' || page === 'backup') render();
        }
    }
}

function sendForm(): string {
    const network = snapshot!.networks.find(network => network.id === selectedNetwork)!;
    const draft = transferDraft!;
    return `<div class="form-layout"><div class="page-heading"><p class="eyebrow">${escape(network.name)}</p><h1>Send funds</h1></div>
        <form id="transfer-form" class="wallet-form"><fieldset ${busy || tracking ? 'disabled' : ''}>
            <label for="recipient">Recipient address</label><input id="recipient" name="to" value="${escape(draft.to)}" required autocomplete="off" spellcheck="false">
            <label for="asset">Asset</label><select id="asset" name="asset">${network.assets.map(asset => `<option value="${escape(asset)}" ${draft.asset === asset ? 'selected' : ''}>${escape(asset)}</option>`).join('')}</select>
            <label for="amount">Amount</label><input id="amount" name="amount" value="${escape(draft.amount)}" required inputmode="decimal" autocomplete="off" placeholder="0.00">
            <div class="form-actions"><button type="submit" class="primary">${busy ? 'Estimating…' : 'Review transfer'}</button><button type="button" data-page="home" class="quiet-button">Cancel</button></div>
        </fieldset></form><p class="field-help">The next screen shows the destination, amount and maximum network fee before signing.</p></div>`;
}

function reviewPanel(): string {
    const review = transferReview!;
    return `<section class="review-panel" aria-labelledby="review-title"><div class="page-heading"><p class="eyebrow">${escape(review.networkName)}</p><h1 id="review-title">Confirm transfer</h1></div>
        <p class="transfer-amount">${escape(review.amount)} <span>${escape(review.asset)}</span></p>
        <dl class="transfer-details"><dt>From</dt><dd>${escape(review.from)}</dd><dt>To</dt><dd>${escape(review.to)}</dd>
            <dt>Maximum fee</dt><dd>${escape(review.fee.amount)} ${escape(review.fee.asset)}</dd>
            <dt>Review expires</dt><dd>${escape(new Date(review.expiresAt).toLocaleTimeString('en-US'))}</dd>
            ${review.transactionHash ? `<dt>Saved transaction</dt><dd>${escape(review.transactionHash)}</dd>` : ''}</dl>
        <p class="field-help">${review.source === 'saved' ? 'This sends the exact saved transaction. It does not create a new payment or change the fee.' : 'Funds and fees will be checked again. A higher fee requires a new review.'}</p>
        <div class="form-actions"><button id="review-back" data-action="cancel-review" class="quiet-button" ${busy ? 'disabled' : ''}>Back</button>
        <button data-action="confirm-transfer" class="primary" ${busy ? 'disabled' : ''}>${busy ? broadcastStarted ? 'Submitting…' : 'Checking funds and fee…' : review.source === 'saved' ? 'Send saved transaction' : 'Confirm and send'}</button></div>
        ${busy ? `<p role="status" class="field-help">${broadcastStarted ? 'Broadcast started. Locking or closing this page will not cancel the transfer.' : 'Preparing the transfer. Locking cancels before broadcast.'}</p>` : ''}</section>`;
}

async function refreshBalances(): Promise<void> {
    if (!snapshot) return;
    const request = ++balanceRequest;
    const network = selectedNetwork;
    loadingBalances = true;
    if (page === 'home') render();
    try {
        const rows = await wallet.balances(network);
        if (request === balanceRequest) balanceRows = rows;
    } catch (error) { if (request === balanceRequest) announce(userMessage(error), true); }
    finally {
        if (request === balanceRequest) {
            loadingBalances = false;
            if (page === 'home') render();
        }
    }
}

function render(): void {
    document.querySelector('#session-state')!.textContent = wallet.unlocked ? 'Unlocked' : 'Locked';
    document.querySelector('#session-state')!.classList.toggle('unlocked', wallet.unlocked);
    document.querySelector<HTMLButtonElement>('#lock')!.hidden = !wallet.unlocked && !busy;
    document.querySelectorAll<HTMLButtonElement>('nav [data-page]').forEach(button => {
        button.disabled = button.dataset.page !== 'home' && !snapshot;
        const current = button.dataset.page === (['addresses', 'backup'].includes(page) ? page : 'home');
        if (current) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });

    if (page === 'send' && snapshot) {
        view.innerHTML = sendForm();
    } else if (page === 'review' && snapshot && transferReview) {
        view.innerHTML = reviewPanel();
    } else if (page === 'create') {
        view.innerHTML = form('Create a wallet', 'A new wallet for Bitcoin and EVM networks, protected by your password.',
            `${named()}<label for="words">Recovery phrase</label><select id="words" name="words"><option value="12">12 words</option><option value="24">24 words</option></select>${passwords(true)}`, 'Create wallet');
    } else if (page === 'mnemonic') {
        view.innerHTML = form('Import a recovery phrase', 'Recover your Bitcoin and EVM addresses from an existing phrase.',
            `${named()}<label for="mnemonic">Recovery phrase</label><textarea id="mnemonic" name="mnemonic" required rows="3" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="Enter the words in order, separated by spaces"></textarea>${passwords(true)}`, 'Import wallet');
    } else if (page === 'private-key') {
        view.innerHTML = form('Import a private key', 'Your wallet will contain the account for the selected network family.',
            `${named()}<label for="family">Network family</label><select id="family" name="family"><option value="evm">EVM networks</option><option value="bitcoin">Bitcoin</option></select>
            <label for="private-key">Private key</label><input id="private-key" name="privateKey" type="password" required autocomplete="off" spellcheck="false">${passwords(true)}`, 'Import wallet');
    } else if (page === 'restore') {
        view.innerHTML = form('Restore a backup', 'Choose your HODL Web backup and enter the password used to create it.',
            `<label for="backup-file">Encrypted backup</label><input id="backup-file" name="backup" type="file" required accept=".json,application/json"><p class="field-help">HODL Web v1 format. CLI .HODL files use a different format.</p>${passwords(false)}`, 'Restore wallet');
    } else if (page === 'unlock' || (exists && !snapshot)) {
        page = 'unlock';
        view.innerHTML = form('Your wallet is locked', 'Enter your password to access the accounts saved in this browser.', passwords(false), 'Unlock');
    } else if (page === 'backup' && snapshot) {
        view.innerHTML = `<div class="page-heading"><p class="eyebrow">RECOVERY</p><h1>Your backup</h1><p class="lede">An encrypted backup to recover this wallet in another browser.</p></div>
            <section class="backup-panel"><span class="backup-mark" aria-hidden="true">↓</span><div><h2>Backup of ${escape(snapshot.name)}</h2><p>Includes your accounts and local wallet data. You need your password to restore it.</p>
            <button data-action="download" class="primary" ${busy || tracking ? 'disabled' : ''}>${busy ? 'Preparing…' : 'Download encrypted backup'}</button></div></section>
            <div class="recovery-note"><h2>Keep it outside this browser</h2><p>Clearing site data can delete your vault. There is no remote recovery.</p><p>To restore it, open HODL in a browser without a wallet and choose “Restore backup”.</p></div>`;
    } else if (snapshot) {
        view.innerHTML = `<div class="page-heading"><p class="eyebrow">${page === 'addresses' ? 'RECEIVE' : 'LOCAL WALLET'}</p><h1>${page === 'addresses' ? 'Your addresses' : escape(snapshot.name)}</h1><p class="lede">${page === 'addresses' ? 'Copy the address for the network you need.' : `Vault unlocked. Locks automatically after ${config.idleMs / 60_000} minutes of inactivity.`}</p></div>
            ${page === 'home' ? balancePanel() : ''}
            ${page === 'home' ? historyPanel() : ''}
            <div class="address-grid">${addressCards()}</div>
            ${page === 'home' ? '<section class="backup-strip"><div><h2>Keep your backup handy.</h2><p>Save an encrypted copy so you can recover this wallet.</p></div><button data-page="backup" class="secondary">Save backup <span aria-hidden="true">↓</span></button></section>' : ''}
            `;
    } else {
        view.innerHTML = `<div class="welcome"><div class="page-heading"><p class="eyebrow">hodl@local:~</p><h1>Wallet session<span class="terminal-cursor" aria-hidden="true">▋</span></h1><p class="lede">No wallet open. Select an action to continue.</p></div>
            <div class="start-actions" aria-label="Wallet actions">
                <button data-page="create" class="command-row"><span class="command-index" aria-hidden="true">01</span><strong>Create wallet</strong><small>Generate new accounts</small><span aria-hidden="true">↵</span></button>
                <button data-page="mnemonic" class="command-row"><span class="command-index" aria-hidden="true">02</span><strong>Import phrase</strong><small>Use a recovery phrase</small><span aria-hidden="true">↵</span></button>
                <button data-page="private-key" class="command-row"><span class="command-index" aria-hidden="true">03</span><strong>Import private key</strong><small>One EVM or Bitcoin account</small><span aria-hidden="true">↵</span></button>
                <button data-page="restore" class="command-row"><span class="command-index" aria-hidden="true">04</span><strong>Restore backup</strong><small>Open an encrypted backup</small><span aria-hidden="true">↵</span></button>
            </div>
            <p class="recovery-warning">Save a backup. Clearing site data can delete your wallet; there is no remote recovery.</p></div>`;
    }
    view.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.tabIndex = 0; });
    view.querySelector<HTMLFormElement>('#wallet-form')?.addEventListener('submit', submit);
    view.querySelector<HTMLFormElement>('#transfer-form')?.addEventListener('submit', event => {
        event.preventDefault();
        if (busy || tracking) return;
        const data = new FormData(event.currentTarget as HTMLFormElement);
        transferDraft = { network: selectedNetwork, to: String(data.get('to')), asset: String(data.get('asset')), amount: String(data.get('amount')) };
        void perform(() => wallet.estimateTransfer(transferDraft!), value => {
            transferReview = value;
            page = 'review';
        });
    });
    view.querySelector<HTMLSelectElement>('#network')?.addEventListener('change', event => {
        selectedNetwork = (event.target as HTMLSelectElement).value;
        balanceRows = [];
        void refreshBalances();
    });
}

function navigate(next: Page): void {
    if (busy) return;
    if (next === 'send') {
        if (!snapshot || tracking) return;
        const network = snapshot.networks.find(network => network.id === selectedNetwork)!;
        if (!transferDraft || transferDraft.network !== selectedNetwork) {
            transferDraft = { network: selectedNetwork, to: '', asset: network.nativeAsset, amount: '' };
        }
    }
    wallet.cancelTransferReview();
    transferReview = undefined;
    announce('');
    page = next;
    closePalette();
    render();
    (view.querySelector<HTMLElement>('input, textarea, select') ?? view).focus();
}

async function perform<T>(task: (current: () => void) => Promise<T>, success: (value: T) => void): Promise<void> {
    if (busy) return;
    busy = true;
    const token = generation;
    announce('');
    render();
    try {
        const value = await task(() => { if (token !== generation) throw new VaultError('The operation was canceled.'); });
        if (token === generation) success(value);
    } catch (error) { if (token === generation) announce(userMessage(error), true); }
    finally {
        busy = false;
        try { exists = await wallet.exists(); } catch (error) { announce(userMessage(error), true); }
        if (exists && !wallet.unlocked) page = 'unlock';
        render();
        (page === 'review' ? view.querySelector<HTMLElement>('#review-back')! : view.querySelector<HTMLElement>('input, textarea, select') ?? view).focus();
    }
}

function opened(value: PublicWallet): void {
    snapshot = value;
    selectedNetwork = value.networks[0].id;
    exists = true;
    page = 'home';
    announce('');
    void refreshBalances();
    void refreshHistory();
}

function confirmTransfer(): void {
    if (busy || !transferReview) return;
    const reviewId = transferReview.id;
    broadcastStarted = false;
    void perform(async () => {
        try {
            return await wallet.confirmTransfer(reviewId, () => { broadcastStarted = true; render(); });
        } catch (error) {
            transferReview = undefined;
            if (wallet.unlocked) page = transferDraft ? 'send' : 'home';
            throw error;
        }
    }, (outcome: TransferOutcome) => {
        transferReview = undefined;
        transferDraft = undefined;
        page = 'home';
        announce(outcome.warning ?? transferState(outcome.transfer.status), Boolean(outcome.warning));
        void refreshHistory(false);
        void refreshBalances();
    });
}

function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const password = String(data.get('password') ?? '');
    if (data.has('confirmation') && password !== data.get('confirmation')) {
        announce('Passwords do not match.', true);
        return;
    }
    if (data.has('name')) nameDraft = String(data.get('name'));
    const mode = page;
    form.reset();
    if (mode === 'create') void perform(() => wallet.create(nameDraft, password, Number(data.get('words')) as 12 | 24), opened);
    if (mode === 'mnemonic') void perform(() => wallet.importMnemonic(nameDraft, password, String(data.get('mnemonic'))), opened);
    if (mode === 'private-key') void perform(() => wallet.importPrivateKey(nameDraft, password, String(data.get('family')) as 'evm' | 'bitcoin', String(data.get('privateKey'))), opened);
    if (mode === 'unlock') void perform(() => wallet.unlock(password), opened);
    if (mode === 'restore') void perform(async current => {
        const file = data.get('backup');
        if (!(file instanceof File) || !file.size) throw new VaultError('Choose a backup file.');
        if (file.size > config.maxBytes) throw new VaultError('The backup exceeds the size limit.');
        const text = await file.text();
        current();
        return wallet.restore(text, password);
    }, opened);
}

function download(text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `hodl-backup-${new Date().toISOString().slice(0, 10)}.hodl-web.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    announce('Your encrypted backup download has started. Keep it somewhere safe.');
}

document.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-page], [data-action], [data-copy], [data-recover]');
    if (!target || target instanceof HTMLButtonElement && target.disabled) return;
    if (target.dataset.page) navigate(target.dataset.page as Page);
    if (target.dataset.action === 'back') navigate(exists ? 'unlock' : 'home');
    if (target.dataset.action === 'download') void perform(() => wallet.exportBackup(), download);
    if (target.dataset.action === 'refresh-balances') void refreshBalances();
    if (target.dataset.action === 'refresh-history') void refreshHistory();
    if (target.dataset.action === 'confirm-transfer') confirmTransfer();
    if (target.dataset.action === 'cancel-review') navigate(transferReview?.source === 'saved' ? 'home' : 'send');
    if (target.dataset.recover && !busy && !tracking) {
        const transfer = historyRows.find(row => row.requestId === target.dataset.recover)!;
        void perform(() => wallet.reviewSavedTransfer(transfer.network, transfer.requestId!), value => {
            selectedNetwork = value.network;
            balanceRows = [];
            transferReview = value;
            page = 'review';
        });
    }
    if (target.dataset.copy) {
        const account = snapshot?.accounts.find(account => account.family === target.dataset.copy);
        if (account) void Promise.resolve().then(() => navigator.clipboard.writeText(account.address)).then(() => announce('Address copied.'))
            .catch(() => announce('Could not copy. Select the address and copy it manually.', true));
    }
});

document.querySelector('#lock')!.addEventListener('click', () => wallet.lock());

function actions(): Array<{ label: string; run: () => void }> {
    if (snapshot) return [
        { label: 'Open wallet', run: () => navigate('home') },
        { label: 'Send funds', run: () => navigate('send') },
        { label: 'View addresses', run: () => navigate('addresses') },
        { label: 'Save encrypted backup', run: () => navigate('backup') },
        { label: 'Lock wallet', run: () => wallet.lock() }
    ];
    if (exists) return [{ label: 'Unlock wallet', run: () => navigate('unlock') }];
    return [
        { label: 'Create wallet', run: () => navigate('create') },
        { label: 'Import phrase', run: () => navigate('mnemonic') },
        { label: 'Import private key', run: () => navigate('private-key') },
        { label: 'Restore backup', run: () => navigate('restore') }
    ];
}

function showActions(): void {
    const results = document.querySelector('#action-results')!;
    results.replaceChildren();
    const filtered = actions().filter(action => action.label.toLowerCase().includes(search.value.toLowerCase().trim()));
    for (const action of filtered) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button'; button.tabIndex = 0; button.textContent = action.label;
        button.addEventListener('click', () => { closePalette(); action.run(); });
        li.append(button); results.append(li);
    }
    if (!filtered.length) { const li = document.createElement('li'); li.textContent = 'No matching actions.'; results.append(li); }
}

function openPalette(): void {
    if (busy || palette.open) return;
    search.value = '';
    showActions(); palette.showModal(); search.focus();
}

function closePalette(): void { if (palette.open) palette.close(); search.value = ''; }
document.querySelector('#palette-open')!.addEventListener('click', openPalette);
document.querySelector('#palette-close')!.addEventListener('click', closePalette);
search.addEventListener('input', showActions);
palette.addEventListener('close', () => { search.value = ''; });
palette.addEventListener('keydown', event => {
    const buttons = Array.from(palette.querySelectorAll<HTMLButtonElement>('#action-results button'));
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    } else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); buttons[0].click(); }
});

document.querySelector('nav')!.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('nav button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
});

document.addEventListener('keydown', event => {
    const editing = (event.target as Element).closest('input, textarea, select, [contenteditable="true"]');
    if (event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
        event.preventDefault(); openPalette();
    }
    if (event.key === 'Escape' && !palette.open) {
        if (busy) wallet.lock();
        else if (page === 'review') navigate(transferReview?.source === 'saved' ? 'home' : 'send');
        else if (page === 'addresses' || page === 'backup' || page === 'send') navigate('home');
        else if (!exists && page !== 'home') navigate('home');
    }
});

void wallet.exists().then(value => { exists = value; page = exists ? 'unlock' : 'home'; render(); })
    .catch(error => { view.textContent = userMessage(error); announce(userMessage(error), true); });
