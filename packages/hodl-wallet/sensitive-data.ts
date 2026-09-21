const sensitiveFields = new Set(['privateKey', 'mnemonic', 'rawTransaction']);

export function isSensitiveField(field: string): boolean {
    return sensitiveFields.has(field);
}

export function clearSensitiveData(value: unknown): void {
    if (Array.isArray(value)) {
        value.forEach(clearSensitiveData);
        return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, item] of Object.entries(value)) {
        if (isSensitiveField(key)) {
            (value as Record<string, unknown>)[key] = '';
        } else {
            clearSensitiveData(item);
        }
    }
}
