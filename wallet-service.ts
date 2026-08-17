import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeDecimal } from './amounts.js';
import { AgentError } from './agent-errors.js';
import { NetworkRegistry } from './network-registry.js';
import Persist from './persist.js';
import { ProfileLock } from './profile-lock.js';
import type {
    AssetBalance,
    BaseNetworkContract,
    NetworkPlugin,
    PreparedTransfer,
    TransactionStatus,
    WalletAccount
} from './network/types.js';

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type ProfileMetadata = {
    name: string;
    kind: 'mnemonic' | 'private-key';
    families: Array<'evm' | 'bitcoin'>;
    createdAt: string;
};

type StoredSendRequest = {
    fingerprint: string;
    state: 'prepared' | 'broadcasting' | 'submitted' | 'confirmed' | 'failed' | 'broadcast_unknown';
    network: string;
    from: string;
    to: string;
    asset: string;
    amount: string;
    amountBaseUnits: string;
    fee: PreparedTransfer['fee'];
    transactionHash: string;
    rawTransaction: string;
    createdAt: string;
    updatedAt: string;
};

type WalletServiceOptions = {
    rootDir?: string;
    registry?: NetworkRegistry;
    lockFactory?: (lockPath: string) => ProfileLock;
};

export type CreateProfileResult = {
    wallet: string;
    kind: 'mnemonic' | 'private-key';
    accounts: Array<{
        family: 'evm' | 'bitcoin';
        address: string;
        networks: string[];
        privateKey?: string;
    }>;
    mnemonic?: string;
};

export type SendRequest = {
    wallet: string;
    password: string;
    network: string;
    to: string;
    asset: string;
    amount: string;
    dryRun: boolean;
    requestId?: string;
};

export class WalletService {
    private readonly rootDir: string;
    private readonly registry: NetworkRegistry;
    private readonly lockFactory: (lockPath: string) => ProfileLock;

    constructor(options: WalletServiceOptions = {}) {
        this.rootDir = options.rootDir || path.join(os.homedir(), '.HODL');
        this.registry = options.registry || new NetworkRegistry();
        this.lockFactory = options.lockFactory || (lockPath => new ProfileLock(lockPath));
    }

    listNetworks(): Array<Record<string, unknown>> {
        return this.registry.list().map(network => ({
            id: network.id,
            family: network.family,
            name: network.name,
            chainId: network.chainId ?? null,
            nativeAsset: network.nativeToken,
            tokens: Object.keys(network.tokens),
            explorer: network.explorer
        }));
    }

