export class TestStore {
    constructor(snapshot = {}) {
        this.data = structuredClone(snapshot);
        this.durable = structuredClone(snapshot);
        this.failFlush = false;
    }
    async get(collection, key) { return structuredClone(this.data[collection]?.[key]); }
    async set(collection, key, value) {
        this.data[collection] ??= {};
        this.data[collection][key] = structuredClone(value);
    }
    async entries(collection) { return structuredClone(Object.entries(this.data[collection] ?? {})); }
    async flush() {
        if (this.failFlush) throw new Error('Storage unavailable');
        this.durable = structuredClone(this.data);
    }
}

export function check(condition, message) {
    if (!condition) throw new Error(message);
}
