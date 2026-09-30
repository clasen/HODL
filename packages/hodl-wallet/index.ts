#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { ProfileLock, ProfileLockedError } from './profile-lock.js';
import { fileURLToPath } from 'url';
import os from 'os';
import { NodeSession } from './node-session.js';
import { InquirerUi } from './ui-inquirer.js';
import { errorMessage } from './app/format.js';
import { farewell, showError, welcome } from './app/output.js';
import { runWallet } from './app/menu.js';

const __filename = fileURLToPath(import.meta.url);
const ui = new InquirerUi();

function suppressPunycodeDeprecationWarning(): void {
    const warningListeners = process.rawListeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', warning => {
        if ((warning as Error & { code?: string }).code === 'DEP0040') {
            return;
        }
        warningListeners.forEach(listener => listener.call(process, warning));
    });
}

suppressPunycodeDeprecationWarning();

let activeSession: NodeSession | null = null;
let shutdownPromise: Promise<void> | null = null;

async function shutdown(): Promise<void> {
    if (!shutdownPromise) {
        shutdownPromise = (async () => {
            if (activeSession) {
                await activeSession.close();
                activeSession = null;
            }
            farewell(ui);
        })();
    }

    await shutdownPromise;
}

async function run(): Promise<void> {
    welcome(ui);
    const hodlDir = path.join(os.homedir(), '.HODL');
    fs.mkdirSync(hodlDir, { recursive: true, mode: 0o700 });
    const profileLock = new ProfileLock(path.join(hodlDir, '.default.lock'));
    try {
        profileLock.acquire();
    } catch (error) {
        if (!(error instanceof ProfileLockedError)) {
            throw error;
        }
        showError(ui, error.owner === null
            ? 'The HODL profile is locked. Close the other instance and try again.'
            : `HODL is already open in another terminal (PID ${error.owner}). Close that instance and try again.`);
        return;
    }
    let encryptionKey: string | null = null;

    try {
        encryptionKey = await ui.password({ message: 'Password:' });
        const session = new NodeSession(encryptionKey, profileLock);
        activeSession = session;
        const databaseExisted = session.hasStoredDatabase();

        try {
            await session.connect();
        } catch (error) {
            console.error(errorMessage(error));
            showError(ui, 'Wrong password.');
            process.exitCode = 1;
            return;
        }

        if (!databaseExisted) {
            const confirmedKey = await ui.password({ message: 'Repeat Password:' });
            if (confirmedKey !== encryptionKey) {
                showError(ui, 'Passwords do not match. Please try again.');
                process.exitCode = 1;
                return;
            }
        }

        encryptionKey = null;

        try {
            await runWallet(ui, session);
        } catch (error) {
            showError(ui, 'Failed to initialize wallet.', error);
            process.exitCode = 1;
        }
    } finally {
        encryptionKey = null;
        try {
            await shutdown();
        } finally {
            profileLock.release();
        }
    }
}

export function selectCliMode(argv: string[]): 'interactive' | 'agent' {
    return argv.length === 0 ? 'interactive' : 'agent';
}

interface CliDependencies {
    runInteractive?: () => Promise<void>;
    runAgent?: (argv: string[]) => Promise<number>;
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
    if (selectCliMode(argv) === 'agent') {
        const runAgent = dependencies.runAgent || (await import('./agent-cli.js')).runAgentCli;
        return runAgent(argv);
    }

    await (dependencies.runInteractive || run)();
    return 0;
}

async function runEntrypoint(argv: string[]): Promise<void> {
    if (selectCliMode(argv) === 'agent') {
        process.removeAllListeners('warning');
        process.on('warning', () => undefined);
        process.exitCode = await runCli(argv);
        return;
    }

    process.once('SIGINT', () => {
        void shutdown().finally(() => process.exit(130));
    });

    try {
        process.exitCode = await runCli(argv);
    } catch (error) {
        if (!(error instanceof Error && error.name === 'ExitPromptError')) {
            showError(ui, 'Unexpected error.', error);
            process.exitCode = 1;
        }
        await shutdown();
    }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)) {
    void runEntrypoint(process.argv.slice(2));
}
