import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Persist from '../persist.js';

/** The profile as stored on disk, read from a copy so an open instance's memory is never consulted. */
export async function readStoredProfile(directory: string, password: string): Promise<any> {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-stored-'));
    fs.copyFileSync(path.join(directory, 'persist.json'), path.join(copy, 'persist.json'));
    const db = new Persist({ path: copy, encryptionKey: password });
    try {
        await db.connect();
        return await db.get();
    } finally {
        await db.dispose();
        fs.rmSync(copy, { recursive: true, force: true });
    }
}
