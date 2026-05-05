/**
 * Reads Airtable table "Content" and writes Firestore under:
 *   tbs_content / {event-name-slug}
 * Before writing, **deletes every document** in `tbs_content` so Firestore matches
 * Airtable only (no leftover rows when slugs change; no merge doubles).
 * Document ID is a unique slug: sanitized `event` + `-` + sanitized `name` (from
 * Airtable Event + Name). Collisions get a short Airtable-id suffix. Field
 * `AirtableRecordId` stores the original Airtable row id. Storage paths use the
 * same slug: TBS/thumbnails/{slug}/…
 *
 * Fields: Title, Name, Date, Type, Excerpt, Content, Fieldcolour, Youtube (strings);
 * Topic (array of strings); Event (string or string array); Featured → Firestore strings
 * 'Yes' / 'No' from the Airtable column named by AIRTABLE_FEATURED_FIELD (default: Featured).
 * If that field is omitted on a row (Airtable hides empty cells), falls back to Content body.
 * Feaured: string 'no' on every doc (default placeholder field name as requested).
 * Image + Alt-image: first attachment → Storage TBS/thumbnails/{id}/image.* | alt.* ;
 *   Firestore Image / Alt-image = Firebase download URLs (Alt-image plain text if not attachment).
 *
 * Prerequisites:
 * - Airtable PAT with data.records:read on the base
 * - Firestore write access via either:
 *   (A) Service account JSON path in GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_PATH, or
 *   (B) Application Default Credentials: install Google Cloud CLI and run
 *       `gcloud auth application-default login` (no JSON key; works when org blocks key creation).
 *
 * Env (or .env in repo root):
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID          (default: app3cQp1Mn7V8ckWA)
 *   AIRTABLE_CONTENTS_TABLE    (default: Content)
 *   AIRTABLE_FEATURED_FIELD    optional: exact Airtable column name for featured (default: Featured)
 *   GOOGLE_APPLICATION_CREDENTIALS  optional: path to service account JSON
 *   FIREBASE_SERVICE_ACCOUNT_PATH   optional: same
 *   FIREBASE_PROJECT_ID       required for ADC path (default: tbs-app-e2062)
 *   FIREBASE_STORAGE_BUCKET   optional (default: tbs-app-e2062.firebasestorage.app)
 *
 * Images: Airtable attachments Image + Alt-image are downloaded and uploaded to
 * Storage path TBS/thumbnails/{recordId}/image.* and .../alt.* ; Firestore fields
 * Image and Alt-image get the Firebase download URLs (strings).
 *
 * Run: npm run content:sync-tbs
 */

import crypto from 'crypto';
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
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app3cQp1Mn7V8ckWA';
const CONTENTS_TABLE = process.env.AIRTABLE_CONTENTS_TABLE || 'Content';
/** Exact Airtable field name for Featured (single select, checkbox, text, etc.). */
const AIRTABLE_FEATURED_FIELD = String(process.env.AIRTABLE_FEATURED_FIELD || 'Featured').trim();
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'tbs-app-e2062';
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'tbs-app-e2062.firebasestorage.app';

const credPath = String(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || ''
).trim();
const credFileOk = credPath !== '' && fs.existsSync(credPath);

if (!AIRTABLE_API_KEY) {
    console.error('Missing AIRTABLE_API_KEY (set in env or .env).');
    process.exit(1);
}
if (credPath !== '' && !credFileOk) {
    console.warn(
        `WARN: Credentials file not found (will try Application Default Credentials instead):\n  ${credPath}`
    );
}

async function fetchAllAirtableRecords() {
    const tableSeg = encodeURIComponent(CONTENTS_TABLE);
    const out = [];
    let offset = '';
    for (;;) {
        const url =
            `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableSeg}` +
            '?pageSize=100' +
            '&fields%5B%5D=Title' +
            '&fields%5B%5D=Name' +
            '&fields%5B%5D=Date' +
            '&fields%5B%5D=Type' +
            '&fields%5B%5D=Event' +
            '&fields%5B%5D=Topic' +
            '&fields%5B%5D=Excerpt' +
            '&fields%5B%5D=Content' +
            '&fields%5B%5D=Fieldcolour' +
            '&fields%5B%5D=Youtube' +
            '&fields%5B%5D=Image' +
            '&fields%5B%5D=Alt-image' +
            '&fields%5B%5D=' +
            encodeURIComponent(AIRTABLE_FEATURED_FIELD) +
            (offset ? `&offset=${encodeURIComponent(offset)}` : '');
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`Airtable ${res.status}: ${text.slice(0, 400)}`);
        }
        const body = JSON.parse(text);
        if (Array.isArray(body.records)) out.push(...body.records);
        offset = body.offset || '';
        if (!offset) break;
    }
    return out;
}

