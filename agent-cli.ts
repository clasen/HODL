import { parseArgs } from 'node:util';
import { AgentError } from './agent-errors.js';
import { WalletService } from './wallet-service.js';

type SecretInput = Record<string, string>;

export type AgentCliIO = {
    readStdin(): Promise<string>;
    writeStdout(value: string): void;
    writeStderr(value: string): void;
};

export type AgentCliOptions = {
    service?: WalletService;
    io?: AgentCliIO;
};

const defaultIO: AgentCliIO = {
    async readStdin(): Promise<string> {
        if (process.stdin.isTTY) {
            throw new AgentError('STDIN_REQUIRED', 'A JSON object is required on stdin.', 2);
        }

        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const input = Buffer.concat(chunks);
        try {
            return input.toString('utf8');
        } finally {
            input.fill(0);
            chunks.forEach(chunk => chunk.fill(0));
        }
    },
    writeStdout(value: string): void {
        process.stdout.write(value);
    },
    writeStderr(value: string): void {
        process.stderr.write(value);
    }
};

export async function runAgentCli(argv: string[], options: AgentCliOptions = {}): Promise<number> {
    const service = options.service || new WalletService();
    const io = options.io || defaultIO;
    let command = argv.slice(0, 2).join('.');

    try {
        const result = await execute(argv, service, io, value => {
            command = value;
        });
        io.writeStdout(`${JSON.stringify({
            version: 1,
            ok: true,
            command,
            data: result
        })}\n`);
        return 0;
    } catch (error) {
        const agentError = error instanceof AgentError
            ? error
            : new AgentError('INTERNAL_ERROR', 'Unexpected internal error.', 5);
        io.writeStderr(`${JSON.stringify({
            version: 1,
            ok: false,
            error: {
                code: agentError.code,
                message: agentError.message,
                ...(agentError.details ? { details: agentError.details } : {})
            }
        })}\n`);
        return agentError.exitCode;
    }
}

async function execute(
    argv: string[],
    service: WalletService,
    io: AgentCliIO,
    setCommand: (command: string) => void
): Promise<unknown> {
    if (argv[0] === 'networks') {
        setCommand('networks');
        requireNoArguments(argv.slice(1));
        return { networks: service.listNetworks() };
    }

    if (argv[0] === 'wallet') {
        return executeWallet(argv.slice(1), service, io, setCommand);
    }

    if (argv[0] === 'balance') {
        setCommand('balance');
        const values = parseOptions(argv.slice(1), {
            network: { type: 'string' },
            wallet: { type: 'string' },
            address: { type: 'string' },
            asset: { type: 'string' }
        });
        const network = requiredString(values, 'network');
        const wallet = optionalString(values, 'wallet');
        const address = optionalString(values, 'address');
        if ((wallet ? 1 : 0) + (address ? 1 : 0) !== 1) {
            throw new AgentError(
                'INVALID_ARGUMENT',
                'Balance requires exactly one of --wallet or --address.',
                2
            );
        }

        let input: SecretInput | undefined;
        try {
            input = wallet ? await readSecretInput(io, ['password'], ['password']) : undefined;
            return await service.getBalances({
                network,
                wallet,
                password: input?.password,
                address,
                asset: optionalString(values, 'asset')
            });
        } finally {
            clearSecrets(input);
        }
    }

    if (argv[0] === 'send') {
        setCommand('send');
        const values = parseOptions(argv.slice(1), {
            wallet: { type: 'string' },
            network: { type: 'string' },
            to: { type: 'string' },
            asset: { type: 'string' },
            amount: { type: 'string' },
            'dry-run': { type: 'boolean' },
            yes: { type: 'boolean' },
            'request-id': { type: 'string' }
        });
        const dryRun = values['dry-run'] === true;
        const yes = values.yes === true;
        const requestId = optionalString(values, 'request-id');
        if (dryRun === yes) {
            throw new AgentError(
                'INVALID_ARGUMENT',
                'Send requires either --dry-run or --yes, but not both.',
                2
            );
        }
        if ((dryRun && requestId) || (yes && !requestId)) {
            throw new AgentError(
                'INVALID_ARGUMENT',
                '--request-id is required with --yes and forbidden with --dry-run.',
                2
            );
        }

        let input: SecretInput | undefined;
        try {
            input = await readSecretInput(io, ['password'], ['password']);
            return await service.send({
                wallet: requiredString(values, 'wallet'),
                password: input.password,
                network: requiredString(values, 'network'),
                to: requiredString(values, 'to'),
                asset: requiredString(values, 'asset'),
                amount: requiredString(values, 'amount'),
                dryRun,
                requestId
            });
        } finally {
            clearSecrets(input);
        }
    }

    throw new AgentError('INVALID_ARGUMENT', `Unknown command: ${argv[0] || ''}.`, 2);
}

