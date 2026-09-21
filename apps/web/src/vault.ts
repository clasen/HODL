import { clearSensitiveData, type WalletStore } from 'hodl-wallet/browser';
import { webConfig } from '../config.mjs';
import { VaultError } from './vault-error.js';
import { decrypt, deriveKey, encrypt, newSalt, record, validatePassword, type VaultEnvelope } from './vault-crypto.js';
import { readEnvelope, writeEnvelope } from './vault-database.js';

export type VaultData = Record<string, unknown>;
type Session = { data: VaultData; key: CryptoKey; envelope: VaultEnvelope };

function validateJson(value: unknown, depth = 0): void {
    if (depth > webConfig.vault.maxJsonDepth) throw new VaultError('Invalid vault data.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { value.forEach(item => validateJson(item, depth + 1)); return; }
    if (record(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new VaultError('Invalid vault data.');
            validateJson(item, depth + 1);
        }
        return;
    }
    throw new VaultError('Invalid vault data.');
}

export class BrowserVault implements WalletStore {
    private session?: Session;
    private release?: () => void;
    private busy = false;
    private generation = 0;

    get unlocked(): boolean { return this.session !== undefined; }

    async exists(): Promise<boolean> { return (await readEnvelope()) !== undefined; }

    scope(): { store: WalletStore; check: () => void } {
        const session = this.current();
        const generation = this.generation;
        const check = () => {
            this.assertCurrent(generation);
            if (this.session !== session) throw new VaultError('The wallet session has ended.');
        };
        const read = async (operation: () => Promise<unknown>) => {
            check();
            const value = await operation();
            try { check(); return value; }
            catch (error) { clearSensitiveData(value); throw error; }
        };
        return { check, store: {
            get: (...path) => read(() => this.get(...path)),
            entries: (...path) => read(() => this.entries(...path)),
            set: async (...pathAndValue) => { check(); await this.set(...pathAndValue); check(); },
            flush: async () => { check(); await this.flush(); check(); }
        } };
    }

    private async acquire(): Promise<void> {
        if (!navigator.locks) throw new VaultError('This browser does not support locking the wallet across tabs. Update your browser to continue.');
        await new Promise<void>((resolve, reject) => {
            void navigator.locks.request(webConfig.vault.lock, { mode: 'exclusive', ifAvailable: true }, async lock => {
                if (!lock) { reject(new VaultError('The wallet is open in another tab. Lock it there and try again.')); return; }
                await new Promise<void>(release => { this.release = release; resolve(); });
            }).catch(() => reject(new VaultError('Could not acquire the exclusive wallet lock.')));
        });
    }

    private assertCurrent(generation: number): void {
        if (generation !== this.generation || !this.release) throw new VaultError('The operation was canceled when the wallet was locked.');
    }

    private current(): Session {
        if (!this.session || !this.release) throw new VaultError('The wallet is locked.');
        return this.session;
    }

    private releaseLock(): void { this.release?.(); this.release = undefined; }

    lock(): void {
        this.generation++;
        clearSensitiveData(this.session?.data);
        this.session = undefined;
        if (!this.busy) this.releaseLock();
    }

    async open(password: string, options: {
        create?: () => Promise<VaultData>;
        backup?: VaultEnvelope;
        validate: (data: VaultData) => Promise<void>;
    }): Promise<void> {
        if (this.busy || this.unlocked) throw new VaultError('A wallet operation is already in progress.');
        validatePassword(password, options.create !== undefined);
        this.busy = true;
        const generation = this.generation;
        let data: VaultData | undefined;
        try {
            await this.acquire();
            this.assertCurrent(generation);
            const existing = await readEnvelope();
            this.assertCurrent(generation);
            if ((options.create || options.backup) && existing) throw new VaultError('A wallet already exists in this browser. It was not replaced.');
            let envelope = options.backup ?? existing;
            if (!options.create && !envelope) throw new VaultError('No wallet is saved in this browser.');
            const salt = options.create ? newSalt() : envelope!.kdf.salt;
            const key = await deriveKey(password, salt);
            this.assertCurrent(generation);
            const decoded: unknown = options.create ? await options.create() : await decrypt(envelope!, key);
            if (!record(decoded)) throw new VaultError('Invalid vault data.');
            data = decoded;
            validateJson(data);
            await options.validate(data);
            this.assertCurrent(generation);
            if (options.create) envelope = await encrypt(data, key, salt);
            this.assertCurrent(generation);
            if (options.create || options.backup) await writeEnvelope(envelope!);
            this.assertCurrent(generation);
            this.session = { data, key, envelope: envelope! };
            data = undefined;
        } finally {
            clearSensitiveData(data);
            this.busy = false;
            if (!this.session) this.releaseLock();
        }
    }

    private path(path: unknown[]): asserts path is string[] {
        if (!path.length || path.length > webConfig.vault.maxJsonDepth || path.some(key => typeof key !== 'string' || !key || ['__proto__', 'prototype', 'constructor'].includes(key))) {
            throw new VaultError('Invalid storage path.');
        }
    }

    async get(...path: string[]): Promise<unknown> {
        this.path(path);
        let value: unknown = this.current().data;
        for (const key of path) {
            if (!record(value) || !Object.hasOwn(value, key)) return undefined;
            value = value[key];
        }
        return structuredClone(value);
    }

    async entries(...path: string[]): Promise<unknown> {
        const value = await this.get(...path);
        if (value === undefined) return [];
        if (!record(value)) throw new VaultError('Invalid vault collection.');
        return Object.entries(value);
    }

    async set(...pathAndValue: [...string[], unknown]): Promise<void> {
        if (this.busy) throw new VaultError('The vault is saving another operation.');
        const path: unknown[] = pathAndValue.slice(0, -1);
        this.path(path);
        const value = pathAndValue.at(-1);
        validateJson(value);
        let parent = this.current().data;
        for (const key of path.slice(0, -1)) {
            if (!Object.hasOwn(parent, key)) parent[key] = {};
            if (!record(parent[key])) throw new VaultError('The storage path is not a collection.');
            parent = parent[key] as VaultData;
        }
        parent[path.at(-1)!] = structuredClone(value);
    }

    async flush(): Promise<void> {
        if (this.busy) throw new VaultError('The vault is saving another operation.');
        const session = this.current();
        const generation = this.generation;
        this.busy = true;
        try {
            validateJson(session.data);
            const envelope = await encrypt(session.data, session.key, session.envelope.kdf.salt);
            this.assertCurrent(generation);
            await writeEnvelope(envelope, session.envelope);
            this.assertCurrent(generation);
            session.envelope = envelope;
        } catch (error) {
            if (this.session === session && generation === this.generation) {
                const restored = await decrypt(session.envelope, session.key);
                try {
                    this.assertCurrent(generation);
                    if (!record(restored)) throw new VaultError('Invalid committed vault data.');
                    clearSensitiveData(session.data);
                    session.data = restored;
                } catch (failure) { clearSensitiveData(restored); throw failure; }
            }
            throw error;
        } finally {
            this.busy = false;
            if (!this.session) this.releaseLock();
        }
    }

    async exportBackup(): Promise<string> {
        await this.flush();
        return JSON.stringify(this.current().envelope);
    }
}