function titleFromFields(fields) {
    if (!fields || typeof fields !== 'object') return '';
    const v = fields.Title;
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    return String(v).trim();
}

/** Airtable single line / date / etc. → trimmed string (first element if array). */
function stringFieldFromAirtable(val) {
    if (val == null) return '';
    if (Array.isArray(val)) {
        if (val.length === 0) return '';
        const x = val[0];
        if (x != null && typeof x === 'object') {
            if (typeof x.name === 'string') return x.name.trim();
            if (typeof x.url === 'string') return '';
        }
        return String(x).trim();
    }
    if (typeof val === 'string') return val.trim();
    return String(val).trim();
}

function nameFromFields(fields) {
    if (!fields || typeof fields !== 'object') return '';
    return stringFieldFromAirtable(fields.Name);
}

function dateFromFields(fields) {
    if (!fields || typeof fields !== 'object') return '';
    return stringFieldFromAirtable(fields.Date);
}

function typeFromFields(fields) {
    if (!fields || typeof fields !== 'object') return '';
    return stringFieldFromAirtable(fields.Type);
}

/**
 * Event: text, single select, or linked records (array of record ids or expanded shapes).
 * Firestore: string if single scalar; otherwise array of strings (order preserved).
 */
function eventFromFields(fields) {
    if (!fields || typeof fields !== 'object') return '';
    const v = fields.Event;
    if (v == null) return '';
    if (Array.isArray(v)) {
        const arr = v
            .map((x) => {
                if (x == null) return '';
                if (typeof x === 'string') return x.trim();
                if (typeof x === 'object' && typeof x.name === 'string') return x.name.trim();
                return String(x).trim();
            })
            .filter(Boolean);
        return arr.length === 0 ? '' : arr;
    }
    return stringFieldFromAirtable(v);
}

/** Topic: Airtable multiple select → string array in Firestore. */
function topicFromFields(fields) {
    if (!fields || typeof fields !== 'object') return [];
    const v = fields.Topic;
    if (v == null) return [];
    if (Array.isArray(v)) {
        return v
            .map((x) => {
                if (x == null) return '';
                if (typeof x === 'string') return x.trim();
                return String(x).trim();
            })
            .filter(Boolean);
    }
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
}

/** Long text / rich text: string; trim edges only. */
function longTextFromFields(fields, airtableKey) {
    if (!fields || typeof fields !== 'object') return '';
    const v = fields[airtableKey];
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    return String(v).trim();
}

function excerptFromFields(fields) {
    return longTextFromFields(fields, 'Excerpt');
}

function contentBodyFromFields(fields) {
    return longTextFromFields(fields, 'Content');
}

/**
 * Raw value from the Airtable Featured column (exact name from AIRTABLE_FEATURED_FIELD),
 * or same name case-insensitively. Returns `undefined` only when Airtable omitted the key
 * (empty / unset cell — Airtable often drops empty fields from `fields`).
 */
function getRawFeaturedFromFields(fields) {
    if (!fields || typeof fields !== 'object') return undefined;
    const want = AIRTABLE_FEATURED_FIELD;
    if (Object.prototype.hasOwnProperty.call(fields, want)) return fields[want];
    const low = want.toLowerCase();
    for (const k of Object.keys(fields)) {
        if (k.toLowerCase() === low) return fields[k];
    }
    return undefined;
}

/** Map Airtable Featured cell → Firestore 'Yes' | 'No'. */
function airtableFeaturedToYesNo(v) {
    if (v == null) return 'No';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return v !== 0 ? 'Yes' : 'No';
    if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return 'No';
        const low = s.toLowerCase();
        if (low === 'no' || low === 'false' || low === '0' || low === 'n') return 'No';
        return 'Yes';
    }
    if (Array.isArray(v)) {
        const has = v.some((x) => x != null && String(x).trim() !== '');
        return has ? 'Yes' : 'No';
    }
    if (typeof v === 'object') {
        if (typeof v.name === 'string' && v.name.trim()) {
            return airtableFeaturedToYesNo(v.name);
        }
        return 'Yes';
    }
    return 'Yes';
}

/**
 * Firestore Featured: 'Yes' / 'No'.
 * Uses Airtable Featured column when that field is present on the record; otherwise
 * falls back to non-empty Content body (after trim).
 */
function featuredYesNoFromFields(fields) {
    const raw = getRawFeaturedFromFields(fields);
    if (raw !== undefined) {
        return airtableFeaturedToYesNo(raw);
    }
    const body = contentBodyFromFields(fields);
    return body && body.trim().length > 0 ? 'Yes' : 'No';
}

/** Lowercase slug safe for Firestore document id segment (letters, digits, hyphen). */
function slugPart(s) {
    let t = String(s ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s/]+/g, '-')
        .replace(/[^a-z0-9-]+/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (!t) t = 'x';
    return t.slice(0, 120);
}

