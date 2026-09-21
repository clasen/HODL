/** Callers hold an exclusive wallet lock for the entire operation.
 * Reads return detached values; clearing secrets must not mutate stored data.
 * set stages a write; flush resolves only once every preceding write is durable.
 * A rejected flush must prevent broadcast.
 */
export interface WalletStore {
    get(...path: string[]): Promise<unknown>;
    set(...pathAndValue: [...string[], unknown]): Promise<unknown>;
    entries(...path: string[]): Promise<unknown>;
    flush(): Promise<void>;
}
