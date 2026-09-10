import fs from 'node:fs';

export type ProfileLockOptions = {
    isProcessAlive?: (pid: number) => boolean;
    pid?: number;
};

function defaultIsProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export class ProfileLockedError extends Error {
    constructor(public readonly owner: number | null) {
        super(`Profile is locked by process ${owner}.`);
        this.name = 'ProfileLockedError';
    }
}

export class ProfileLock {
    private readonly lockPath: string;
    private readonly isProcessAlive: (pid: number) => boolean;
    private readonly pid: number;
    private acquired = false;

    constructor(lockPath: string, options: ProfileLockOptions = {}) {
        this.lockPath = lockPath;
        this.isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
        this.pid = options.pid || process.pid;
    }

    acquire(): void {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
                try {
                    fs.writeFileSync(descriptor, `${this.pid}\n`, 'utf8');
                } finally {
                    fs.closeSync(descriptor);
                }
                this.acquired = true;
                return;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }

                const owner = this.readOwner();
                if (owner === null || this.isProcessAlive(owner)) {
                    throw new ProfileLockedError(owner);
                }

                try {
                    fs.unlinkSync(this.lockPath);
                } catch (unlinkError) {
                    if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw unlinkError;
                    }
                }
            }
        }

        throw new Error('Unable to acquire profile lock.');
    }

    release(): void {
        if (!this.acquired) {
            return;
        }

        try {
            fs.unlinkSync(this.lockPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        } finally {
            this.acquired = false;
        }
    }

    private readOwner(): number | null {
        try {
            const value = fs.readFileSync(this.lockPath, 'utf8').trim();
            const pid = Number(value);
            return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }
}
