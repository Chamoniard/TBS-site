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

    const gate = document.createElement('div');
    gate.id = 'backend-auth-gate';
    gate.className = 'backend-auth-gate';
    gate.setAttribute('role', 'status');
    gate.setAttribute('aria-live', 'polite');
    gate.innerHTML = '<p class="backend-auth-gate__text">Checking Google sign-in…</p>';
    document.body.insertBefore(gate, document.body.firstChild);

    window.__backendAuthReady = TbsAuth.requireBackendAccess()
        .then(function (result) {
            document.documentElement.classList.remove('backend-auth-checking');
            document.documentElement.classList.add('backend-auth-ready');
            if (gate.parentNode) gate.parentNode.removeChild(gate);
            window.__backendAuthUser = result && result.user ? result.user : null;
            return result;
        })
        .catch(function (err) {
            console.error('Backend auth failed:', err);
            if (gate.querySelector('.backend-auth-gate__text')) {
                gate.querySelector('.backend-auth-gate__text').textContent =
                    err && err.message ? err.message : 'Sign-in required.';
            }
            throw err;
        });

    window.getBackendGmailAccessToken = function (options) {
        return TbsAuth.ensureGmailAccessToken(options || {});
    };
})();
