/**
 * Recursively copy tbs/Programme/{FROM}/… onto tbs/Programme/{TO}/…
 * (docs + nested subcollections, including days/{ISO}/Session-…/slots).
 *
 * Env:
 *   FROM=TBS27 (default)
 *   TO=TBS Alaska (default)
 *   DRY_RUN=1
 *   FIREBASE_PROJECT_ID (optional, default: tbs-app-e2062)
 *   GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_PATH
 *
 * Run:
 *   DRY_RUN=1 node scripts/copy-tbs-programme-event.mjs
 *   FROM=TBS27 TO="TBS Alaska" node scripts/copy-tbs-programme-event.mjs
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
const FROM = String(process.env.FROM || 'TBS27').trim();
const TO = String(process.env.TO || 'TBS Alaska').trim();

if (!FROM || !TO) {
    console.error('FROM and TO must be non-empty programme event keys.');
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

function programmeRootRef() {
    return db.collection('tbs').doc('Programme');
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

async function copyDocRecursive(sourceDocRef, targetDocRef, stats) {
    const snap = await sourceDocRef.get();
    if (!snap.exists) return;
    let data = snap.data() || {};
    // Point destination days-root metadata at the new event key.
    if (
        sourceDocRef.id === 'days' &&
        sourceDocRef.parent &&
        sourceDocRef.parent.id === FROM
    ) {
        data = { ...data, eventKey: TO, copiedFrom: FROM };
    }
    if (DRY_RUN) {
        console.log('  DRY_RUN set ' + targetDocRef.path);
    } else {
        await targetDocRef.set(data, { merge: false });
    }
    stats.docsCopied += 1;

    const subcols = await sourceDocRef.listCollections();
    for (const subcol of subcols) {
        const subSnap = await subcol.get();
        for (const child of subSnap.docs) {
            await copyDocRecursive(
                child.ref,
                targetDocRef.collection(subcol.id).doc(child.id),
                stats
            );
        }
    }
}

async function ensureEventKeyOnRoot(eventKey) {
    const key = String(eventKey || '').trim();
    if (!key) return;
    if (DRY_RUN) {
        console.log('DRY_RUN would arrayUnion eventKeys: ' + key);
        return;
    }
    await programmeRootRef().set(
        { eventKeys: admin.firestore.FieldValue.arrayUnion(key) },
        { merge: true }
    );
}

async function main() {
    console.log(
        'Copy tbs/Programme/' +
            FROM +
            ' → tbs/Programme/' +
            TO +
            (DRY_RUN ? ' (DRY_RUN)' : '')
    );

    const sourceCol = programmeRootRef().collection(FROM);
    const destCol = programmeRootRef().collection(TO);
    const sourceCount = await countDocsRecursive(sourceCol);
    console.log('Source tree doc count: ' + sourceCount);

    if (!sourceCount) {
        throw new Error('Source empty or missing: tbs/Programme/' + FROM);
    }

    const destBefore = await countDocsRecursive(destCol);
    console.log('Dest tree doc count before: ' + destBefore);

    const stats = { docsCopied: 0 };
    const sourceSnap = await sourceCol.get();
    for (const docSnap of sourceSnap.docs) {
        await copyDocRecursive(docSnap.ref, destCol.doc(docSnap.id), stats);
    }

    await ensureEventKeyOnRoot(TO);

    if (DRY_RUN) {
        console.log('DRY_RUN would copy ' + stats.docsCopied + ' doc(s).');
        return;
    }

    const destAfter = await countDocsRecursive(destCol);
    console.log('Dest tree doc count after: ' + destAfter);
    if (destAfter < sourceCount) {
        throw new Error(
            'Copy verification failed: source=' +
                sourceCount +
                ' dest=' +
                destAfter
        );
    }

    const rootSnap = await programmeRootRef().get();
    const keys = (rootSnap.data() || {}).eventKeys;
    console.log('Done. Copied ' + stats.docsCopied + ' doc(s). eventKeys=', keys);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
