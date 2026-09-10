import { swapConfig } from './config.js';

export class SwapHttpError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

export async function swapText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(swapConfig.httpTimeoutMs), redirect: 'error' });
    if (!response.ok) throw new SwapHttpError(response.status, `Provider request failed (HTTP ${response.status}).`);
    return response.text();
}

export async function swapJson(url: string, body?: unknown): Promise<unknown> {
    const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(swapConfig.httpTimeoutMs),
        redirect: 'error'
    });
    if (!response.ok) {
        throw new SwapHttpError(response.status, `Provider request failed (HTTP ${response.status}).`);
    }
    return response.json();
}

export function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response.');
    return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new Error('Invalid provider list.');
    return value;
}

export function textField(value: unknown): string {
    if (typeof value !== 'string' || !value) throw new Error('Missing provider field.');
    return value;
}

export function units(value: unknown): bigint {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid provider amount.');
    return BigInt(value);
}

export function integer(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid provider integer.');
    return value;
}

export function evmAddress(value: unknown): string {
    const address = textField(value);
    if (!/^0x[\da-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) throw new Error('Invalid provider EVM address.');
    return address;
}

export function transactionHash(value: unknown, evm = false): string {
    const hash = textField(value).replace(/^0x/i, '');
    if (!/^[\da-f]{64}$/i.test(hash) || /^0{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
    return `${evm ? '0x' : ''}${hash.toLowerCase()}`;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
    if (a < 0n || b <= 0n) throw new Error('Invalid price calculation.');
    return (a + b - 1n) / b;
}
