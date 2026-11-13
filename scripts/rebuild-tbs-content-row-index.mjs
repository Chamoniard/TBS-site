/**
 * Rebuild Firestore manifest index field:
 *   tbs/Content.rowIds
 *
 * Source of truth: subcollection ids under `tbs/Content/{rowId}/item`.
 *
 * Run:
 *   node scripts/rebuild-tbs-content-row-index.mjs
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
        console.log('Firebase: using Application Default Credentials.');
    }
}

const db = admin.firestore();
const parentRef = db.collection('tbs').doc('Content');

async function main() {
    const subcollections = await parentRef.listCollections();
    const rowIds = subcollections
        .map((c) => String(c.id || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));

    await parentRef.set(
        {
            rowIds,
            indexUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );

    console.log(`Updated tbs/Content.rowIds with ${rowIds.length} id(s).`);
    if (rowIds.length) {
        console.log('First ids:', rowIds.slice(0, 10).join(', '));
    }
}

main().catch((err) => {
    console.error('Failed rebuilding tbs/Content.rowIds:', err && err.message ? err.message : err);
    process.exit(1);
});
