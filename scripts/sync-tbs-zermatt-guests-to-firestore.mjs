/**
 * Reads Airtable base **TBS-Zermatt**, table **TBS-Z: Guests**, and writes Firestore under:
 *   tbs / Guests / {airtableRecordId} / item
 *
 * Each Airtable row is mirrored to Firestore with the same field names and values
 * (sanitized for Firestore-compatible JSON types).
 *
 * Parent document `tbs/Guests` gets manifest fields:
 *   - guestIds: ordered array of Airtable record ids
 *   - syncSource, syncUpdatedAt
 *
 * Before writing, deletes every existing `item` doc under `tbs/Guests/*` so Firestore
 * matches Airtable only (no stale rows when Airtable ids change).
 *
 * Env (or .env in repo root):
 *   AIRTABLE_API_KEY              (required) PAT with data.records:read on the base
 *   AIRTABLE_TBS_ZERMATT_BASE_ID  (optional, default: appnXwf1lsgcDXkNL)
 *   AIRTABLE_GUESTS_TABLE         (optional, default: TBS-Z: Guests)
 *   FIREBASE_PROJECT_ID           (optional, default: tbs-app-e2062)
 *   GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_PATH for Admin, or use ADC
 *   DRY_RUN=1                     log only, no Firestore writes
 *
 * Run:
 *   npm run guests:sync-tbs-firestore
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

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_TBS_ZERMATT_BASE_ID || 'appnXwf1lsgcDXkNL';
const GUESTS_TABLE = process.env.AIRTABLE_GUESTS_TABLE || 'TBS-Z: Guests';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'tbs-app-e2062';
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'tbs-app-e2062.firebasestorage.app';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const credPath = String(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || ''
).trim();
const credFileOk = credPath !== '' && fs.existsSync(credPath);

if (!AIRTABLE_API_KEY) {
    console.error('Missing AIRTABLE_API_KEY (set in env or .env).');
    process.exit(1);
}

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
        try {
            admin.initializeApp({
                credential: admin.credential.applicationDefault(),
                projectId: PROJECT_ID,
                storageBucket: STORAGE_BUCKET,
            });
            console.log('Firebase: using Application Default Credentials.');
        } catch (e) {
            console.error(
                'Could not initialize Firebase Admin. Set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth application-default login.'
            );
            if (e && e.message) console.error(e.message);
            process.exit(1);
        }
    }
}

const db = admin.firestore();
const FIRESTORE_BATCH_MAX = 500;
const parentRef = db.collection('tbs').doc('Guests');

async function fetchAllAirtableGuestRecords() {
    const tableSeg = encodeURIComponent(GUESTS_TABLE);
    const out = [];
    let offset = '';
    for (;;) {
        const url =
            `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableSeg}` +
            '?pageSize=100' +
            (offset ? `&offset=${encodeURIComponent(offset)}` : '');
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`Airtable ${res.status}: ${text.slice(0, 500)}`);
        }
        const body = JSON.parse(text);
        if (Array.isArray(body.records)) out.push(...body.records);
        offset = body.offset || '';
        if (!offset) break;
    }
    return out;
}

function sanitizeForFirestore(value) {
    if (value === undefined) return null;
    if (value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return value;
    if (Array.isArray(value)) return value.map((v) => sanitizeForFirestore(v));
    if (t === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = sanitizeForFirestore(v);
        }
        return out;
    }
    return String(value);
}

function buildItemPayload(record) {
    const fields = record && record.fields && typeof record.fields === 'object' ? record.fields : {};
    return sanitizeForFirestore(fields);
}

async function deleteAllGuestItemsUnderParent() {
    const subcols = await parentRef.listCollections();
    let deleted = 0;
    for (const sub of subcols) {
        const snap = await sub.get();
        if (snap.empty) continue;
        const docs = snap.docs;
        for (let i = 0; i < docs.length; i += FIRESTORE_BATCH_MAX) {
            const batch = db.batch();
            const chunk = docs.slice(i, i + FIRESTORE_BATCH_MAX);
            for (const d of chunk) batch.delete(d.ref);
            await batch.commit();
            deleted += chunk.length;
        }
    }
    return deleted;
}

async function writeGuestItems(records) {
    const guestIds = [];
    let written = 0;
    const ops = [];
    for (const rec of records) {
        const id = String(rec.id || '').trim();
        if (!id) continue;
        guestIds.push(id);
        const ref = parentRef.collection(id).doc('item');
        ops.push({ ref, payload: buildItemPayload(rec) });
    }
    for (let i = 0; i < ops.length; i += FIRESTORE_BATCH_MAX) {
        const batch = db.batch();
        const slice = ops.slice(i, i + FIRESTORE_BATCH_MAX);
        for (const { ref, payload } of slice) {
            batch.set(ref, payload, { merge: false });
        }
        await batch.commit();
        written += slice.length;
    }
    await parentRef.set(
        {
            guestIds,
            syncSource: `airtable:${GUESTS_TABLE}`,
            syncUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
    return { written, guestIds };
}

console.log(
    `Airtable: base ${AIRTABLE_BASE_ID} / table "${GUESTS_TABLE}" → Firestore: tbs/Guests/{recordId}/item`
);
if (DRY_RUN) console.log('DRY_RUN=1 — no Firestore writes.');

const records = await fetchAllAirtableGuestRecords();
console.log(`Airtable: fetched ${records.length} guest row(s).`);

if (DRY_RUN) {
    if (records[0]) {
        const sampleKeys = Object.keys(buildItemPayload(records[0]));
        console.log(
            'Sample item field keys:',
            sampleKeys.slice(0, 30).join(', '),
            sampleKeys.length > 30 ? '…' : ''
        );
    }
    process.exit(0);
}

let removed = 0;
try {
    removed = await deleteAllGuestItemsUnderParent();
    console.log(`Firestore: removed ${removed} existing document(s) under tbs/Guests/* before sync.`);
} catch (e) {
    console.error('Firestore delete (pre-sync) failed:', e && e.message ? e.message : e);
    process.exit(1);
}

if (!records.length) {
    await parentRef.set(
        {
            guestIds: [],
            syncSource: `airtable:${GUESTS_TABLE}`,
            syncUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
    console.log('No Airtable rows; tbs/Guests manifest cleared to empty guestIds.');
    process.exit(0);
}

try {
    const { written, guestIds } = await writeGuestItems(records);
    console.log(`Done. Wrote ${written} document(s). guestIds count: ${guestIds.length}.`);
    console.log(`Example path: ${parentRef.collection(guestIds[0]).doc('item').path}`);
} catch (e) {
    console.error('Firestore write failed:', e && e.message ? e.message : e);
    process.exit(1);
}
