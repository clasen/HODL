#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAgentCli } from '../agent-cli.js';
import { formatUnits, normalizeDecimal, parseDecimalToUnits } from '../amounts.js';
import { NetworkRegistry } from '../network-registry.js';
import { ProfileLock } from '../profile-lock.js';
import Persist from '../persist.js';
import { WalletService } from '../wallet-service.js';
import { runCli, selectCliMode } from '../index.js';
import btc from '../network/btc.js';
import eth from '../network/eth.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

class FakeEvmNetwork {
    static prepareCalls = 0;
    static broadcastCalls = 0;
    static failBroadcast = false;
    static status = 'not_found';

    /** @param {any} config */
    constructor(config) {
        this.config = config;
        this.name = config.name;
    }

    /** @param {string} address */
    validateAddress(address) {
        return /^0x[0-9a-fA-F]{40}$/.test(address);
    }

    /** @param {string} mnemonic */
    validateMnemonic(mnemonic) {
        return mnemonic.split(' ').length === 12;
    }

    /** @param {string} mnemonic */
    async accountFromMnemonic(mnemonic) {
        return {
            address: '0x1111111111111111111111111111111111111111',
            privateKey: '0xsecret-evm',
            mnemonic
        };
    }

    async createAccountFromMnemonic() {
        return this.accountFromMnemonic(TEST_MNEMONIC);
    }

    /** @param {string} privateKey */
    validatePrivateKey(privateKey) {
        return privateKey === '0xprivate';
    }

    async privateKeyToAccount() {
        return {
            address: '0x2222222222222222222222222222222222222222',
            privateKey: '0xprivate'
        };
    }

    /** @param {string} _address @param {string} asset */
    async getAssetBalance(_address, asset) {
        return {
            asset,
            amount: '123456789012345678.123456789012345678',
            baseUnits: '123456789012345678123456789012345678',
            decimals: 18
        };
    }

    /** @param {any} from @param {string} to @param {string} amount @param {string} asset */
    async prepareTransfer(from, to, amount, asset) {
        const amountBaseUnits = parseDecimalToUnits(amount, 18).toString();
        FakeEvmNetwork.prepareCalls += 1;
        return {
            from: from.address,
            to,
            asset,
            amount,
            amountBaseUnits,
            fee: {
                asset: 'ETH',
                amount: '0.000021',
                baseUnits: '21000000000000',
                decimals: 18,
                estimated: true
            },
            transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            rawTransaction: '0xsigned-secret'
        };
    }

    /** @param {string} rawTransaction */
    async sendSignedTransaction(rawTransaction) {
        assert.equal(rawTransaction, '0xsigned-secret');
        FakeEvmNetwork.broadcastCalls += 1;
        if (FakeEvmNetwork.failBroadcast) {
            throw new Error('provider timeout');
        }
        return { transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    }

    /** @param {string} transactionHash */
    async getTransactionStatus(transactionHash) {
        return { state: FakeEvmNetwork.status, transactionHash };
    }
}

class FakeBitcoinNetwork {
    /** @param {any} config */
    constructor(config) {
        this.config = config;
        this.name = config.name;
    }

    /** @param {string} mnemonic */
    validateMnemonic(mnemonic) {
        return mnemonic.split(' ').length === 12;
    }

    /** @param {string} mnemonic */
    async accountFromMnemonic(mnemonic) {
        return {
            address: 'bc1qexample0000000000000000000000000000000',
            privateKey: 'btc-secret',
            mnemonic
        };
    }
}

/** @type {any} */
const fakeEvm = {
    id: 'eth',
    family: 'evm',
    chainId: 1,
    name: 'Fake Ethereum',
    url: 'http://not-used.invalid',
    nativeToken: 'ETH',
    explorer: 'https://example.invalid/tx/',
    tokens: {
        USDT: { address: '0x3333333333333333333333333333333333333333' }
    },
    NetworkClass: FakeEvmNetwork
};

/** @type {any} */
const fakeBitcoin = {
    id: 'btc',
    family: 'bitcoin',
    name: 'Fake Bitcoin',
    url: 'http://not-used.invalid',
    nativeToken: 'BTC',
    explorer: 'https://example.invalid/tx/',
    tokens: {},
    NetworkClass: FakeBitcoinNetwork
};

/**
 * @param {WalletService} service
 * @param {string} stdin
 */
function createHarness(service, stdin = '') {
    let stdout = '';
    let stderr = '';
    return {
        io: {
            async readStdin() {
                return stdin;
            },
            /** @param {string} value */
            writeStdout(value) {
                stdout += value;
            },
            /** @param {string} value */
            writeStderr(value) {
                stderr += value;
            }
        },
        output() {
            return { stdout, stderr };
        },
        service
    };
}

/**
 * @param {WalletService} service
 * @param {string[]} argv
 * @param {string} stdin
 */
async function execute(service, argv, stdin = '') {
    const harness = createHarness(service, stdin);
    const exitCode = await runAgentCli(argv, harness);
    const output = harness.output();
    return {
        exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        json: JSON.parse(output.stdout || output.stderr)
    };
}

/** @param {any} result */
function assertSuccess(result) {
    assert.equal(result.exitCode, 0);
    assert.notEqual(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(result.json.ok, true);
}

/** @param {any} result @param {number} exitCode @param {string} code */
function assertFailure(result, exitCode, code) {
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '');
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, code);
}