    listProfiles(): string[] {
        const profiles: string[] = [];
        if (this.isRegularFile(path.join(this.rootDir, 'persist.json'))) {
            profiles.push('default');
        }

        const profilesDir = path.join(this.rootDir, 'profiles');
        if (!this.isDirectory(profilesDir)) {
            return profiles;
        }

        for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !PROFILE_NAME_PATTERN.test(entry.name)) {
                continue;
            }
            if (this.isRegularFile(path.join(profilesDir, entry.name, 'persist.json'))) {
                profiles.push(entry.name);
            }
        }

        return profiles.sort();
    }

    async createProfile(
        wallet: string,
        password: string,
        words: 12 | 24,
        revealSecrets: boolean
    ): Promise<CreateProfileResult> {
        this.validateProfileName(wallet);
        const location = this.prepareMutationLocation(wallet);
        const lock = this.acquireLock(location.lockPath);
        let createdNamedDirectory = false;

        try {
            if (this.profilePathOccupied(wallet, location.profileDir)) {
                throw new AgentError('PROFILE_EXISTS', `Wallet profile ${wallet} already exists.`, 3);
            }

            if (wallet !== 'default') {
                fs.mkdirSync(location.profileDir, { mode: 0o700 });
                createdNamedDirectory = true;
            }

            const evmPlugin = this.registry.firstForFamily('evm');
            const bitcoinPlugin = this.registry.firstForFamily('bitcoin');
            const evmNetwork = this.instantiate(evmPlugin);
            const bitcoinNetwork = this.instantiate(bitcoinPlugin);
            const evmAccount = await evmNetwork.createAccountFromMnemonic(words);
            if (!evmAccount.mnemonic) {
                throw new Error('Mnemonic generation did not return a mnemonic.');
            }
            const bitcoinAccount = await bitcoinNetwork.accountFromMnemonic(evmAccount.mnemonic);
            const mnemonic = evmAccount.mnemonic;

            await this.writeNewProfile(location.profileDir, password, {
                name: wallet,
                kind: 'mnemonic',
                families: ['evm', 'bitcoin'],
                createdAt: new Date().toISOString()
            }, [
                [evmPlugin.NetworkClass.name, evmAccount],
                [bitcoinPlugin.NetworkClass.name, bitcoinAccount]
            ], mnemonic);

            const result: CreateProfileResult = {
                wallet,
                kind: 'mnemonic',
                accounts: [
                    {
                        family: 'evm',
                        address: evmAccount.address,
                        networks: this.networkIdsForFamily('evm'),
                        ...(revealSecrets ? { privateKey: evmAccount.privateKey } : {})
                    },
                    {
                        family: 'bitcoin',
                        address: bitcoinAccount.address,
                        networks: this.networkIdsForFamily('bitcoin'),
                        ...(revealSecrets ? { privateKey: bitcoinAccount.privateKey } : {})
                    }
                ],
                ...(revealSecrets ? { mnemonic } : {})
            };

            Persist.clearSensitiveData(evmAccount);
            Persist.clearSensitiveData(bitcoinAccount);
            return result;
        } catch (error) {
            if (createdNamedDirectory && !this.isRegularFile(path.join(location.profileDir, 'persist.json'))) {
                fs.rmSync(location.profileDir, { recursive: true, force: true });
            }
            throw error;
        } finally {
            lock.release();
        }
    }

    async importMnemonic(wallet: string, password: string, mnemonic: string): Promise<CreateProfileResult> {
        this.validateProfileName(wallet);
        const location = this.prepareMutationLocation(wallet);
        const lock = this.acquireLock(location.lockPath);
        let createdNamedDirectory = false;

        try {
            if (this.profilePathOccupied(wallet, location.profileDir)) {
                throw new AgentError('PROFILE_EXISTS', `Wallet profile ${wallet} already exists.`, 3);
            }

            const evmPlugin = this.registry.firstForFamily('evm');
            const bitcoinPlugin = this.registry.firstForFamily('bitcoin');
            const evmNetwork = this.instantiate(evmPlugin);
            if (!evmNetwork.validateMnemonic(mnemonic)) {
                throw new AgentError('INVALID_STDIN', 'Invalid mnemonic.', 2);
            }
            const bitcoinNetwork = this.instantiate(bitcoinPlugin);
            const evmAccount = await evmNetwork.accountFromMnemonic(mnemonic);
            const bitcoinAccount = await bitcoinNetwork.accountFromMnemonic(mnemonic);

            if (wallet !== 'default') {
                fs.mkdirSync(location.profileDir, { mode: 0o700 });
                createdNamedDirectory = true;
            }

            await this.writeNewProfile(location.profileDir, password, {
                name: wallet,
                kind: 'mnemonic',
                families: ['evm', 'bitcoin'],
                createdAt: new Date().toISOString()
            }, [
                [evmPlugin.NetworkClass.name, evmAccount],
                [bitcoinPlugin.NetworkClass.name, bitcoinAccount]
            ], mnemonic);

            const result: CreateProfileResult = {
                wallet,
                kind: 'mnemonic',
                accounts: [
                    {
                        family: 'evm',
                        address: evmAccount.address,
                        networks: this.networkIdsForFamily('evm')
                    },
                    {
                        family: 'bitcoin',
                        address: bitcoinAccount.address,
                        networks: this.networkIdsForFamily('bitcoin')
                    }
                ]
            };
            Persist.clearSensitiveData(evmAccount);
            Persist.clearSensitiveData(bitcoinAccount);
            return result;
        } catch (error) {
            if (createdNamedDirectory && !this.isRegularFile(path.join(location.profileDir, 'persist.json'))) {
                fs.rmSync(location.profileDir, { recursive: true, force: true });
            }
            throw error;
        } finally {
            lock.release();
        }
    }

    async importPrivateKey(
        wallet: string,
        password: string,
        networkId: string,
        privateKey: string
    ): Promise<CreateProfileResult> {
        this.validateProfileName(wallet);
        const plugin = this.getPlugin(networkId);
        const network = this.instantiate(plugin);
        if (!network.validatePrivateKey(privateKey)) {
            throw new AgentError('INVALID_STDIN', `Invalid private key for ${networkId}.`, 2);
        }

        const location = this.prepareMutationLocation(wallet);
        const lock = this.acquireLock(location.lockPath);
        let createdNamedDirectory = false;
        try {
            if (this.profilePathOccupied(wallet, location.profileDir)) {
                throw new AgentError('PROFILE_EXISTS', `Wallet profile ${wallet} already exists.`, 3);
            }

            const account = await network.privateKeyToAccount(privateKey);
            if (wallet !== 'default') {
                fs.mkdirSync(location.profileDir, { mode: 0o700 });
                createdNamedDirectory = true;
            }

            await this.writeNewProfile(location.profileDir, password, {
                name: wallet,
                kind: 'private-key',
                families: [plugin.family],
                createdAt: new Date().toISOString()
            }, [[plugin.NetworkClass.name, account]]);

            const result: CreateProfileResult = {
                wallet,
                kind: 'private-key',
                accounts: [{
                    family: plugin.family,
                    address: account.address,
                    networks: this.networkIdsForFamily(plugin.family)
                }]
            };
            Persist.clearSensitiveData(account);
            return result;
        } catch (error) {
            if (createdNamedDirectory && !this.isRegularFile(path.join(location.profileDir, 'persist.json'))) {
                fs.rmSync(location.profileDir, { recursive: true, force: true });
            }
            throw error;
        } finally {
            lock.release();
        }
    }

    async getAddress(wallet: string, password: string, networkId: string): Promise<Record<string, unknown>> {
        const plugin = this.getPlugin(networkId);
        const account = await this.readAccount(wallet, password, plugin);
        try {
            return {
                wallet,
                network: networkId,
                family: plugin.family,
                address: account.address
            };
        } finally {
            Persist.clearSensitiveData(account);
        }
    }

    async getBalances(options: {
        network: string;
        wallet?: string;
        password?: string;
        address?: string;
        asset?: string;
    }): Promise<Record<string, unknown>> {
        const plugin = this.getPlugin(options.network);
        const network = this.instantiate(plugin);
        let address = options.address;

        if (options.wallet) {
            const account = await this.readAccount(options.wallet, options.password || '', plugin);
            address = account.address;
            Persist.clearSensitiveData(account);
        }
        if (!address || !network.validateAddress(address)) {
            throw new AgentError('INVALID_ARGUMENT', 'Invalid address for selected network.', 2);
        }

        const assets = options.asset
            ? [this.validateAsset(plugin, options.asset)]
            : [plugin.nativeToken, ...Object.keys(plugin.tokens)];

        try {
            const balances = await Promise.all(
                assets.map(asset => network.getAssetBalance(address as string, asset))
            );
            return {
                network: plugin.id,
                address,
                balances
            };
        } catch {
            throw new AgentError('NETWORK_ERROR', 'Failed to retrieve balance from network provider.', 4);
        }
    }

    async send(request: SendRequest): Promise<Record<string, unknown>> {
        this.validateProfileName(request.wallet);
        const plugin = this.getPlugin(request.network);
        const asset = this.validateAsset(plugin, request.asset);
        let normalizedAmount: string;
        try {
            normalizedAmount = normalizeDecimal(request.amount);
        } catch (error) {
            throw new AgentError('INVALID_ARGUMENT', (error as Error).message, 2);
        }

        if (request.dryRun) {
            const account = await this.readAccount(request.wallet, request.password, plugin);
            try {
                const prepared = await this.prepare(networkFrom(plugin), account, request.to, normalizedAmount, asset);
                const preview = this.publicTransfer(prepared, plugin.id, 'dry-run');
                prepared.rawTransaction = '';
                return preview;
            } finally {
                Persist.clearSensitiveData(account);
            }
        }

        if (!request.requestId || !REQUEST_ID_PATTERN.test(request.requestId)) {
            throw new AgentError('INVALID_ARGUMENT', 'A valid request ID is required.', 2);
        }

        const location = this.profileLocation(request.wallet);
        this.assertProfileReadable(location.profileDir, request.wallet);
        const lock = this.acquireLock(location.lockPath);
        let db: Persist | null = null;
        let account: WalletAccount | null = null;
        let stored: StoredSendRequest | null = null;

        try {
            db = new Persist({ path: location.profileDir, encryptionKey: request.password });
            await this.connect(db);
            account = await db.get('account', plugin.NetworkClass.name) ?? null;
            if (!account) {
                throw new AgentError(
                    'ACCOUNT_NOT_FOUND',
                    `Wallet profile has no ${plugin.family} account.`,
                    3
                );
            }

            const fingerprint = this.fingerprint({
                wallet: request.wallet,
                network: plugin.id,
                chainId: plugin.chainId ?? null,
                from: plugin.family === 'evm' ? account.address.toLowerCase() : account.address,
                to: plugin.family === 'evm' ? request.to.toLowerCase() : request.to,
                asset,
                amount: normalizedAmount
            });
            stored = await db.get('sendRequest', request.requestId) ?? null;
            if (stored && stored.fingerprint !== fingerprint) {
                throw new AgentError(
                    'IDEMPOTENCY_CONFLICT',
                    'Request ID was already used with different transfer parameters.',
                    3
                );
            }

            if (stored && (stored.state === 'confirmed' || stored.state === 'submitted')) {
                return this.publicStoredTransfer(stored, request.requestId);
            }
            if (stored?.state === 'failed') {
                throw new AgentError(
                    'TRANSFER_FAILED',
                    'The transaction was mined but reverted.',
                    5,
                    { transactionHash: stored.transactionHash, requestId: request.requestId }
                );
            }

            if (!stored) {
                const pendingRequests = await db.entries('sendRequest') as Array<[
                    string,
                    StoredSendRequest
                ]> || [];
                const unresolved = pendingRequests.find(([otherRequestId, candidate]) =>
                    otherRequestId !== request.requestId &&
                    candidate.network === plugin.id &&
                    (
                        candidate.state === 'prepared' ||
                        candidate.state === 'broadcasting' ||
                        candidate.state === 'broadcast_unknown'
                    )
                );
                if (unresolved) {
                    throw new AgentError(
                        'BROADCAST_UNKNOWN',
                        'Another transfer on this network has unresolved broadcast state.',
                        5,
                        {
                            requestId: unresolved[0],
                            transactionHash: unresolved[1].transactionHash
                        }
                    );
                }

                const prepared = await this.prepare(
                    this.instantiate(plugin),
                    account,
                    request.to,
                    normalizedAmount,
                    asset
                );
                const now = new Date().toISOString();
                stored = {
                    fingerprint,
                    state: 'prepared',
                    network: plugin.id,
                    from: prepared.from,
                    to: prepared.to,
                    asset: prepared.asset,
                    amount: prepared.amount,
                    amountBaseUnits: prepared.amountBaseUnits,
                    fee: prepared.fee,
                    transactionHash: prepared.transactionHash,
                    rawTransaction: prepared.rawTransaction,
                    createdAt: now,
                    updatedAt: now
                };
                await db.set('sendRequest', request.requestId, stored);
                this.securePersistFile(location.profileDir);
            }

            stored.state = 'broadcasting';
            stored.updatedAt = new Date().toISOString();
            await db.set('sendRequest', request.requestId, stored);
            this.securePersistFile(location.profileDir);

            return await this.broadcastStored(
                db,
                location.profileDir,
                this.instantiate(plugin),
                request.requestId,
                stored,
                plugin
            );
        } finally {
            Persist.clearSensitiveData(account);
            Persist.clearSensitiveData(stored);
            try {
                await db?.dispose();
            } finally {
                this.securePersistFile(location.profileDir);
                lock.release();
            }
        }
    }

    private async broadcastStored(
        db: Persist,
        profileDir: string,
        network: BaseNetworkContract,
        requestId: string,
        stored: StoredSendRequest,
        plugin: NetworkPlugin
    ): Promise<Record<string, unknown>> {
        try {
            await network.sendSignedTransaction(stored.rawTransaction);
            stored.state = plugin.family === 'bitcoin' ? 'submitted' : 'confirmed';
            stored.updatedAt = new Date().toISOString();
            await db.set('sendRequest', requestId, stored);
            this.securePersistFile(profileDir);
            return this.publicStoredTransfer(stored, requestId);
        } catch {
            const status = await this.safeTransactionStatus(network, stored.transactionHash);
            if (status.state === 'failed') {
                stored.state = 'failed';
                stored.updatedAt = new Date().toISOString();
                await db.set('sendRequest', requestId, stored);
                this.securePersistFile(profileDir);
                throw new AgentError(
                    'TRANSFER_FAILED',
                    'The transaction was mined but reverted.',
                    5,
                    { transactionHash: stored.transactionHash, requestId }
                );
            }
            if (status.state !== 'not_found') {
                stored.state = status.state;
                stored.updatedAt = new Date().toISOString();
                await db.set('sendRequest', requestId, stored);
                this.securePersistFile(profileDir);
                return this.publicStoredTransfer(stored, requestId);
            }

            stored.state = 'broadcast_unknown';
            stored.updatedAt = new Date().toISOString();
            await db.set('sendRequest', requestId, stored);
            this.securePersistFile(profileDir);
            throw new AgentError(
                'BROADCAST_UNKNOWN',
                'The provider did not confirm whether the signed transaction was accepted.',
                5,
                { transactionHash: stored.transactionHash, requestId }
            );
        }
    }

    private async safeTransactionStatus(
        network: BaseNetworkContract,
        transactionHash: string
    ): Promise<TransactionStatus> {
        try {
            return await network.getTransactionStatus(transactionHash);
        } catch {
            return { state: 'not_found', transactionHash };
        }
    }

    private async prepare(
        network: BaseNetworkContract,
        account: WalletAccount,
        to: string,
        amount: string,
        asset: string
    ): Promise<PreparedTransfer> {
        if (!network.validateAddress(to)) {
            throw new AgentError('INVALID_ARGUMENT', 'Invalid recipient address.', 2);
        }
        try {
            return await network.prepareTransfer(account, to, amount, asset);
        } catch (error) {
            if (error instanceof TypeError) {
                throw new AgentError('INVALID_ARGUMENT', error.message, 2);
            }
            throw new AgentError('TRANSFER_FAILED', (error as Error).message, 5);
        }
    }

    private publicTransfer(
        prepared: PreparedTransfer,
        network: string,
        status: string
    ): Record<string, unknown> {
        return {
            status,
            network,
            from: prepared.from,
            to: prepared.to,
            asset: prepared.asset,
            amount: prepared.amount,
            amountBaseUnits: prepared.amountBaseUnits,
            fee: prepared.fee,
            transactionHash: prepared.transactionHash
        };
    }

    private publicStoredTransfer(stored: StoredSendRequest, requestId: string): Record<string, unknown> {
        return {
            requestId,
            status: stored.state,
            network: stored.network,
            from: stored.from,
            to: stored.to,
            asset: stored.asset,
            amount: stored.amount,
            amountBaseUnits: stored.amountBaseUnits,
            fee: stored.fee,
            transactionHash: stored.transactionHash
        };
    }

    private async readAccount(
        wallet: string,
        password: string,
        plugin: NetworkPlugin
    ): Promise<WalletAccount> {
        this.validateProfileName(wallet);
        const location = this.profileLocation(wallet);
        this.assertProfileReadable(location.profileDir, wallet);
        const lock = this.acquireLock(location.lockPath);
        let db: Persist | null = null;
        try {
            db = new Persist({ path: location.profileDir, encryptionKey: password });
            await this.connect(db);
            const account = await db.get('account', plugin.NetworkClass.name) ?? null;
            if (!account) {
                throw new AgentError(
                    'ACCOUNT_NOT_FOUND',
                    `Wallet profile has no ${plugin.family} account.`,
                    3
                );
            }
            return account;
        } finally {
            try {
                await db?.dispose();
            } finally {
                this.securePersistFile(location.profileDir);
                lock.release();
            }
        }
    }

    private async writeNewProfile(
        profileDir: string,
        password: string,
        metadata: ProfileMetadata,
        accounts: Array<[string, WalletAccount]>,
        mnemonic?: string
    ): Promise<void> {
        fs.chmodSync(profileDir, 0o700);
        const db = new Persist({ path: profileDir, encryptionKey: password });
        try {
            await db.connect();
            await db.set('profile', metadata);
            for (const [familyKey, account] of accounts) {
                await db.set('account', familyKey, account);
            }
            if (mnemonic) {
                await db.set('mnemonic', mnemonic);
            }
        } finally {
            await db.dispose();
        }
        this.securePersistFile(profileDir);
    }

    private async connect(db: Persist): Promise<void> {
        try {
            await db.connect();
        } catch {
            throw new AgentError('WRONG_PASSWORD', 'Unable to unlock wallet profile.', 3);
        }
    }

    private profileExists(wallet: string): boolean {
        return this.isRegularFile(path.join(this.profileLocation(wallet).profileDir, 'persist.json'));
    }

    private profilePathOccupied(wallet: string, profileDir: string): boolean {
        return this.profileExists(wallet) || (wallet !== 'default' && fs.existsSync(profileDir));
    }

    private profileLocation(wallet: string): { profileDir: string; lockPath: string } {
        if (wallet === 'default') {
            return {
                profileDir: this.rootDir,
                lockPath: path.join(this.rootDir, '.default.lock')
            };
        }
        const profilesDir = path.join(this.rootDir, 'profiles');
        return {
            profileDir: path.join(profilesDir, wallet),
            lockPath: path.join(profilesDir, `.${wallet}.lock`)
        };
    }

    private prepareMutationLocation(wallet: string): { profileDir: string; lockPath: string } {
        const location = this.profileLocation(wallet);
        this.ensureSafeDirectory(this.rootDir, wallet === 'default');
        if (wallet !== 'default') {
            const profilesDir = path.dirname(location.profileDir);
            this.ensureSafeDirectory(profilesDir, true);
            if (fs.existsSync(location.profileDir) && fs.lstatSync(location.profileDir).isSymbolicLink()) {
                throw new AgentError('INVALID_ARGUMENT', 'Wallet profile cannot be a symbolic link.', 2);
            }
        }
        return location;
    }

    private ensureSafeDirectory(target: string, secureExisting: boolean): void {
        if (fs.existsSync(target)) {
            const stats = fs.lstatSync(target);
            if (!stats.isDirectory() || stats.isSymbolicLink()) {
                throw new AgentError('INVALID_ARGUMENT', 'Wallet storage path is not a safe directory.', 2);
            }
            if (secureExisting) {
                fs.chmodSync(target, 0o700);
            }
            return;
        }

        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    }

    private assertProfileReadable(profileDir: string, wallet: string): void {
        if (!this.isDirectory(profileDir) || !this.isRegularFile(path.join(profileDir, 'persist.json'))) {
            throw new AgentError('PROFILE_NOT_FOUND', `Wallet profile ${wallet} was not found.`, 3);
        }
        if (fs.lstatSync(profileDir).isSymbolicLink()) {
            throw new AgentError('INVALID_ARGUMENT', 'Wallet profile cannot be a symbolic link.', 2);
        }
    }

    private acquireLock(lockPath: string): ProfileLock {
        const lock = this.lockFactory(lockPath);
        try {
            lock.acquire();
            return lock;
        } catch {
            throw new AgentError('PROFILE_LOCKED', 'Wallet profile is locked by another process.', 3);
        }
    }

    private getPlugin(id: string): NetworkPlugin {
        try {
            return this.registry.get(id);
        } catch {
            throw new AgentError('INVALID_ARGUMENT', `Unsupported network: ${id}.`, 2);
        }
    }

    private instantiate(plugin: NetworkPlugin): BaseNetworkContract {
        return new plugin.NetworkClass(plugin);
    }

    private validateAsset(plugin: NetworkPlugin, asset: string): string {
        const symbol = asset.toUpperCase();
        if (symbol !== plugin.nativeToken && !plugin.tokens[symbol]) {
            throw new AgentError(
                'INVALID_ARGUMENT',
                `Asset ${symbol} is not configured for ${plugin.id}.`,
                2
            );
        }
        return symbol;
    }

    private validateProfileName(wallet: string): void {
        if (wallet !== 'default' && !PROFILE_NAME_PATTERN.test(wallet)) {
            throw new AgentError(
                'INVALID_ARGUMENT',
                'Wallet name must match ^[a-z0-9][a-z0-9_-]{0,31}$.',
                2
            );
        }
    }

    private networkIdsForFamily(family: 'evm' | 'bitcoin'): string[] {
        return this.registry.list()
            .filter(network => network.family === family)
            .map(network => network.id);
    }

    private fingerprint(value: Record<string, unknown>): string {
        return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    }

    private securePersistFile(profileDir: string): void {
        const persistPath = path.join(profileDir, 'persist.json');
        if (fs.existsSync(persistPath)) {
            fs.chmodSync(persistPath, 0o600);
        }
    }

    private isRegularFile(target: string): boolean {
        try {
            return fs.lstatSync(target).isFile();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }

    private isDirectory(target: string): boolean {
        try {
            const stats = fs.lstatSync(target);
            return stats.isDirectory() && !stats.isSymbolicLink();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }
}

function networkFrom(plugin: NetworkPlugin): BaseNetworkContract {
    return new plugin.NetworkClass(plugin);
}
