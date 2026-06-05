/**
 * Staff login page — Firebase Google sign-in (includes Gmail scope for backend).
 */
document.addEventListener('DOMContentLoaded', function () {
    const signInBtn = document.getElementById('googleSignInBtn');
    const messageEl = document.getElementById('authMessage');
    const noticeEl = document.getElementById('authNotice');

    if (typeof TbsAuth === 'undefined') {
        showAuthMessage('Auth configuration failed to load.', 'error');
        return;
    }

    if (noticeEl) {
        noticeEl.textContent = 'Sign in with your approved TBS Google account to open the backend.';
        noticeEl.classList.remove('auth-notice');
        noticeEl.classList.add('auth-notice', 'auth-notice--info');
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
                msg =
                    'This page URL is not authorized in Firebase. Use http://localhost:8080/ (not 127.0.0.1 or file://). In Firebase Console → Authentication → Settings → Authorized domains, add localhost and 127.0.0.1 if needed.';
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
