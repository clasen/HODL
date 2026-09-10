import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentError } from './agent-errors.js';
import { NetworkRegistry } from './network-registry.js';
import Persist from './persist.js';
import { ProfileLock } from './profile-lock.js';
import { routeForNetwork } from './swap/routes.js';
import { SwapService } from './swap/service.js';
import type { SwapServiceOptions } from './swap/service.js';
import { TransferService } from './transfer-service.js';
import type {
    AssetBalance,
    BaseNetworkContract,
    NetworkPlugin,
    WalletAccount
} from './network/types.js';

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

type ProfileMetadata = {
    name: string;
    kind: 'mnemonic' | 'private-key';
    families: Array<'evm' | 'bitcoin'>;
    createdAt: string;
};

type WalletServiceOptions = {
    rootDir?: string;
    registry?: NetworkRegistry;
    lockFactory?: (lockPath: string) => ProfileLock;
    swapOptions?: SwapServiceOptions;
};

export type SwapCommand =
    | { action: 'quote'; amount: string; to?: string; network?: string }
    | { action: 'execute'; quoteId: string; requestId: string }
    | { action: 'status' | 'resume'; requestId: string }
    | { action: 'list' }
    | { action: 'destination'; network?: string };

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
    private readonly swapOptions?: SwapServiceOptions;

    constructor(options: WalletServiceOptions = {}) {
        this.rootDir = options.rootDir || path.join(os.homedir(), '.HODL');
        this.registry = options.registry || new NetworkRegistry();
        this.lockFactory = options.lockFactory || (lockPath => new ProfileLock(lockPath));
        this.swapOptions = options.swapOptions;
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
        const location = this.profileLocation(request.wallet);
        this.assertProfileReadable(location.profileDir, request.wallet);
        const lock = this.acquireLock(location.lockPath);
        let db: Persist | null = null;
        try {
            db = new Persist({ path: location.profileDir, encryptionKey: request.password });
            await this.connect(db);
            return await new TransferService(db, plugin, this.instantiate(plugin)).send(request);
        } finally {
            try { await db?.dispose(); }
            finally { this.securePersistFile(location.profileDir); lock.release(); }
        }
    }

    async swap(wallet: string, password: string, command: SwapCommand): Promise<unknown> {
        this.validateProfileName(wallet);
        const location = this.profileLocation(wallet);
        this.assertProfileReadable(location.profileDir, wallet);
        const lock = this.acquireLock(location.lockPath);
        let db: Persist | null = null;
        try {
            db = new Persist({ path: location.profileDir, encryptionKey: password });
            await this.connect(db);
            const route = 'network' in command && command.network !== undefined ? routeForNetwork(command.network) : undefined;
            if ('network' in command && command.network !== undefined && !route) throw new AgentError('INVALID_ARGUMENT', 'Swap source network must be bsc or btc.', 2);
            const swaps = new SwapService(db, { ...this.swapOptions, ...(route ? { routeId: route.id } : {}) });
            switch (command.action) {
                case 'quote': return await swaps.quote(command.amount, command.to);
                case 'execute': return await swaps.execute(command.quoteId, command.requestId);
                case 'resume': return await swaps.resume(command.requestId);
                case 'status': return await swaps.status(command.requestId);
                case 'list': return { swaps: await swaps.list() };
                case 'destination': return { address: await swaps.destination() };
            }
        } catch (error) {
            if (error instanceof AgentError) throw error;
            throw new AgentError('NETWORK_ERROR', error instanceof Error ? error.message : 'Swap provider unavailable.', 4);
        } finally {
            try { await db?.dispose(); }
            finally { this.securePersistFile(location.profileDir); lock.release(); }
        }
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
