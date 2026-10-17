/**
 * Copy every field on document `tbs/Settings` onto
 *   tbs/Settings/Zermatt/Zermatt
 * then delete those fields from the parent document (parent doc is kept).
 *
 * Env:
 *   FIREBASE_PROJECT_ID           (optional, default: tbs-app-e2062)
 *   GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_PATH
 *   DRY_RUN=1                     log only, no writes/deletes
 *   DELETE_PARENT_FIELDS=0        copy only; keep fields on tbs/Settings
 *
 * Run:
 *   DRY_RUN=1 node scripts/migrate-tbs-settings-into-zermatt.mjs
 *   node scripts/migrate-tbs-settings-into-zermatt.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadEnvFile(envPath) {
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
    }
}

loadEnvFile(path.join(root, '.env'));

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'tbs-app-e2062';
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'tbs-app-e2062.firebasestorage.app';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const DELETE_PARENT_FIELDS = !(
    process.env.DELETE_PARENT_FIELDS === '0' || process.env.DELETE_PARENT_FIELDS === 'false'
);

const credPath = String(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || ''
).trim();
const credFileOk = credPath !== '' && fs.existsSync(credPath);

if (!admin.apps.length) {
    if (credFileOk) {
        const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: PROJECT_ID,
            storageBucket: STORAGE_BUCKET,
        });
        console.log('Firebase: using service account JSON file.');
    } else {
        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            projectId: PROJECT_ID,
            storageBucket: STORAGE_BUCKET,
        });
        console.log('Firebase: using application default credentials.');
    }
}

const db = admin.firestore();
const parentRef = db.collection('tbs').doc('Settings');
const destRef = parentRef.collection('Zermatt').doc('Zermatt');

function summarize(data) {
    return Object.keys(data)
        .sort()
        .map((k) => {
            const v = data[k];
            const t = v === null ? 'null' : Array.isArray(v) ? 'array[' + v.length + ']' : typeof v;
            return k + ' (' + t + ')';
        });
}

async function main() {
    const parentSnap = await parentRef.get();
    const parentData = parentSnap.exists ? parentSnap.data() || {} : {};
    const keys = Object.keys(parentData);
    console.log(
        'Parent tbs/Settings ' +
            (parentSnap.exists ? 'exists' : 'missing') +
            ' with ' +
            keys.length +
            ' field(s):'
    );
    summarize(parentData).forEach((line) => console.log('  - ' + line));

    const destSnap = await destRef.get();
    const destData = destSnap.exists ? destSnap.data() || {} : {};
    console.log(
        'Dest tbs/Settings/Zermatt/Zermatt ' +
            (destSnap.exists ? 'exists' : 'missing') +
            ' with ' +
            Object.keys(destData).length +
            ' field(s):'
    );
    summarize(destData).forEach((line) => console.log('  - ' + line));

    const merged = Object.assign({}, parentData, destData);
    const mergedKeys = Object.keys(merged);

    if (!keys.length && !Object.keys(destData).length) {
        console.log('Nothing to copy from parent. Done.');
        return;
    }

    if (DRY_RUN) {
        console.log(
            'DRY_RUN: would write ' +
                mergedKeys.length +
                ' field(s) onto tbs/Settings/Zermatt/Zermatt (dest wins on overlap).'
        );
        if (DELETE_PARENT_FIELDS && keys.length) {
            console.log('DRY_RUN: would then delete parent field(s) from tbs/Settings.');
        }
        return;
    }

    await destRef.set(merged, { merge: true });
    const verifySnap = await destRef.get();
    const verifyData = verifySnap.exists ? verifySnap.data() || {} : {};
    const missing = mergedKeys.filter((k) => !Object.prototype.hasOwnProperty.call(verifyData, k));
    if (missing.length) {
        throw new Error('Copy incomplete; missing on dest: ' + missing.join(', '));
    }
    console.log('Wrote ' + mergedKeys.length + ' field(s) to tbs/Settings/Zermatt/Zermatt.');

    if (!DELETE_PARENT_FIELDS) {
        console.log('DELETE_PARENT_FIELDS=0: left fields on tbs/Settings.');
        return;
    }

    const deletes = {};
    for (const k of keys) {
        deletes[k] = admin.firestore.FieldValue.delete();
    }
    await parentRef.update(deletes);
    console.log('Removed ' + keys.length + ' field(s) from tbs/Settings (document kept).');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
