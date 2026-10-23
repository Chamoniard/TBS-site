/**
 * Creates records in Airtable table "Speakers" from data/speakers.json.
 *
 * Prerequisites:
 * - Table "Speakers" with fields: Name (single line text), Bio (long text), BioParagraphHtml (long text)
 * - Personal access token with data.records:write
 *
 * Run from repo root:
 *   npm run speakers:push
 * (reads AIRTABLE_API_KEY from .env if not set in the environment)
 *
 * Optional: AIRTABLE_BASE_ID=app... (defaults to same base as blog Content table)
 * Optional: AIRTABLE_SPEAKERS_TABLE=Speakers (must match Airtable table name exactly)
 * Optional: SPEAKERS_PUSH_LIMIT=5 (only first N rows — for testing)
 * Optional: OMIT_BIO_PARAGRAPH_HTML=1 if the table has no BioParagraphHtml field yet
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const TABLE_NAME = process.env.AIRTABLE_SPEAKERS_TABLE || 'Speakers';

if (!AIRTABLE_API_KEY) {
    console.error('Set AIRTABLE_API_KEY (Personal Access Token with data.records:write).');
    process.exit(1);
}

const jsonPath = path.join(root, 'data', 'speakers.json');
const speakers = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

if (!Array.isArray(speakers) || !speakers.length) {
    console.error('data/speakers.json is empty or invalid. Run: node scripts/parse-speakers-html.mjs');
    process.exit(1);
}

const tableSegment = encodeURIComponent(TABLE_NAME);
const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableSegment}`;

const omitParagraph = process.env.OMIT_BIO_PARAGRAPH_HTML === '1';
const limitRaw = process.env.SPEAKERS_PUSH_LIMIT;
const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 0) : null;
const toPush = limit ? speakers.slice(0, limit) : speakers;

console.log(
    `Pushing ${toPush.length} row(s) → base ${AIRTABLE_BASE_ID} / table "${TABLE_NAME}"` +
        (omitParagraph ? ' (BioParagraphHtml omitted)' : '')
);

/** Airtable allows max 10 records per create request */
const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

function fieldsForRow(row) {
    const f = { Name: row.Name, Bio: row.Bio };
    if (!omitParagraph && row.BioParagraphHtml != null) {
        f.BioParagraphHtml = row.BioParagraphHtml;
    }
    return f;
}

const batches = chunk(toPush, 10);
let created = 0;

for (let i = 0; i < batches.length; i++) {
    const records = batches[i].map((row) => ({
        fields: fieldsForRow(row),
    }));

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records, typecast: true }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
        console.error(`Batch ${i + 1} failed (${res.status}):`, bodyText);
        try {
            const err = JSON.parse(bodyText);
            if (err?.error?.message) console.error('Message:', err.error.message);
        } catch {
            /* ignore */
        }
        if (res.status === 403) {
            console.error(
                '\n403: Token cannot access this base/table. Run: npm run airtable:check\n' +
                    'Fix the token (Developer hub) or set AIRTABLE_BASE_ID / AIRTABLE_SPEAKERS_TABLE in .env.'
            );
        }
        if (res.status === 422) {
            console.error(
                '\n422: Field names must match Airtable exactly: Name, Bio, BioParagraphHtml.\n' +
                    'If BioParagraphHtml is missing in the table, add that field or set OMIT_BIO_PARAGRAPH_HTML=1 in .env.'
            );
        }
        process.exit(1);
    }

    const body = JSON.parse(bodyText);
    created += body.records?.length || 0;
    console.log(`Batch ${i + 1}/${batches.length}: created ${body.records?.length || 0} records`);
}

console.log(`Done. Total created: ${created}`);
