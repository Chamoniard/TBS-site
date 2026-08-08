/**
 * Quick check: can this token read the Content table and the Speakers table?
 * Run: node scripts/airtable-check.mjs
 * Uses .env (same loader as populate-airtable-speakers.mjs).
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

const key = process.env.AIRTABLE_API_KEY;
const base = process.env.AIRTABLE_BASE_ID || 'app3cQp1Mn7V8ckWA';

if (!key) {
    console.error('No AIRTABLE_API_KEY in environment or .env');
    process.exit(1);
}

async function tryGet(table) {
    const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?maxRecords=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const text = await res.text();
    return { table, status: res.status, body: text.slice(0, 500) };
}

const speakersTable = process.env.AIRTABLE_SPEAKERS_TABLE || 'Speakers';

console.log('Base:', base);
console.log('Speakers table name:', speakersTable);

const content = await tryGet('Content');
const speakers = await tryGet(speakersTable);

console.log(`\nGET Content → ${content.status}`);
if (content.status !== 200) console.log(content.body);

console.log(`\nGET ${speakersTable} → ${speakers.status}`);
if (speakers.status !== 200) console.log(speakers.body);

console.log('\n---');
if (content.status !== 200 && speakers.status !== 200) {
    console.log('→ Fix: In Developer hub → Personal access tokens, add this base (or workspace) and data.records:read.');
} else if (content.status === 200 && speakers.status !== 200) {
    console.log(
        `→ Fix: In this base, create a table named exactly "${speakersTable}" (case-sensitive), or set AIRTABLE_SPEAKERS_TABLE in .env to your table name.`
    );
    console.log('   Fields needed for push: Name, Bio, BioParagraphHtml (all long/single line as in the script comments).');
} else {
    console.log('→ Token can read Content and Speakers. You can run: npm run speakers:push');
}
