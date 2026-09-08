/**
 * Standalone TBS Alaska guest registration (always open; no home chrome).
 * Submits to the same Cloud Function as the Zermatt home form.
 */
(function () {
    const FIREBASE_PROJECT_ID = 'tbs-app-e2062';
    const DEFAULT_EVENT = 'TBS Alaska';

    function isRegistrationFormReady(form) {
        if (!form) return false;
        const fieldValue = (selector) => String(form.querySelector(selector)?.value || '').trim();

        if (!fieldValue('#reg-first-name')) return false;
        if (!fieldValue('#reg-last-name')) return false;

        const email = fieldValue('#reg-email');
        const confirmEmail = fieldValue('#reg-email-confirm');
        if (!email || !confirmEmail || email !== confirmEmail) return false;

        if (!fieldValue('#reg-city-region')) return false;
        if (!fieldValue('#reg-country')) return false;
        if (!fieldValue('#reg-employer-1')) return false;

        if (!form.querySelector('input[name="baseSpeciality"]:checked')) return false;
        if (!form.querySelector('input[name="trainingLevel"]:checked')) return false;
        if (!form.querySelector('input[name="clinicalContext"]:checked')) return false;
        if (!form.querySelector('input[name="attendedTbsPast"]:checked')) return false;

        return true;
    }

    function registrationSubmitFunctionUrl() {
        if (typeof location !== 'undefined') {
            const host = String(location.hostname || '').toLowerCase();
            if (host === '127.0.0.1' || host === 'localhost') {
                return `${location.origin}/api/submitRegistration`;
            }
        }
        const projectId = String(FIREBASE_PROJECT_ID || '').trim();
        if (!projectId) return '';
        return `https://us-central1-${projectId}.cloudfunctions.net/submitRegistrationHttp`;
    }

    function showRegistrationSubmitSuccess(form) {
        if (!form) return;
        form.dataset.registrationSubmitted = '1';
        form.classList.add('registration-form--submitted');
        const check = form.querySelector('.registration-success-check');
        if (check) {
            check.hidden = false;
            check.setAttribute('aria-hidden', 'false');
        }
        form.querySelectorAll('input, select, textarea, button').forEach((el) => {
            if (el.classList.contains('registration-submit-btn')) return;
            el.disabled = true;
        });
        const submitBtn = form.querySelector('.registration-submit-btn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.setAttribute('aria-disabled', 'true');
        }
    }

    function hideRegistrationSubmitSuccess(form) {
        if (!form) return;
        delete form.dataset.registrationSubmitted;
        form.classList.remove('registration-form--submitted');
        const check = form.querySelector('.registration-success-check');
        if (check) {
            check.hidden = true;
            check.setAttribute('aria-hidden', 'true');
        }
        form.querySelectorAll('input, select, textarea, button').forEach((el) => {
            if (el.classList.contains('registration-submit-btn')) return;
            el.disabled = false;
        });
    }

    function collectRegistrationFormPayload(form) {
        const fieldValue = (selector) => String(form.querySelector(selector)?.value || '').trim();
        const checkedValues = (name) =>
            Array.from(form.querySelectorAll(`input[name="${name}"]:checked`))
                .map((el) => String(el.value || '').trim())
                .filter(Boolean);
        const training = form.querySelector('input[name="trainingLevel"]:checked');
        const pastTbs = form.querySelector('input[name="attendedTbsPast"]:checked');
        const event =
            String(form.dataset.registrationEvent || '').trim() || DEFAULT_EVENT;
        return {
            event,
            firstName: fieldValue('#reg-first-name'),
            lastName: fieldValue('#reg-last-name'),
            email: fieldValue('#reg-email'),
            emailConfirm: fieldValue('#reg-email-confirm'),
            cityRegion: fieldValue('#reg-city-region'),
            country: fieldValue('#reg-country'),
            employer1: fieldValue('#reg-employer-1'),
            employer2: fieldValue('#reg-emplyer-2'),
            baseSpeciality: checkedValues('baseSpeciality'),
            trainingLevel: training ? String(training.value || '').trim() : '',
            clinicalContext: checkedValues('clinicalContext'),
            veryBriefBio: fieldValue('#reg-very-brief-bio'),
            pastTbs: pastTbs ? String(pastTbs.value || '').trim() : ''
        };
    }

    function setupAlaskaGuestRegistrationForm() {
        const form = document.querySelector('.alaska-guest-register .registration-form');
        if (!form) return;
        const submitBtn = form.querySelector('.registration-submit-btn');
        const statusEl = form.querySelector('.registration-smallprint');
        const emailInput = form.querySelector('#reg-email');
        const confirmInput = form.querySelector('#reg-email-confirm');
        if (!submitBtn) return;

        form.dataset.registrationOpen = '1';

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!isRegistrationFormReady(form) || submitBtn.disabled) return;

            const fnUrl = registrationSubmitFunctionUrl();
            if (!fnUrl) {
                if (statusEl) {
                    statusEl.textContent =
                        'Registration is unavailable (missing project configuration).';
                }
                return;
            }

            const payload = collectRegistrationFormPayload(form);
            const prevLabel = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.setAttribute('aria-disabled', 'true');
            submitBtn.textContent = 'Submitting…';
            if (statusEl) statusEl.textContent = 'Sending your application…';

            try {
                const res = await fetch(fnUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const msg =
                        data && data.error
                            ? String(data.error)
                            : `Registration failed (${res.status}).`;
                    throw new Error(msg);
                }
                form.reset();
                showRegistrationSubmitSuccess(form);
                if (statusEl) {
                    statusEl.textContent =
                        'Thank you — your application has been received. We will be in touch shortly.';
                }
            } catch (err) {
                hideRegistrationSubmitSuccess(form);
                const msg = err instanceof Error ? err.message : 'Registration could not be sent.';
                if (statusEl) statusEl.textContent = msg;
                submitBtn.textContent = prevLabel;
                syncRegistrationFormState();
            } finally {
                if (form.dataset.registrationSubmitted !== '1') {
                    submitBtn.textContent = prevLabel;
                }
            }
        });

        const syncRegistrationFormState = () => {
            const email = String(emailInput?.value || '').trim();
            const confirmEmail = String(confirmInput?.value || '').trim();
            const emailsFilled = email !== '' && confirmEmail !== '';
            const emailsMatch = emailsFilled && email === confirmEmail;
            const showEmailMismatch = emailsFilled && !emailsMatch;

            if (confirmInput) {
                confirmInput.classList.toggle('registration-email-mismatch', showEmailMismatch);
                if (showEmailMismatch) {
                    confirmInput.setCustomValidity('Email addresses must match.');
                } else {
                    confirmInput.setCustomValidity('');
                }
            }

            if (form.dataset.registrationSubmitted === '1') {
                submitBtn.disabled = true;
                submitBtn.setAttribute('aria-disabled', 'true');
                return;
            }

            const ready = isRegistrationFormReady(form);
            submitBtn.disabled = !ready;
            submitBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
        };

        form.addEventListener('input', syncRegistrationFormState);
        form.addEventListener('change', syncRegistrationFormState);
        syncRegistrationFormState();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupAlaskaGuestRegistrationForm);
    } else {
        setupAlaskaGuestRegistrationForm();
    }
})();
