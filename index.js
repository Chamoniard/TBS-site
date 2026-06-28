/** Index standby line: Firestore `tbs/Snippets` field `Stand by` (edited in backend Snippets → Home). */
const firebaseConfig = {
    apiKey: 'AIzaSyANhRZZnQ9tXH-DmO8QQT-H-64LOaa0oAU',
    authDomain: 'tbs-app-e2062.firebaseapp.com',
    projectId: 'tbs-app-e2062',
    storageBucket: 'tbs-app-e2062.firebasestorage.app',
    messagingSenderId: '696221319423',
    appId: '1:696221319423:web:805b69b93e93d206568cca',
    measurementId: 'G-HH4D0B5F2D'
};

const FIRESTORE_TBS_SETTINGS_STANDBY_FIELD = 'Standby';
const FIRESTORE_TBS_SNIPPETS_STANDBY_FIELD = 'Stand by';
const TBS_TEXTEDITOR_HOME_STANDBY_LS_KEY = 'tbsBackend:texteditor:home:standby';
const INDEX_STANDBY_MODE_LS_KEY = 'tbs:index:standby';
const INDEX_STANDBY_DEFAULT = 'Stand by...';
const HOME_PAGE_URL = 'home.html';
const INDEX_FIRESTORE_TIMEOUT_MS = 10000;
const INDEX_SETTINGS_TIMEOUT_MS = 1500;
const INDEX_STANDBY_MODE_CACHE_TTL_MS = 5 * 60 * 1000;

function withFirestoreTimeout(promise, label, timeoutMs) {
    return Promise.race([
        promise,
        new Promise(function (_, reject) {
            setTimeout(function () {
                reject(new Error(label || 'Firestore timeout'));
            }, timeoutMs || INDEX_FIRESTORE_TIMEOUT_MS);
        }),
    ]);
}

function normalizeStandbySettingYes(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    return s === 'yes' || s === 'y';
}

function readCachedStandbyMode() {
    try {
        const raw = localStorage.getItem(INDEX_STANDBY_MODE_LS_KEY);
        const parts = raw ? String(raw).split('|') : [];
        const cachedAt = Number(parts[1] || 0);
        if (!parts[0] || !cachedAt || Date.now() - cachedAt > INDEX_STANDBY_MODE_CACHE_TTL_MS) {
            return null;
        }
        if (parts[0] === 'yes') return true;
        if (parts[0] === 'no') return false;
    } catch (e) {
        /* ignore */
    }
    return null;
}

function cacheStandbyMode(isStandbyOn) {
    try {
        localStorage.setItem(INDEX_STANDBY_MODE_LS_KEY, (isStandbyOn ? 'yes' : 'no') + '|' + Date.now());
    } catch (e) {
        /* ignore */
    }
}

function revealIndexPage() {
    document.documentElement.classList.remove('index-is-checking');
}

function applyIndexStandbyContent(raw) {
    const el = document.querySelector('.index-standby-title');
    if (!el) return;
    const text = String(raw == null ? '' : raw).trim();
    if (!text) {
        el.textContent = INDEX_STANDBY_DEFAULT;
    } else if (/<[a-z][\s\S]*>/i.test(text)) {
        el.innerHTML = text;
    } else {
        el.textContent = text;
    }
    el.classList.add('is-ready');
    el.removeAttribute('hidden');
    el.setAttribute('aria-hidden', 'false');
}

function applyIndexStandbyFromLocalStorage() {
    try {
        const fromLs = localStorage.getItem(TBS_TEXTEDITOR_HOME_STANDBY_LS_KEY);
        if (fromLs != null && String(fromLs).trim() !== '') {
            applyIndexStandbyContent(fromLs);
            return true;
        }
    } catch (e) {
        /* ignore */
    }
    return false;
}

async function fetchStandbyModeEnabledFromFirestore() {
    if (typeof firebase === 'undefined') {
        return null;
    }
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        const db = firebase.firestore();
        const snap = await withFirestoreTimeout(
            db.collection('tbs').doc('Settings').get(),
            'Firestore tbs/Settings (index standby)',
            INDEX_SETTINGS_TIMEOUT_MS
        );
        const data = snap.exists ? snap.data() || {} : {};
        return normalizeStandbySettingYes(data[FIRESTORE_TBS_SETTINGS_STANDBY_FIELD]);
    } catch (err) {
        console.warn('fetchStandbyModeEnabledFromFirestore:', err);
        return null;
    }
}

async function loadIndexStandbyFromFirestore() {
    if (typeof firebase === 'undefined') {
        applyIndexStandbyFromLocalStorage();
        return;
    }
    try {
        const db = firebase.firestore();
        const snap = await withFirestoreTimeout(
            db.collection('tbs').doc('Snippets').get(),
            'Firestore tbs/Snippets (index standby)'
        );
        const data = snap.exists ? snap.data() || {} : {};
        const raw = data[FIRESTORE_TBS_SNIPPETS_STANDBY_FIELD];
        const html = raw != null ? String(raw) : '';
        if (String(html).trim() !== '') {
            try {
                localStorage.setItem(TBS_TEXTEDITOR_HOME_STANDBY_LS_KEY, html);
            } catch (lsErr) {
                console.warn('index standby localStorage:', lsErr);
            }
            applyIndexStandbyContent(html);
            return;
        }
    } catch (err) {
        console.warn('loadIndexStandbyFromFirestore:', err);
    }
    if (!applyIndexStandbyFromLocalStorage()) {
        applyIndexStandbyContent(INDEX_STANDBY_DEFAULT);
    }
}

async function initIndexPage() {
    const cachedStandbyOn = readCachedStandbyMode();
    if (cachedStandbyOn === false) {
        window.location.replace(HOME_PAGE_URL);
        return;
    }

    const standbyOn = await fetchStandbyModeEnabledFromFirestore();
    if (standbyOn === false) {
        cacheStandbyMode(false);
        window.location.replace(HOME_PAGE_URL);
        return;
    }

    if (standbyOn === true) {
        cacheStandbyMode(true);
    }

    if (!applyIndexStandbyFromLocalStorage()) {
        applyIndexStandbyContent(INDEX_STANDBY_DEFAULT);
    }
    revealIndexPage();
    await loadIndexStandbyFromFirestore();
}

document.addEventListener('DOMContentLoaded', function () {
    void initIndexPage();
});

window.addEventListener('storage', function (ev) {
    if (ev.key === TBS_TEXTEDITOR_HOME_STANDBY_LS_KEY) {
        applyIndexStandbyContent(ev.newValue || '');
    }
});
