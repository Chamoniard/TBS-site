/**
 * Backend page: require Google sign-in before boot; expose Gmail token helper.
 */
(function () {
    'use strict';

    if (typeof TbsAuth === 'undefined') {
        console.error('backend-auth.js requires auth-common.js');
        return;
    }

    document.documentElement.classList.add('backend-auth-checking');

    var loadingScreen = document.getElementById('backend-loading-screen');
    if (loadingScreen) {
        loadingScreen.setAttribute('aria-label', 'Checking Google sign-in');
    }

    window.__backendAuthReady = TbsAuth.requireBackendAccess()
        .then(function (result) {
            document.documentElement.classList.remove('backend-auth-checking');
            document.documentElement.classList.add('backend-auth-ready');
            if (loadingScreen) {
                loadingScreen.setAttribute('aria-label', 'Loading backend');
            }
            window.__backendAuthUser = result && result.user ? result.user : null;
            return result;
        })
        .catch(function (err) {
            console.error('Backend auth failed:', err);
            if (loadingScreen) {
                loadingScreen.setAttribute('aria-label', err && err.message ? err.message : 'Sign-in required.');
            }
            throw err;
        });

    window.getBackendGmailAccessToken = function (options) {
        return TbsAuth.ensureGmailAccessToken(options || {});
    };
})();
