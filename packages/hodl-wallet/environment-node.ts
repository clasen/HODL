import crypto from 'node:crypto';

export async function sha256(value: string): Promise<string> {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomUUID(): string {
    return crypto.randomUUID();
}
