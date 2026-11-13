/**
 * Shared Firebase Google Auth for staff login and backend.
 */
(function (global) {
    'use strict';

    const LOGIN_URL = 'login.html';
    const BACKEND_URL = 'backend.html';

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

    function getFirestore() {
        initFirebaseApp();
        if (!firebase.firestore) {
            throw new Error('Firebase Firestore SDK not loaded.');
        }
        return firebase.firestore();
    }

    function tbsBackendUsersCollectionRef() {
        return getFirestore().collection('tbs').doc('Users').collection('backend_users');
    }

    /**
     * Document `tbs/Users/backend_users/{email}` (tries the signed-in email, then lowercase).
     */
    async function fetchBackendUserRecord(email) {
        var want = String(email || '').trim();
        if (!want) return null;
        var col = tbsBackendUsersCollectionRef();
        var snap = await col.doc(want).get();
        if (snap.exists) return snap.data() || {};
        var lower = want.toLowerCase();
        if (lower !== want) {
            snap = await col.doc(lower).get();
            if (snap.exists) return snap.data() || {};
        }
        return null;
    }

    function createGoogleProvider() {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        return provider;
    }

    function isGoogleSignedInUser(user) {
        if (!user || !user.email) return false;
        const providers = Array.isArray(user.providerData) ? user.providerData : [];
        return providers.some(function (p) {
            return p && p.providerId === 'google.com';
        });
    }

    /** Google account with an email. Listing in backend_users is checked separately. */
    function isAllowedBackendUser(user) {
        return isGoogleSignedInUser(user);
    }

    async function isListedBackendUser(email) {
        var rec = await fetchBackendUserRecord(email);
        return !!rec;
    }

    async function assertListedBackendUser(user) {
        if (!isGoogleSignedInUser(user)) return false;
        return isListedBackendUser(user.email);
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
            return { user: null, skipped: true };
        }
        const auth = getAuth();
        const provider = createGoogleProvider();
        const result = await auth.signInWithPopup(provider);
        const user = result && result.user ? result.user : null;
        if (!isGoogleSignedInUser(user)) {
            await auth.signOut();
            throw new Error('This Google account is not authorized for the TBS backend.');
        }
        var listed = false;
        try {
            listed = await isListedBackendUser(user.email);
        } catch (lookupErr) {
            await auth.signOut();
            throw new Error(
                lookupErr && lookupErr.message
                    ? lookupErr.message
                    : 'Could not verify backend user access.'
            );
        }
        if (!listed) {
            await auth.signOut();
            throw new Error('This Google account is not authorized for the TBS backend.');
        }
        return { user: user, skipped: false };
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
        if (!user || !isGoogleSignedInUser(user)) {
            redirectToLogin();
            return new Promise(function () {});
        }
        var listed = false;
        try {
            listed = await isListedBackendUser(user.email);
        } catch (lookupErr) {
            console.error('Backend user lookup failed:', lookupErr);
            try {
                await auth.signOut();
            } catch (e) {
                /* ignore */
            }
            redirectToLogin();
            return new Promise(function () {});
        }
        if (!listed) {
            try {
                await auth.signOut();
            } catch (e) {
                /* ignore */
            }
            redirectToLogin();
            return new Promise(function () {});
        }
        return { user: user, skipped: false };
    }

    async function signOutStaff() {
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
        GOOGLE_AUTH_SKIP_ON_LOCALHOST: GOOGLE_AUTH_SKIP_ON_LOCALHOST,
        firebaseConfig: firebaseConfig,
        isLocalhost: isLocalhost,
        shouldSkipGoogleAuth: shouldSkipGoogleAuth,
        initFirebaseApp: initFirebaseApp,
        getAuth: getAuth,
        getFirestore: getFirestore,
        fetchBackendUserRecord: fetchBackendUserRecord,
        isAllowedBackendUser: isAllowedBackendUser,
        isListedBackendUser: isListedBackendUser,
        assertListedBackendUser: assertListedBackendUser,
        signInWithGoogle: signInWithGoogle,
        requireBackendAccess: requireBackendAccess,
        signOutStaff: signOutStaff,
        getPostLoginRedirectUrl: getPostLoginRedirectUrl,
    };
})(window);