async function executeWallet(
    argv: string[],
    service: WalletService,
    io: AgentCliIO,
    setCommand: (command: string) => void
): Promise<unknown> {
    const action = argv[0];
    setCommand(`wallet.${action || ''}`);

    if (action === 'list') {
        requireNoArguments(argv.slice(1));
        return { wallets: service.listProfiles() };
    }

    if (action === 'create') {
        const values = parseOptions(argv.slice(1), {
            wallet: { type: 'string' },
            words: { type: 'string' },
            'reveal-secrets': { type: 'boolean' }
        });
        const wordsValue = requiredString(values, 'words');
        if (wordsValue !== '12' && wordsValue !== '24') {
            throw new AgentError('INVALID_ARGUMENT', '--words must be 12 or 24.', 2);
        }

        let input: SecretInput | undefined;
        try {
            input = await readSecretInput(io, ['password'], ['password']);
            return await service.createProfile(
                requiredString(values, 'wallet'),
                input.password,
                Number(wordsValue) as 12 | 24,
                values['reveal-secrets'] === true
            );
        } finally {
            clearSecrets(input);
        }
    }

    if (action === 'import') {
        const values = parseOptions(argv.slice(1), {
            wallet: { type: 'string' },
            type: { type: 'string' },
            network: { type: 'string' }
        });
        const wallet = requiredString(values, 'wallet');
        const type = requiredString(values, 'type');
        const network = optionalString(values, 'network');

        if (type === 'mnemonic') {
            if (network) {
                throw new AgentError(
                    'INVALID_ARGUMENT',
                    '--network is forbidden for mnemonic import.',
                    2
                );
            }
            let input: SecretInput | undefined;
            try {
                input = await readSecretInput(
                    io,
                    ['password', 'mnemonic'],
                    ['password', 'mnemonic']
                );
                return await service.importMnemonic(wallet, input.password, input.mnemonic);
            } finally {
                clearSecrets(input);
            }
        }

        if (type === 'private-key') {
            if (!network) {
                throw new AgentError(
                    'INVALID_ARGUMENT',
                    '--network is required for private-key import.',
                    2
                );
            }
            let input: SecretInput | undefined;
            try {
                input = await readSecretInput(
                    io,
                    ['password', 'privateKey'],
                    ['password', 'privateKey']
                );
                return await service.importPrivateKey(
                    wallet,
                    input.password,
                    network,
                    input.privateKey
                );
            } finally {
                clearSecrets(input);
            }
        }

        throw new AgentError(
            'INVALID_ARGUMENT',
            '--type must be mnemonic or private-key.',
            2
        );
    }

    if (action === 'address') {
        const values = parseOptions(argv.slice(1), {
            wallet: { type: 'string' },
            network: { type: 'string' }
        });
        let input: SecretInput | undefined;
        try {
            input = await readSecretInput(io, ['password'], ['password']);
            return await service.getAddress(
                requiredString(values, 'wallet'),
                input.password,
                requiredString(values, 'network')
            );
        } finally {
            clearSecrets(input);
        }
    }

    throw new AgentError('INVALID_ARGUMENT', `Unknown wallet command: ${action || ''}.`, 2);
}

type OptionDefinition = Record<string, { type: 'string' | 'boolean' }>;

function parseOptions(args: string[], options: OptionDefinition): Record<string, unknown> {
    ensureNoDuplicateOptions(args);
    try {
        const parsed = parseArgs({
            args,
            options,
            strict: true,
            allowPositionals: false
        });
        return parsed.values;
    } catch (error) {
        throw new AgentError('INVALID_ARGUMENT', (error as Error).message, 2);
    }
}

function ensureNoDuplicateOptions(args: string[]): void {
    const seen = new Set<string>();
    for (const argument of args) {
        if (!argument.startsWith('--')) {
            continue;
        }
        const name = argument.slice(2).split('=', 1)[0];
        if (seen.has(name)) {
            throw new AgentError('INVALID_ARGUMENT', `Option --${name} was provided more than once.`, 2);
        }
        seen.add(name);
    }
}

function requireNoArguments(args: string[]): void {
    if (args.length > 0) {
        throw new AgentError('INVALID_ARGUMENT', 'Command does not accept arguments.', 2);
    }
}

function requiredString(values: Record<string, unknown>, name: string): string {
    const value = optionalString(values, name);
    if (!value) {
        throw new AgentError('INVALID_ARGUMENT', `--${name} is required.`, 2);
    }
    return value;
}

function optionalString(values: Record<string, unknown>, name: string): string | undefined {
    const value = values[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function readSecretInput(
    io: AgentCliIO,
    allowedKeys: string[],
    requiredKeys: string[]
): Promise<SecretInput> {
    const raw = await io.readStdin();
    if (!raw.trim()) {
        throw new AgentError('STDIN_REQUIRED', 'A JSON object is required on stdin.', 2);
    }

    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new AgentError('INVALID_STDIN', 'stdin must contain one valid JSON object.', 2);
    }
    if (!isRecord(value)) {
        throw new AgentError('INVALID_STDIN', 'stdin must contain a JSON object.', 2);
    }

    const unknownKeys = Object.keys(value).filter(key => !allowedKeys.includes(key));
    if (unknownKeys.length > 0) {
        throw new AgentError(
            'INVALID_STDIN',
            `Unknown stdin fields: ${unknownKeys.join(', ')}.`,
            2
        );
    }

    const result: SecretInput = {};
    for (const key of allowedKeys) {
        const field = value[key];
        if (field !== undefined && (typeof field !== 'string' || field.length === 0)) {
            throw new AgentError('INVALID_STDIN', `${key} must be a non-empty string.`, 2);
        }
        if (typeof field === 'string') {
            result[key] = field;
        }
    }
    for (const key of requiredKeys) {
        if (!result[key]) {
            throw new AgentError('INVALID_STDIN', `${key} is required on stdin.`, 2);
        }
    }
    return result;
}

function clearSecrets(input: SecretInput | undefined): void {
    if (!input) {
        return;
    }
    for (const key of Object.keys(input)) {
        input[key] = '';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
