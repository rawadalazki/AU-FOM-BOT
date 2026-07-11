document.addEventListener('DOMContentLoaded', async () => {
  // Check if already logged in
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      window.location.href = '/';
      return;
    }
  } catch(e) {}

  const loginForm = document.getElementById('loginForm');
  const alertBox = document.getElementById('alertBox');
  const loginBtn = document.getElementById('loginBtn');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    alertBox.classList.add('d-none');
    loginBtn.disabled = true;
    loginBtn.textContent = 'Logging in...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      
      if (res.ok && data.ok) {
        window.location.href = '/';
      } else {
        alertBox.textContent = data.error || 'Login failed';
        alertBox.classList.remove('d-none');
      }
    } catch (err) {
      alertBox.textContent = 'Network error. Please try again.';
      alertBox.classList.remove('d-none');
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }
  });
});