/**
 * Unique Firestore doc id: `event` + `-` + `name` (both from Airtable, slugified).
 * On collision, appends a short suffix derived from the Airtable record id.
 */
function allocateFirestoreDocId(rec, usedDocIds) {
    const ev = eventFromFields(rec.fields);
    const eventStr = Array.isArray(ev) ? ev.filter(Boolean).join('-') : String(ev || '');
    const eventPart = slugPart(eventStr);
    const namePart = slugPart(nameFromFields(rec.fields));
    let base = `${eventPart}-${namePart}`.replace(/^-+|-+$/g, '');
    if (!base || base === '-') base = 'content';
    base = base.slice(0, 400);
    const idTail = String(rec.id || '')
        .replace(/[^a-z0-9-]/gi, '')
        .slice(-14);
    let id = base;
    if (usedDocIds.has(id)) {
        id = `${base}-${idTail}`.slice(0, 450);
    }
    let n = 0;
    while (usedDocIds.has(id)) {
        n += 1;
        id = `${base}-${idTail}-${n}`.slice(0, 450);
    }
    usedDocIds.add(id);
    return id;
}

function fieldcolourFromFields(fields) {
    if (!fields || typeof fields !== 'object') return '';
    return stringFieldFromAirtable(fields.Fieldcolour);
}

/** URL field may be string or { url: string }. */
function youtubeFromFields(fields) {
    if (!fields || typeof fields !== 'object') return '';
    const v = fields.Youtube;
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'object' && typeof v.url === 'string') return v.url.trim();
    return stringFieldFromAirtable(v);
}

/** First Airtable attachment { url, filename, type } or null. */
function firstAttachment(fields, fieldKey) {
    if (!fields || typeof fields !== 'object') return null;
    const v = fields[fieldKey];
    if (v == null) return null;
    if (!Array.isArray(v) || v.length === 0) return null;
    const a = v[0];
    if (!a || typeof a !== 'object') return null;
    if (typeof a.url !== 'string' || !a.url.trim()) return null;
    return {
        url: a.url.trim(),
        filename: typeof a.filename === 'string' && a.filename ? a.filename : 'image',
        type: typeof a.type === 'string' && a.type ? a.type : 'application/octet-stream',
    };
}

function extFromFilenameOrType(filename, mime) {
    const ext = path.extname(filename || '').toLowerCase();
    if (ext && ext.length <= 8) return ext;
    if (mime && mime.includes('jpeg')) return '.jpg';
    if (mime && mime.includes('png')) return '.png';
    if (mime && mime.includes('webp')) return '.webp';
    if (mime && mime.includes('gif')) return '.gif';
    if (mime && mime.includes('svg')) return '.svg';
    return '.bin';
}

/**
 * Download Airtable attachment → Firebase Storage TBS/thumbnails/{recordId}/{role}{ext}
 * Returns { storagePath, downloadUrl } for use in Firestore.
 */
async function uploadAirtableAttachmentToThumbnails(bucket, recordId, role, att) {
    const res = await fetch(att.url);
    if (!res.ok) {
        throw new Error(`download ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extFromFilenameOrType(att.filename, att.type);
    const safeRole = /^[a-z]+$/i.test(role) ? role : 'file';
    const storagePath = `TBS/thumbnails/${recordId}/${safeRole}${ext}`;
    const file = bucket.file(storagePath);
    const token = crypto.randomUUID();
    const contentType = att.type && att.type !== 'application/octet-stream' ? att.type : 'image/jpeg';
    await file.save(buf, {
        resumable: false,
        metadata: {
            contentType,
            metadata: {
                firebaseStorageDownloadTokens: token,
            },
        },
    });
    const enc = encodeURIComponent(storagePath);
    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${enc}?alt=media&token=${token}`;
    return { storagePath, downloadUrl };
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
            console.log(
                'Firebase: using Application Default Credentials (e.g. from `gcloud auth application-default login`).'
            );
        } catch (e) {
            console.error(
                'Could not initialize Firebase Admin.\n' +
                    '- If your org blocks service account **keys**, remove GOOGLE_APPLICATION_CREDENTIALS from .env, set FIREBASE_PROJECT_ID, then run:\n' +
                    '    gcloud auth application-default login\n' +
                    '  and ensure your Google account has Firestore write access on this project.\n' +
                    '- Or supply a valid service account JSON path.\n'
            );
            if (e && e.message) console.error(e.message);
            process.exit(1);
        }
    }
}

const db = admin.firestore();
const bucket = admin.storage().bucket(STORAGE_BUCKET);
/** Listable collection for browser SDK (see backend Content tab). */
const CONTENT_FIRESTORE_COLLECTION = 'tbs_content';
const contentCol = db.collection(CONTENT_FIRESTORE_COLLECTION);
const FIRESTORE_BATCH_MAX = 500;

