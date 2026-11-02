import assert from 'node:assert/strict';
import type Persist from '../../persist.js';

/** Fails any write that is not plain JSON, as the web vault does. */
export function jsonOnly(db: Persist): Persist {
    const set = db.set.bind(db);
    db.set = (async (...pathAndValue: Parameters<Persist['set']>) => {
        const value = pathAndValue.at(-1);
        assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `Not plain JSON at ${pathAndValue.slice(0, -1).join('.')}`);
        return set(...pathAndValue);
    }) as Persist['set'];
    return db;
}
