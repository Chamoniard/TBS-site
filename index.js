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
const INDEX_STANDBY_DEFAULT = 'Stand by...';
const HOME_PAGE_URL = 'home.html';

function normalizeStandbySettingYes(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    return s === 'yes' || s === 'y';
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
        return true;
    }
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        const db = firebase.firestore();
        const snap = await db.collection('tbs').doc('Settings').get();
        const data = snap.exists ? snap.data() || {} : {};
        return normalizeStandbySettingYes(data[FIRESTORE_TBS_SETTINGS_STANDBY_FIELD]);
    } catch (err) {
        console.warn('fetchStandbyModeEnabledFromFirestore:', err);
        return true;
    }
}

async function loadIndexStandbyFromFirestore() {
    if (typeof firebase === 'undefined') {
        applyIndexStandbyFromLocalStorage();
        return;
    }
    try {
        const db = firebase.firestore();
        const snap = await db.collection('tbs').doc('Snippets').get();
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
    const standbyOn = await fetchStandbyModeEnabledFromFirestore();
    if (!standbyOn) {
        window.location.replace(HOME_PAGE_URL);
        return;
    }
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
