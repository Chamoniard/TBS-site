/**
 * Local dev: static site + POST /api/submitRegistration (same logic as submitRegistrationHttp).
 * Use when the Cloud Function is not deployed yet.
 *
 *   node scripts/local-registration-server.mjs
 *   → http://127.0.0.1:8082/
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8082);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'tbs-app-e2062';

function loadEnvFile(envPath) {
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
    }
}

loadEnvFile(path.join(root, '.env'));

function initFirebase() {
    if (admin.apps.length) return admin.firestore();
    const credPath = String(
        process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || ''
    ).trim();
    if (credPath && fs.existsSync(credPath)) {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(fs.readFileSync(credPath, 'utf8'))),
            projectId: PROJECT_ID,
        });
    } else {
        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            projectId: PROJECT_ID,
        });
    }
    return admin.firestore();
}

function registrationSlugPart(input) {
    let t = String(input ?? '')
        .trim()
        .replace(/[\s/]+/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '');
    if (!t) t = 'x';
    return t.slice(0, 80);
}

function buildRegistrationGuestId(event, firstName, lastName) {
    const id = `${registrationSlugPart(event)}${registrationSlugPart(firstName)}${registrationSlugPart(lastName)}`.slice(
        0,
        150
    );
    return id || 'guest';
}

async function loadCurrentEventFromSettings(db) {
    const snap = await db.collection('tbs').doc('Settings').get();
    const data = snap.data() || {};
    for (const k of ['Current event', 'currentEvent', 'Current Event']) {
        const v = String(data[k] || '').trim();
        if (v) return v;
    }
    return 'TBS27';
}

function formatApplicationDate(date) {
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/** `YYMMDD` prefix for guest **Log** lines (matches backend guest roster). */
function guestLogYyMmDdPrefix() {
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
}

function guestLogApplicationReceivedLine() {
    return `${guestLogYyMmDdPrefix()}: Application received`;
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function handleSubmitRegistration(body) {
    const firstName = String(body.firstName || '').trim();
    const lastName = String(body.lastName || '').trim();
    const email = String(body.email || '').trim();
    const emailConfirm = String(body.emailConfirm || '').trim();
    const cityRegion = String(body.cityRegion || '').trim();
    const country = String(body.country || '').trim();
    const employer1 = String(body.employer1 || '').trim();
    const employer2 = String(body.employer2 || '').trim();
    const trainingLevel = String(body.trainingLevel || '').trim();
    const veryBriefBio = String(body.veryBriefBio || '').trim();
    const pastTbs = String(body.pastTbs || '').trim();
    const baseSpeciality = Array.isArray(body.baseSpeciality)
        ? body.baseSpeciality.map((v) => String(v || '').trim()).filter(Boolean)
        : [];
    const clinicalContext = Array.isArray(body.clinicalContext)
        ? body.clinicalContext.map((v) => String(v || '').trim()).filter(Boolean)
        : [];

    if (!firstName || !lastName) throw new Error('First and last name are required.');
    if (!email || !email.includes('@')) throw new Error('A valid email is required.');
    if (email !== emailConfirm) throw new Error('Email addresses must match.');
    if (!cityRegion || !country || !employer1) {
        throw new Error('City/region, country, and employer 1 are required.');
    }
    if (!baseSpeciality.length) throw new Error('Select at least one base medical speciality.');
    if (!trainingLevel) throw new Error('Level of training is required.');
    if (!clinicalContext.length) throw new Error('Select at least one clinical context.');
    if (pastTbs !== 'Yes' && pastTbs !== 'No') {
        throw new Error('Please indicate whether you have attended TBS in the past.');
    }

    const db = initFirebase();
    const event = await loadCurrentEventFromSettings(db);
    const applicationDate = formatApplicationDate(new Date());
    const parentRef = db.collection('tbs').doc('Guests');
    const baseGuestId = buildRegistrationGuestId(event, firstName, lastName);
    let guestId = baseGuestId;
    let suffix = 0;
    while (true) {
        const itemSnap = await parentRef.collection(guestId).doc('item').get();
        if (!itemSnap.exists) break;
        suffix += 1;
        guestId = `${baseGuestId}${suffix}`.slice(0, 150);
    }

    const itemPayload = {
        Name: firstName,
        'Last Name': lastName,
        'E-mail': email,
        'City/region': cityRegion,
        Country: country,
        'Employer 1': employer1,
        'Employer 2': employer2,
        'Base medical speciality': baseSpeciality,
        'Level of Training': trainingLevel,
        'Clinical context': clinicalContext,
        'Brief bio': veryBriefBio,
        'Past TBS?': pastTbs,
        'Application date': applicationDate,
        Attended: false,
        Briefed: 'No',
        'CME sent': 'No',
        Event: event,
        Invited: 'No',
        Invoiced: 'No',
        Paid: 'No',
        Read: 'No',
        Log: [guestLogApplicationReceivedLine()],
    };

    await parentRef.collection(guestId).doc('item').set(itemPayload, { merge: false });
    await parentRef.set({ guestIds: admin.firestore.FieldValue.arrayUnion(guestId) }, { merge: true });
    return { ok: true, guestId, event };
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/api/submitRegistration') {
        setCors(res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
        });
        req.on('end', async () => {
            try {
                const body = raw ? JSON.parse(raw) : {};
                const result = await handleSubmitRegistration(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                let msg = err instanceof Error ? err.message : 'Registration could not be saved.';
                if (/invalid_grant|invalid_rapt|Getting metadata from plugin failed/i.test(msg)) {
                    msg =
                        'Firebase credentials expired or missing. ' +
                        'Set GOOGLE_APPLICATION_CREDENTIALS in .env to a service-account JSON file, ' +
                        'or run: gcloud auth application-default login — then restart npm run start:8082';
                }
                const code = /required|match|Select|indicate|valid email/i.test(msg) ? 400 : 500;
                console.error('[submitRegistration]', err);
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: msg }));
            }
        });
        return;
    }

    let filePath = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') filePath = path.join(root, 'home.html');
    else if (!path.extname(filePath) && fs.existsSync(filePath + '.html')) filePath += '.html';

    if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Local site + registration API: http://127.0.0.1:${PORT}/`);
    console.log('Registration POST: /api/submitRegistration');
    console.log('Requires Firebase Admin credentials (.env or gcloud application-default login).');
});
