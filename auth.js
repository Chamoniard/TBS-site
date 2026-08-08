/**
 * Staff login page — Firebase Google sign-in (includes Gmail scope for backend).
 */
document.addEventListener('DOMContentLoaded', function () {
    const signInBtn = document.getElementById('googleSignInBtn');
    const messageEl = document.getElementById('authMessage');

    if (typeof TbsAuth === 'undefined') {
        showAuthMessage('Auth configuration failed to load.', 'error');
        return;
    }

    if (signInBtn) {
        signInBtn.classList.remove('auth-google-btn--inactive');
        signInBtn.removeAttribute('aria-disabled');
        signInBtn.addEventListener('click', handleGoogleSignIn);
    }

    try {
        TbsAuth.initFirebaseApp();
        TbsAuth.getAuth().onAuthStateChanged(function (user) {
            if (!user || !TbsAuth.isAllowedBackendUser(user)) return;
            if (TbsAuth.shouldSkipGoogleAuth()) return;
            window.location.replace(TbsAuth.getPostLoginRedirectUrl());
        });
    } catch (err) {
        console.error(err);
        showAuthMessage(err.message || 'Firebase Auth could not start.', 'error');
    }

    async function handleGoogleSignIn() {
        if (!signInBtn) return;
        signInBtn.disabled = true;
        showAuthMessage('Opening Google sign-in…', 'info');
        try {
            if (TbsAuth.shouldSkipGoogleAuth()) {
                window.location.href = TbsAuth.getPostLoginRedirectUrl();
                return;
            }
            await TbsAuth.signInWithGoogle();
            showAuthMessage('Signed in. Opening backend…', 'success');
            window.setTimeout(function () {
                window.location.replace(TbsAuth.getPostLoginRedirectUrl());
            }, 400);
        } catch (err) {
            console.error(err);
            var msg = err && err.message ? err.message : 'Google sign-in failed.';
            if (err && err.code === 'auth/unauthorized-domain') {
                var host = window.location && window.location.hostname ? window.location.hostname : 'this site';
                msg =
                    'This page URL is not authorized in Firebase (' + host + '). Add it under Firebase Console → Authentication → Settings → Authorized domains.';
                if (host === 'localhost' || host === '127.0.0.1') {
                    msg += ' For local dev, use http://localhost:8080/ (not file://).';
                } else if (host.indexOf('www.') === 0) {
                    msg += ' If you use both www and non-www, add ' + host.slice(4) + ' as well.';
                } else if (host.indexOf('.') !== -1 && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
                    msg += ' If you use both www and non-www, add www.' + host + ' as well.';
                }
            }
            showAuthMessage(msg, 'error');
            signInBtn.disabled = false;
        }
    }

    function showAuthMessage(text, type) {
        if (!messageEl) return;
        messageEl.hidden = false;
        messageEl.textContent = text;
        messageEl.className = 'auth-message auth-message--' + (type || 'info');
    }
});
