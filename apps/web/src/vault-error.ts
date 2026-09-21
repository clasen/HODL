export class VaultError extends Error {}

export function userMessage(error: unknown): string {
    return error instanceof VaultError ? error.message : 'Could not complete the operation. Try again.';
}
