/**
 * Shared Firebase Google Auth + Gmail OAuth for staff login and backend.
 */
(function (global) {
    'use strict';

    const LOGIN_URL = 'login.html';
    const BACKEND_URL = 'backend.html';
    const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
    const GMAIL_TOKEN_STORAGE_KEY = 'tbs_gmail_access_token';
    const GMAIL_TOKEN_EXPIRY_STORAGE_KEY = 'tbs_gmail_access_token_expiry_ms';

    /** Require Google sign-in on localhost as well (for testing). */
    const GOOGLE_AUTH_SKIP_ON_LOCALHOST = false;

    const firebaseConfig = {
        apiKey: 'AIzaSyANhRZZnQ9tXH-DmO8QQT-H-64LOaa0oAU',
        authDomain: 'tbs-app-e2062.firebaseapp.com',
        projectId: 'tbs-app-e2062',
        storageBucket: 'tbs-app-e2062.firebasestorage.app',
        messagingSenderId: '696221319423',
        appId: '1:696221319423:web:805b69b93e93d206568cca',
        measurementId: 'G-HH4D0B5F2D',
    };

    function isLocalhost() {
        const host = String(global.location && global.location.hostname ? global.location.hostname : '').toLowerCase();
        return host === 'localhost' || host === '127.0.0.1';
    }

    function shouldSkipGoogleAuth() {
        return GOOGLE_AUTH_SKIP_ON_LOCALHOST && isLocalhost();
    }

    function initFirebaseApp() {
        if (typeof firebase === 'undefined') {
            throw new Error('Firebase SDK not loaded.');
        }
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        return firebase.app();
    }

    function getAuth() {
        initFirebaseApp();
        if (!firebase.auth) {
            throw new Error('Firebase Auth SDK not loaded.');
        }
        return firebase.auth();
    }

    function createGoogleProvider() {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.addScope(GMAIL_SCOPE);
        provider.setCustomParameters({ prompt: 'select_account' });
        return provider;
    }

    function isAllowedBackendUser(user) {
        if (!user || !user.email) return false;
        const providers = Array.isArray(user.providerData) ? user.providerData : [];
        return providers.some(function (p) {
            return p && p.providerId === 'google.com';
        });
    }

    function storeGmailAccessToken(accessToken, expiresInSeconds) {
        if (!accessToken) return;
        const ttlMs = Math.max(60, Number(expiresInSeconds) || 3600) * 1000;
        try {
            global.sessionStorage.setItem(GMAIL_TOKEN_STORAGE_KEY, accessToken);
            global.sessionStorage.setItem(GMAIL_TOKEN_EXPIRY_STORAGE_KEY, String(Date.now() + ttlMs - 60000));
        } catch (e) {
            /* ignore quota */
        }
    }

    function readStoredGmailAccessToken() {
        try {
            const token = global.sessionStorage.getItem(GMAIL_TOKEN_STORAGE_KEY);
            const expiry = Number(global.sessionStorage.getItem(GMAIL_TOKEN_EXPIRY_STORAGE_KEY) || 0);
            if (!token) return '';
            if (expiry && Date.now() > expiry) return '';
            return token;
        } catch (e) {
            return '';
        }
    }

    function clearStoredGmailAccessToken() {
        try {
            global.sessionStorage.removeItem(GMAIL_TOKEN_STORAGE_KEY);
            global.sessionStorage.removeItem(GMAIL_TOKEN_EXPIRY_STORAGE_KEY);
        } catch (e) {
            /* ignore */
        }
    }

    function captureGmailTokenFromCredential(credential) {
        if (!credential || !credential.accessToken) return '';
        storeGmailAccessToken(credential.accessToken, 3600);
        return credential.accessToken;
    }

    function waitForAuthState(auth) {
        return new Promise(function (resolve) {
            const unsub = auth.onAuthStateChanged(function (user) {
                unsub();
                resolve(user || null);
            });
        });
    }

    function redirectToLogin() {
        const next = encodeURIComponent(
            (global.location.pathname.split('/').pop() || BACKEND_URL) + (global.location.search || '') + (global.location.hash || '')
        );
        global.location.replace(LOGIN_URL + '?next=' + next);
    }

    async function signInWithGoogle() {
        if (shouldSkipGoogleAuth()) {
            return { user: null, accessToken: '', skipped: true };
        }
        const auth = getAuth();
        const provider = createGoogleProvider();
        const result = await auth.signInWithPopup(provider);
        const user = result && result.user ? result.user : null;
        if (!isAllowedBackendUser(user)) {
            await auth.signOut();
            clearStoredGmailAccessToken();
            throw new Error('This Google account is not authorized for the TBS backend.');
        }
        const accessToken = captureGmailTokenFromCredential(result.credential);
        return { user: user, accessToken: accessToken, skipped: false };
    }

    async function requireBackendAccess() {
        if (shouldSkipGoogleAuth()) {
            return { user: null, skipped: true };
        }
        const auth = getAuth();
        let user = auth.currentUser;
        if (!user) {
            user = await waitForAuthState(auth);
        }
        if (!user || !isAllowedBackendUser(user)) {
            redirectToLogin();
            return new Promise(function () {});
        }
        return { user: user, skipped: false };
    }

    async function ensureGmailAccessToken(options) {
        const opts = options || {};
        const stored = readStoredGmailAccessToken();
        if (stored) return stored;

        if (shouldSkipGoogleAuth()) {
            return '';
        }

        const auth = getAuth();
        const user = auth.currentUser;
        if (!user) {
            throw new Error('Sign in with Google before using Gmail.');
        }

        const provider = createGoogleProvider();
        if (!opts.forcePrompt) {
            provider.setCustomParameters({ prompt: 'none' });
        }
        try {
            const result = await auth.signInWithPopup(provider);
            const token = captureGmailTokenFromCredential(result.credential);
            if (token) return token;
        } catch (err) {
            if (!opts.forcePrompt) {
                return ensureGmailAccessToken({ forcePrompt: true });
            }
            throw err;
        }
        throw new Error('Could not obtain Gmail access. Try again and allow Gmail permissions.');
    }

    async function signOutStaff() {
        clearStoredGmailAccessToken();
        if (typeof firebase !== 'undefined' && firebase.auth) {
            try {
                await firebase.auth().signOut();
            } catch (e) {
                /* ignore */
            }
        }
        global.location.replace(LOGIN_URL);
    }

    function getPostLoginRedirectUrl() {
        try {
            const params = new URLSearchParams(global.location.search || '');
            const next = String(params.get('next') || '').trim();
            if (next && !next.includes('://') && !next.startsWith('//')) {
                return next;
            }
        } catch (e) {
            /* ignore */
        }
        return BACKEND_URL;
    }

    global.TbsAuth = {
        LOGIN_URL: LOGIN_URL,
        BACKEND_URL: BACKEND_URL,
        GMAIL_SCOPE: GMAIL_SCOPE,
        GOOGLE_AUTH_SKIP_ON_LOCALHOST: GOOGLE_AUTH_SKIP_ON_LOCALHOST,
        firebaseConfig: firebaseConfig,
        isLocalhost: isLocalhost,
        shouldSkipGoogleAuth: shouldSkipGoogleAuth,
        initFirebaseApp: initFirebaseApp,
        getAuth: getAuth,
        isAllowedBackendUser: isAllowedBackendUser,
        signInWithGoogle: signInWithGoogle,
        requireBackendAccess: requireBackendAccess,
        ensureGmailAccessToken: ensureGmailAccessToken,
        readStoredGmailAccessToken: readStoredGmailAccessToken,
        clearStoredGmailAccessToken: clearStoredGmailAccessToken,
        signOutStaff: signOutStaff,
        getPostLoginRedirectUrl: getPostLoginRedirectUrl,
    };
})(window);
