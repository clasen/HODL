import { webConfig } from '../config.mjs';
import { VaultError } from './vault-error.js';

export async function networkRequest<T>(request: () => Promise<T>, check: () => void): Promise<T> {
    check();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            request(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new VaultError('The network did not respond in time. Try again.')), webConfig.transfer.requestTimeoutMs);
            })
        ]);
        check();
        return result;
    } finally { clearTimeout(timeout); }
}
