/**
 * Copy all fields from tbs/Settings/{FROM}/{FROM} onto tbs/Settings/{TO}/{TO}.
 *
 * Env:
 *   FROM=Zermatt (default)
 *   TO=Alaska (default)
 *   DRY_RUN=1
 *   FIREBASE_PROJECT_ID (optional, default: tbs-app-e2062)
 *   GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_PATH
 *
 * Run:
 *   DRY_RUN=1 node scripts/copy-tbs-settings-location.mjs
 *   FROM=Zermatt TO=Alaska node scripts/copy-tbs-settings-location.mjs
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
const STORAGE_BUCKET =
    process.env.FIREBASE_STORAGE_BUCKET || 'tbs-app-e2062.firebasestorage.app';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const FROM = String(process.env.FROM || 'Zermatt').trim();
const TO = String(process.env.TO || 'Alaska').trim();

if (!FROM || !TO) {
    console.error('FROM and TO must be non-empty location names.');
    process.exit(1);
}
if (FROM === TO) {
    console.error('FROM and TO must be different.');
    process.exit(1);
}

const credPath = String(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        ''
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
const sourceRef = parentRef.collection(FROM).doc(FROM);
const destRef = parentRef.collection(TO).doc(TO);

function summarize(data) {
    return Object.keys(data)
        .sort()
        .map((k) => {
            const v = data[k];
            const t =
                v === null
                    ? 'null'
                    : Array.isArray(v)
                      ? 'array[' + v.length + ']'
                      : typeof v;
            return k + ' (' + t + ')';
        });
}

async function main() {
    const sourceSnap = await sourceRef.get();
    if (!sourceSnap.exists) {
        throw new Error(
            'Source missing: tbs/Settings/' + FROM + '/' + FROM
        );
    }
    const sourceData = sourceSnap.data() || {};
    const keys = Object.keys(sourceData);
    console.log(
        'Source tbs/Settings/' +
            FROM +
            '/' +
            FROM +
            ' has ' +
            keys.length +
            ' field(s):'
    );
    summarize(sourceData).forEach((line) => console.log('  - ' + line));

    const destSnap = await destRef.get();
    const destData = destSnap.exists ? destSnap.data() || {} : {};
    console.log(
        'Dest tbs/Settings/' +
            TO +
            '/' +
            TO +
            ' ' +
            (destSnap.exists ? 'exists' : 'missing') +
            ' with ' +
            Object.keys(destData).length +
            ' field(s) before copy.'
    );
    if (Object.keys(destData).length) {
        summarize(destData).forEach((line) => console.log('  - ' + line));
    }

    if (!keys.length) {
        console.log('Source has no fields. Nothing to copy.');
        return;
    }

    if (DRY_RUN) {
        console.log(
            'DRY_RUN: would write ' +
                keys.length +
                ' field(s) onto tbs/Settings/' +
                TO +
                '/' +
                TO +
                ' (merge).'
        );
        return;
    }

    await destRef.set(sourceData, { merge: true });
    const verifySnap = await destRef.get();
    const verifyData = verifySnap.exists ? verifySnap.data() || {} : {};
    const missing = keys.filter(
        (k) => !Object.prototype.hasOwnProperty.call(verifyData, k)
    );
    if (missing.length) {
        throw new Error(
            'Copy incomplete; missing on dest: ' + missing.join(', ')
        );
    }
    console.log(
        'Wrote ' +
            keys.length +
            ' field(s) to tbs/Settings/' +
            TO +
            '/' +
            TO +
            '.'
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