function testCliEntrypoint() {
    const entrypoint = fileURLToPath(new URL('../index.js', import.meta.url));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-entrypoint-'));
    try {
        const command = path.join(directory, 'hodl');
        const packageLink = path.join(directory, 'package');
        fs.symlinkSync(path.dirname(entrypoint), packageLink, 'dir');
        fs.symlinkSync(path.join(packageLink, 'index.js'), command);
        for (const entry of [entrypoint, path.join(packageLink, 'index.js'), command]) {
            const result = spawnSync(process.execPath, [entry, 'networks'], { encoding: 'utf8' });
            assert.ifError(result.error);
            assert.equal(result.status, 0);
            assert.equal(result.stderr, '');
            assert.notEqual(result.stdout, '', `CLI did not start through ${entry}`);
            const output = JSON.parse(result.stdout);
            assert.equal(output.ok, true);
            assert.equal(output.command, 'networks');
            assert.ok(output.data.networks.length > 0);
        }

        const code = `await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});`;
        for (const args of [['--input-type=module', '--eval', code], ['--input-type=module', '-']]) {
            const result = spawnSync(process.execPath, args, { encoding: 'utf8', input: code });
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, '');
            assert.equal(result.stderr, '');
        }

        const profileDir = path.join(directory, '.HODL');
        fs.mkdirSync(profileDir);
        const lockPath = path.join(profileDir, '.default.lock');
        const owner = `${process.pid}\n`;
        fs.writeFileSync(lockPath, owner, { mode: 0o600 });
        const locked = spawnSync(process.execPath, [entrypoint], {
            encoding: 'utf8',
            env: { ...process.env, HOME: directory },
            timeout: 10000
        });
        assert.ifError(locked.error);
        assert.equal(locked.status, 0);
        const output = locked.stdout + locked.stderr;
        assert.match(output, /HODL is already open in another terminal/);
        assert.match(output, new RegExp(`PID ${process.pid}`));
        assert.doesNotMatch(output, /Password:|Good bye!|Unexpected error/);
        assert.equal(fs.readFileSync(lockPath, 'utf8'), owner);
        assert.equal(fs.existsSync(path.join(profileDir, 'persist.json')), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function testAmounts() {
    assert.equal(selectCliMode([]), 'interactive');
    assert.equal(selectCliMode(['networks']), 'agent');
    let interactiveCalls = 0;
    assert.equal(await runCli([], {
        async runInteractive() {
            interactiveCalls += 1;
        }
    }), 0);
    assert.equal(interactiveCalls, 1);
    assert.equal(parseDecimalToUnits('1.000000000000000001', 18), 1000000000000000001n);
    assert.equal(formatUnits('1000000000000000001', 18), '1.000000000000000001');
    assert.equal(normalizeDecimal('1.2300'), '1.23');
    assert.throws(() => normalizeDecimal('000'), /plain positive decimal/);
    assert.throws(() => parseDecimalToUnits('1e-8', 8), /plain positive decimal/);
    assert.throws(() => parseDecimalToUnits('0', 8), /greater than zero/);
    assert.throws(() => parseDecimalToUnits('0.000000001', 8), /at most 8/);
}

async function testRegistryAndDerivation() {
    const registry = new NetworkRegistry();
    assert.deepEqual(
        registry.list().map(network => network.id),
        ['btc', 'eth', 'bsc', 'pol', 'arb', 'op', 'ftm', 'avax', 'hyperliquid']
    );
    assert.equal(registry.get('arb').nativeToken, 'ETH');
    assert.equal(registry.get('op').nativeToken, 'ETH');
    assert.equal(registry.get('hyperliquid').nativeToken, 'HYPE');

    const evmAccount = await new eth.NetworkClass(eth).accountFromMnemonic(TEST_MNEMONIC);
    const bitcoinAccount = await new btc.NetworkClass(btc).accountFromMnemonic(TEST_MNEMONIC);
    assert.equal(evmAccount.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    assert.equal(bitcoinAccount.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');

    const statusNetwork = /** @type {any} */ (new eth.NetworkClass(eth));
    statusNetwork.web3 = {
        eth: {
            async getTransactionReceipt() {
                return { status: 0n };
            },
            async getTransaction() {
                return null;
            },
            async sendSignedTransaction() {
                return { status: 0n };
            }
        }
    };
    assert.equal((await statusNetwork.getTransactionStatus('0xhash')).state, 'failed');
    await assert.rejects(statusNetwork.sendSignedTransaction('0xraw'), /reverted/);
}

async function testProfilesAndCli() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-agent-'));
    const service = new WalletService({
        rootDir,
        registry: new NetworkRegistry([fakeEvm, fakeBitcoin])
    });

    try {
        let result = await execute(service, ['wallet', 'create', '--wallet', 'bot', '--words', '12'], '{"password":"vault-pass"}');
        assertSuccess(result);
        assert.equal(result.json.command, 'wallet.create');
        assert.equal(JSON.stringify(result.json).includes(TEST_MNEMONIC), false);
        assert.equal(JSON.stringify(result.json).includes('secret'), false);
        assert.equal(fs.statSync(path.join(rootDir, 'profiles', 'bot')).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(rootDir, 'profiles', 'bot', 'persist.json')).mode & 0o777, 0o600);

        result = await execute(service, ['wallet', 'list']);
        assertSuccess(result);
        assert.deepEqual(result.json.data.wallets, ['bot']);

        result = await execute(service, ['wallet', 'address', '--wallet', 'bot', '--network', 'eth'], '{"password":"vault-pass"}');
        assertSuccess(result);
        assert.equal(result.json.data.address, '0x1111111111111111111111111111111111111111');

        result = await execute(service, ['wallet', 'address', '--wallet', 'bot', '--network', 'eth'], '{"password":"wrong"}');
        assertFailure(result, 3, 'WRONG_PASSWORD');

        result = await execute(service, ['wallet', 'create', '--wallet', 'bot', '--words', '12'], '{"password":"vault-pass"}');
        assertFailure(result, 3, 'PROFILE_EXISTS');

        result = await execute(service, ['wallet', 'create', '--wallet', 'revealed', '--words', '12', '--reveal-secrets'], '{"password":"vault-pass"}');
        assertSuccess(result);
        assert.equal(result.json.data.mnemonic, TEST_MNEMONIC);
        assert.equal(result.json.data.accounts[0].privateKey, '0xsecret-evm');

        result = await execute(service, ['wallet', 'import', '--wallet', 'imported', '--type', 'mnemonic'], JSON.stringify({ password: 'vault-pass', mnemonic: TEST_MNEMONIC }));
        assertSuccess(result);
        assert.equal(result.json.data.accounts.length, 2);

        result = await execute(service, ['wallet', 'import', '--wallet', 'keyed', '--type', 'private-key', '--network', 'eth'], JSON.stringify({ password: 'vault-pass', privateKey: '0xprivate' }));
        assertSuccess(result);
        assert.equal(result.json.data.kind, 'private-key');

        result = await execute(service, ['balance', '--network', 'eth', '--address', '0x4444444444444444444444444444444444444444']);
        assertSuccess(result);
        assert.equal(result.json.data.balances[0].amount, '123456789012345678.123456789012345678');
        assert.equal(typeof result.json.data.balances[0].baseUnits, 'string');

        result = await execute(service, ['balance', '--network', 'eth', '--wallet', 'bot'], '{"password":"vault-pass"}');
        assertSuccess(result);
        assert.equal(result.json.data.balances.length, 2);

        result = await execute(service, ['balance', '--network', 'eth', '--wallet', 'bot', '--address', '0x4444444444444444444444444444444444444444'], '{"password":"vault-pass"}');
        assertFailure(result, 2, 'INVALID_ARGUMENT');

        result = await execute(service, ['wallet', 'create', '--wallet', 'bad', '--words', '13'], '{"password":"vault-pass"}');
        assertFailure(result, 2, 'INVALID_ARGUMENT');

        result = await execute(service, ['wallet', 'address', '--wallet', 'bot', '--network', 'eth'], '{bad-json');
        assertFailure(result, 2, 'INVALID_STDIN');

        result = await execute(service, ['wallet', 'address', '--wallet', 'bot', '--network', 'eth', '--password', 'leak'], '{"password":"vault-pass"}');
        assertFailure(result, 2, 'INVALID_ARGUMENT');
        assert.equal(result.stderr.includes('vault-pass'), false);
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
}

async function testSendAndIdempotency() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-send-'));
    const service = new WalletService({
        rootDir,
        registry: new NetworkRegistry([fakeEvm, fakeBitcoin])
    });
    const stdin = '{"password":"vault-pass"}';
    const baseArgs = [
        'send', '--wallet', 'bot', '--network', 'eth',
        '--to', '0x5555555555555555555555555555555555555555',
        '--asset', 'ETH', '--amount', '1.000000000000000001'
    ];

    try {
        await service.createProfile('bot', 'vault-pass', 12, false);
        FakeEvmNetwork.prepareCalls = 0;
        FakeEvmNetwork.broadcastCalls = 0;
        FakeEvmNetwork.failBroadcast = false;
        FakeEvmNetwork.status = 'not_found';

        let result = await execute(service, [...baseArgs, '--dry-run'], stdin);
        assertSuccess(result);
        assert.equal(result.json.data.status, 'dry-run');
        assert.equal(JSON.stringify(result.json).includes('rawTransaction'), false);
        assert.equal(JSON.stringify(result.json).includes('signed-secret'), false);
        assert.equal(FakeEvmNetwork.prepareCalls, 1);
        assert.equal(FakeEvmNetwork.broadcastCalls, 0);

        result = await execute(service, [...baseArgs, '--yes'], stdin);
        assertFailure(result, 2, 'INVALID_ARGUMENT');

        result = await execute(service, [
            ...baseArgs.slice(0, -1),
            '0.0000000000000000001',
            '--dry-run'
        ], stdin);
        assertFailure(result, 2, 'INVALID_ARGUMENT');

        result = await execute(service, [...baseArgs, '--yes', '--request-id', 'payment-1'], stdin);
        assertSuccess(result);
        assert.equal(result.json.data.status, 'confirmed');
        assert.equal(FakeEvmNetwork.prepareCalls, 2);
        assert.equal(FakeEvmNetwork.broadcastCalls, 1);

        result = await execute(service, [...baseArgs, '--yes', '--request-id', 'payment-1'], stdin);
        assertSuccess(result);
        assert.equal(FakeEvmNetwork.prepareCalls, 2);
        assert.equal(FakeEvmNetwork.broadcastCalls, 1);

        result = await execute(service, [
            ...baseArgs.slice(0, -1), '2', '--yes', '--request-id', 'payment-1'
        ], stdin);
        assertFailure(result, 3, 'IDEMPOTENCY_CONFLICT');
        assert.equal(FakeEvmNetwork.prepareCalls, 2);
        assert.equal(FakeEvmNetwork.broadcastCalls, 1);

        FakeEvmNetwork.failBroadcast = true;
        result = await execute(service, [...baseArgs, '--yes', '--request-id', 'payment-unknown'], stdin);
        assertFailure(result, 5, 'BROADCAST_UNKNOWN');
        assert.equal(result.json.error.details.transactionHash.startsWith('0x'), true);
        assert.equal(FakeEvmNetwork.prepareCalls, 3);
        assert.equal(FakeEvmNetwork.broadcastCalls, 2);

        result = await execute(service, [...baseArgs, '--yes', '--request-id', 'payment-blocked'], stdin);
        assertFailure(result, 5, 'BROADCAST_UNKNOWN');
        assert.equal(result.json.error.details.requestId, 'payment-unknown');
        assert.equal(FakeEvmNetwork.prepareCalls, 3);
        assert.equal(FakeEvmNetwork.broadcastCalls, 2);

        result = await execute(service, [...baseArgs, '--yes', '--request-id', 'payment-unknown'], stdin);
        assertFailure(result, 5, 'BROADCAST_UNKNOWN');
        assert.equal(FakeEvmNetwork.prepareCalls, 3);
        assert.equal(FakeEvmNetwork.broadcastCalls, 3);

        FakeEvmNetwork.status = 'failed';
        result = await execute(service, [...baseArgs, '--yes', '--request-id', 'payment-unknown'], stdin);
        assertFailure(result, 5, 'TRANSFER_FAILED');
        assert.equal(FakeEvmNetwork.prepareCalls, 3);
        assert.equal(FakeEvmNetwork.broadcastCalls, 3);

        result = await execute(service, [...baseArgs, '--yes', '--request-id', 'payment-unknown'], stdin);
        assertFailure(result, 5, 'TRANSFER_FAILED');
        assert.equal(FakeEvmNetwork.broadcastCalls, 3);

        const encrypted = fs.readFileSync(path.join(rootDir, 'profiles', 'bot', 'persist.json'), 'utf8');
        assert.equal(encrypted.includes('0xsigned-secret'), false);
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
}

async function testDefaultCompatibilityAndConcurrency() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-default-'));
    const registry = new NetworkRegistry([fakeEvm, fakeBitcoin]);
    const service = new WalletService({ rootDir, registry });
    const password = 'legacy-pass';
    const account = {
        address: '0x1111111111111111111111111111111111111111',
        privateKey: '0xsecret-evm'
    };

    try {
        fs.writeFileSync(
            path.join(rootDir, 'persist.json'),
            Persist.encrypt({ account: { FakeEvmNetwork: account } }, password),
            { mode: 0o600 }
        );
        const beforeList = fs.readFileSync(path.join(rootDir, 'persist.json'), 'utf8');
        assert.deepEqual(service.listProfiles(), ['default']);
        assert.equal(fs.readFileSync(path.join(rootDir, 'persist.json'), 'utf8'), beforeList);

        let result = await execute(
            service,
            ['wallet', 'address', '--wallet', 'default', '--network', 'eth'],
            JSON.stringify({ password })
        );
        assertSuccess(result);
        assert.equal(result.json.data.address, account.address);

        FakeEvmNetwork.prepareCalls = 0;
        FakeEvmNetwork.broadcastCalls = 0;
        FakeEvmNetwork.failBroadcast = false;
        FakeEvmNetwork.status = 'not_found';
        const args = [
            'send', '--wallet', 'default', '--network', 'eth',
            '--to', '0x5555555555555555555555555555555555555555',
            '--asset', 'ETH', '--amount', '1', '--yes'
        ];
        const [first, second] = await Promise.all([
            execute(service, [...args, '--request-id', 'concurrent-1'], JSON.stringify({ password })),
            execute(service, [...args, '--request-id', 'concurrent-2'], JSON.stringify({ password }))
        ]);
        const results = [first, second];
        assert.equal(results.filter(candidate => candidate.exitCode === 0).length, 1);
        assert.equal(
            results.filter(candidate => candidate.json.error?.code === 'PROFILE_LOCKED').length,
            1
        );
        assert.equal(FakeEvmNetwork.prepareCalls, 1);
        assert.equal(FakeEvmNetwork.broadcastCalls, 1);

        const persisted = /** @type {any} */ (Persist.decrypt(
            fs.readFileSync(path.join(rootDir, 'persist.json'), 'utf8'),
            password
        ));
        assert.equal(persisted.account.FakeEvmNetwork.address, account.address);
        assert.equal(Object.keys(persisted.sendRequest).length, 1);
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
}

async function testLocks() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-lock-'));
    const lockPath = path.join(directory, 'profile.lock');
    try {
        fs.writeFileSync(lockPath, '123\n', { mode: 0o600 });
        assert.throws(
            () => new ProfileLock(lockPath, { isProcessAlive: () => true }).acquire(),
            /locked by process/
        );

        const recovered = new ProfileLock(lockPath, {
            isProcessAlive: () => false,
            pid: 456
        });
        recovered.acquire();
        assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), '456');
        assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
        recovered.release();
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

testCliEntrypoint();
await testAmounts();
await testRegistryAndDerivation();
await testProfilesAndCli();
await testSendAndIdempotency();
await testDefaultCompatibilityAndConcurrency();
await testLocks();
console.log('Agent CLI tests passed');
