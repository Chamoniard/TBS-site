// Authentication JavaScript
document.addEventListener('DOMContentLoaded', function() {
    // Initialize form elements
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const loginFormElement = document.getElementById('loginFormElement');
    const registerFormElement = document.getElementById('registerFormElement');

    // Form switching functions
    window.showRegisterForm = function() {
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
    };

    window.showLoginForm = function() {
        registerForm.style.display = 'none';
        loginForm.style.display = 'block';
    };

    // Login form submission
    loginFormElement.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        const rememberMe = document.getElementById('rememberMe').checked;

        // Basic validation
        if (!email || !password) {
            showMessage('Please fill in all fields', 'error');
            return;
        }

        if (!isValidEmail(email)) {
            showMessage('Please enter a valid email address', 'error');
            return;
        }

        // Show loading state
        const submitBtn = loginFormElement.querySelector('.btn-primary');
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Signing In...';
        submitBtn.disabled = true;

        // Simulate login process (replace with actual authentication)
        setTimeout(() => {
            // For demo purposes - in real app, this would call your auth service
            if (email === 'demo@tbszermatt.com' && password === 'demo123') {
                showMessage('Login successful! Redirecting...', 'success');
                
                // Store user session (basic example)
                const userData = {
                    email: email,
                    name: 'Demo User',
                    loginTime: new Date().toISOString()
                };
                
                if (rememberMe) {
                    localStorage.setItem('tbsUser', JSON.stringify(userData));
                } else {
                    sessionStorage.setItem('tbsUser', JSON.stringify(userData));
                }

                // Redirect to main page
                setTimeout(() => {
                    window.location.href = 'index.html';
                }, 1500);
            } else {
                showMessage('Invalid email or password', 'error');
            }

            // Reset button
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
        }, 1000);
    });

    // Registration form submission
    registerFormElement.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const name = document.getElementById('registerName').value;
        const email = document.getElementById('registerEmail').value;
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;

        // Validation
        if (!name || !email || !password || !confirmPassword) {
            showMessage('Please fill in all fields', 'error');
            return;
        }

        if (!isValidEmail(email)) {
            showMessage('Please enter a valid email address', 'error');
            return;
        }

        if (password.length < 6) {
            showMessage('Password must be at least 6 characters long', 'error');
            return;
        }

        if (password !== confirmPassword) {
            showMessage('Passwords do not match', 'error');
            return;
        }


        // Show loading state
        const submitBtn = registerFormElement.querySelector('.btn-primary');
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Creating Account...';
        submitBtn.disabled = true;

        // Simulate registration process (replace with actual registration)
        setTimeout(() => {
            // For demo purposes - in real app, this would call your registration service
            showMessage('Account created successfully! Please sign in.', 'success');
            
            // Clear form
            registerFormElement.reset();
            
            // Switch to login form
            setTimeout(() => {
                showLoginForm();
            }, 1500);

            // Reset button
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
        }, 1000);
    });

    // Check if user is already logged in
    checkAuthStatus();
});

// Utility functions
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function showMessage(message, type) {
    // Remove existing messages
    const existingMessage = document.querySelector('.auth-message');
    if (existingMessage) {
        existingMessage.remove();
    }

    // Create new message
    const messageDiv = document.createElement('div');
    messageDiv.className = `auth-message auth-message-${type}`;
    messageDiv.textContent = message;
    
    // Add styles
    messageDiv.style.cssText = `
        padding: 1rem;
        margin: 1rem 0;
        border-radius: 8px;
        text-align: center;
        font-weight: 500;
        animation: slideIn 0.3s ease-out;
        ${type === 'success' ? 
            'background: #dcfce7; color: #166534; border: 1px solid #bbf7d0;' : 
            'background: #fef2f2; color: #dc2626; border: 1px solid #fecaca;'
        }
    `;

    // Insert message
    const authContainer = document.querySelector('.auth-container');
    const authForm = document.querySelector('.auth-form:not([style*="display: none"])');
    authForm.insertBefore(messageDiv, authForm.firstChild);

    // Auto remove after 5 seconds
    setTimeout(() => {
        if (messageDiv.parentNode) {
            messageDiv.remove();
        }
    }, 5000);
}

function checkAuthStatus() {
    // Check if user is already logged in
    const userData = localStorage.getItem('tbsUser') || sessionStorage.getItem('tbsUser');
    
    if (userData) {
        try {
            const user = JSON.parse(userData);
            showMessage(`Welcome back, ${user.name}! Redirecting to main page...`, 'success');
            
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 2000);
        } catch (e) {
            // Invalid user data, clear it
            localStorage.removeItem('tbsUser');
            sessionStorage.removeItem('tbsUser');
        }
    }
}

// Add CSS for message animation
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            opacity: 0;
            transform: translateY(-10px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
`;
document.head.appendChild(style);
