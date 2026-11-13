/**
 * Move ISO-date programme day collections under:
 *   tbs/Programme/tbs27/days/{ISO-date}/…
 *
 * Copies every doc (and nested `slots` subcollections) from each top-level
 * `tbs/Programme/{YYYY-MM-DD}` collection into the nested path, then deletes
 * the old top-level date collections.
 *
 * Env:
 *   FIREBASE_PROJECT_ID           (optional, default: tbs-app-e2062)
 *   GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_PATH
 *   DRY_RUN=1                     log only, no writes/deletes
 *   DELETE_OLD=0                  copy only; keep old collections
 *
 * Run:
 *   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
 *   gcloud auth application-default login   # if ADC expired
 *   DRY_RUN=1 node scripts/migrate-programme-days-into-tbs27.mjs
 *   node scripts/migrate-programme-days-into-tbs27.mjs
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
const DELETE_OLD = !(process.env.DELETE_OLD === '0' || process.env.DELETE_OLD === 'false');
const EVENT_KEY = String(process.env.PROGRAMME_EVENT_KEY || 'tbs27').trim() || 'tbs27';
const DAYS_DOC = String(process.env.PROGRAMME_DAYS_DOC || 'days').trim() || 'days';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function isIsoDateId(id) {
    return ISO_DATE_RE.test(String(id || '').trim());
}

function programmeRootRef() {
    return db.collection('tbs').doc('Programme');
}

function targetDayCollection(isoDate) {
    return programmeRootRef().collection(EVENT_KEY).doc(DAYS_DOC).collection(String(isoDate).trim());
}

async function copyDocRecursive(sourceDocRef, targetDocRef, stats) {
    const snap = await sourceDocRef.get();
    if (!snap.exists) return;
    const data = snap.data() || {};
    if (DRY_RUN) {
        console.log(`  DRY_RUN set ${targetDocRef.path}`);
    } else {
        await targetDocRef.set(data, { merge: false });
    }
    stats.docsCopied += 1;

    const subcols = await sourceDocRef.listCollections();
    for (const subcol of subcols) {
        const subSnap = await subcol.get();
        for (const child of subSnap.docs) {
            await copyDocRecursive(child.ref, targetDocRef.collection(subcol.id).doc(child.id), stats);
        }
    }
}

async function deleteCollectionRecursive(colRef, stats) {
    const snap = await colRef.get();
    for (const docSnap of snap.docs) {
        const nested = await docSnap.ref.listCollections();
        for (const nestedCol of nested) {
            await deleteCollectionRecursive(nestedCol, stats);
        }
        if (DRY_RUN) {
            console.log(`  DRY_RUN delete ${docSnap.ref.path}`);
        } else {
            await docSnap.ref.delete();
        }
        stats.docsDeleted += 1;
    }
}

async function countDocsRecursive(colRef) {
    let n = 0;
    const snap = await colRef.get();
    for (const docSnap of snap.docs) {
        n += 1;
        const nested = await docSnap.ref.listCollections();
        for (const nestedCol of nested) {
            n += await countDocsRecursive(nestedCol);
        }
    }
    return n;
}

async function main() {
    console.log(
        `Migrate programme ISO days → tbs/Programme/${EVENT_KEY}/${DAYS_DOC}/{ISO}` +
            (DRY_RUN ? ' (DRY_RUN)' : '') +
            (DELETE_OLD ? '' : ' (DELETE_OLD=0)')
    );

    const rootRef = programmeRootRef();
    // Ensure bridge doc exists so Console shows the nested day collections.
    if (!DRY_RUN) {
        await rootRef.collection(EVENT_KEY).doc(DAYS_DOC).set(
            {
                role: 'programme-days-root',
                eventKey: EVENT_KEY,
                migratedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    } else {
        console.log(`DRY_RUN ensure ${rootRef.collection(EVENT_KEY).doc(DAYS_DOC).path}`);
    }

    const cols = await rootRef.listCollections();
    const dateCols = cols.filter((c) => isIsoDateId(c.id)).sort((a, b) => a.id.localeCompare(b.id));
    console.log(
        `Found ${cols.length} collection(s) under tbs/Programme; ${dateCols.length} ISO date collection(s): ` +
            dateCols.map((c) => c.id).join(', ')
    );

    if (!dateCols.length) {
        console.log('Nothing to migrate.');
        return;
    }

    const stats = { docsCopied: 0, docsDeleted: 0, days: 0 };

    for (const dateCol of dateCols) {
        const iso = dateCol.id;
        const sourceCount = await countDocsRecursive(dateCol);
        console.log(`\nDay ${iso}: ${sourceCount} doc(s) in source tree`);

        const targetCol = targetDayCollection(iso);
        const sourceSnap = await dateCol.get();
        for (const docSnap of sourceSnap.docs) {
            await copyDocRecursive(docSnap.ref, targetCol.doc(docSnap.id), stats);
        }

        const targetCount = DRY_RUN ? sourceCount : await countDocsRecursive(targetCol);
        if (!DRY_RUN && targetCount < sourceCount) {
            throw new Error(
                `Copy verification failed for ${iso}: source=${sourceCount} target=${targetCount}`
            );
        }
        console.log(`  target has ${targetCount} doc(s)`);
        stats.days += 1;

        if (DELETE_OLD) {
            console.log(`  deleting old collection tbs/Programme/${iso}`);
            await deleteCollectionRecursive(dateCol, stats);
        }
    }

    console.log('\nDone.', stats);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
