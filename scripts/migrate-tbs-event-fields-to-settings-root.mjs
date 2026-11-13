/**
 * Move event fields from tbs/Settings/Zermatt/Zermatt back onto tbs/Settings:
 *   Allevents, Current event, Eventdates (and known aliases if present).
 * Then delete those fields from the Zermatt document.
 *
 * Env:
 *   DRY_RUN=1                     log only
 *
 * Run:
 *   node scripts/migrate-tbs-event-fields-to-settings-root.mjs
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

const EVENT_KEYS = [
    'Allevents',
    'Current event',
    'Eventdates',
    'All events',
    'allEvents',
    'AllEvents',
    'ALL EVENTS',
    'currentEvent',
    'Current Event',
    'CURRENT EVENT',
    'Event dates',
    'EventDates',
    'eventdates',
];

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

async function main() {
    const destSnap = await destRef.get();
    const dest = destSnap.exists ? destSnap.data() || {} : {};
    const parentSnap = await parentRef.get();
    const parent = parentSnap.exists ? parentSnap.data() || {} : {};

    const toCopy = {};
    const toDelete = {};
    for (const k of EVENT_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(dest, k) || dest[k] == null) continue;
        toCopy[k] = dest[k];
        toDelete[k] = admin.firestore.FieldValue.delete();
    }
    const keys = Object.keys(toCopy);
    console.log('Zermatt event fields to move: ' + (keys.join(', ') || '(none)'));
    console.log(
        'Parent already has: ' +
            EVENT_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(parent, k)).join(', ')
    );

    if (!keys.length) {
        console.log('Nothing to move. Done.');
        return;
    }

    if (DRY_RUN) {
        console.log('DRY_RUN: would copy onto tbs/Settings then delete from Zermatt/Zermatt.');
        return;
    }

    await parentRef.set(toCopy, { merge: true });
    const verify = await parentRef.get();
    const verifyData = verify.exists ? verify.data() || {} : {};
    const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(verifyData, k));
    if (missing.length) {
        throw new Error('Copy incomplete; missing on parent: ' + missing.join(', '));
    }
    await destRef.update(toDelete);
    console.log('Moved ' + keys.length + ' field(s) to tbs/Settings and removed them from Zermatt/Zermatt.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