/**
 * Remove every document in the collection so this run mirrors Airtable only
 * (avoids duplicates when doc ids change and stale docs from merge:true).
 */
async function deleteAllDocumentsInCollection(collectionRef) {
    const snapshot = await collectionRef.get();
    if (snapshot.empty) return 0;
    let deleted = 0;
    const docs = snapshot.docs;
    for (let i = 0; i < docs.length; i += FIRESTORE_BATCH_MAX) {
        const batch = db.batch();
        const chunk = docs.slice(i, i + FIRESTORE_BATCH_MAX);
        for (const doc of chunk) {
            batch.delete(doc.ref);
        }
        await batch.commit();
        deleted += chunk.length;
    }
    return deleted;
}

console.log(
    `Airtable: base ${AIRTABLE_BASE_ID} / table "${CONTENTS_TABLE}" → Firestore: ${CONTENT_FIRESTORE_COLLECTION}/{event-name-slug}`
);
console.log(`Storage bucket: ${STORAGE_BUCKET} → TBS/thumbnails/{event-name-slug}/image.* | alt.*`);

const records = await fetchAllAirtableRecords();
console.log(`Airtable: fetched ${records.length} row(s).`);

let removed = 0;
try {
    removed = await deleteAllDocumentsInCollection(contentCol);
    console.log(
        `Firestore: cleared ${CONTENT_FIRESTORE_COLLECTION} (${removed} document(s) removed before sync).`
    );
} catch (e) {
    console.error('Firestore delete (pre-sync) failed:', e && e.message ? e.message : e);
    process.exit(1);
}

if (!records.length) {
    console.log('No rows in Airtable; collection is now empty.');
    process.exit(0);
}

let written = 0;
let skipped = 0;

const usedDocIds = new Set();
const ops = [];
for (const rec of records) {
    const title = titleFromFields(rec.fields);
    if (!title) {
        console.warn(`Note ${rec.id}: empty Title (still writing row so backend can list all items).`);
        skipped++;
    }
    const firestoreDocId = allocateFirestoreDocId(rec, usedDocIds);
    const docRef = contentCol.doc(firestoreDocId);
    ops.push({
        airtableId: rec.id,
        firestoreDocId,
        fields: rec.fields,
        ref: docRef,
        payload: {
            AirtableRecordId: rec.id,
            Title: title,
            Name: nameFromFields(rec.fields),
            Date: dateFromFields(rec.fields),
            Type: typeFromFields(rec.fields),
            Event: eventFromFields(rec.fields),
            Topic: topicFromFields(rec.fields),
            Excerpt: excerptFromFields(rec.fields),
            Content: contentBodyFromFields(rec.fields),
            Fieldcolour: fieldcolourFromFields(rec.fields),
            Youtube: youtubeFromFields(rec.fields),
            Featured: featuredYesNoFromFields(rec.fields),
            Feaured: 'no',
        },
    });
}

if (ops.length === 0) {
    console.log('No Firestore writes: no Airtable rows.');
    process.exit(0);
}

for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    const sid = op.firestoreDocId;
    try {
        const mainAtt = firstAttachment(op.fields, 'Image');
        if (mainAtt) {
            const r = await uploadAirtableAttachmentToThumbnails(bucket, sid, 'image', mainAtt);
            op.payload.Image = r.downloadUrl;
        }
        const altAtt = firstAttachment(op.fields, 'Alt-image');
        if (altAtt) {
            const r = await uploadAirtableAttachmentToThumbnails(bucket, sid, 'alt', altAtt);
            op.payload['Alt-image'] = r.downloadUrl;
        } else {
            const rawAlt = op.fields['Alt-image'];
            if (typeof rawAlt === 'string' && rawAlt.trim()) {
                op.payload['Alt-image'] = rawAlt.trim();
            }
        }
    } catch (err) {
        console.warn(`Storage/Image Airtable=${op.airtableId} Firestore=${sid}:`, err && err.message ? err.message : err);
    }
}

try {
    for (let i = 0; i < ops.length; i += FIRESTORE_BATCH_MAX) {
        const batch = db.batch();
        const slice = ops.slice(i, i + FIRESTORE_BATCH_MAX);
        for (const { ref, payload } of slice) {
            batch.set(ref, payload, { merge: false });
        }
        await batch.commit();
        written += slice.length;
    }
} catch (e) {
    console.error('Firestore write failed:', e && e.message ? e.message : e);
    console.error('Check: Firebase project =', PROJECT_ID, '| Firestore rules / IAM allow your account to write.');
    process.exit(1);
}

const sample = ops[0].ref.path;
console.log(
    `Done. Wrote ${written} document(s). ${skipped} row(s) had empty Title (still written). Example path: ${sample}`
);
