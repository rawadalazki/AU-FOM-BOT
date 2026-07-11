let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Check auth
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/login.html';
      return;
    }
    currentUser = await res.json();
    document.getElementById('currentUserDisplay').textContent = currentUser.username;
    if (currentUser.role !== 'SUPER_ADMIN' && currentUser.role !== 'OWNER') {
      window.location.href = '/';
      return;
    }
    
    // Hide 'Add Admin' if regular SUPER_ADMIN
    if (currentUser.role === 'SUPER_ADMIN' && !currentUser.is_deputy_owner) {
      const addBtn = document.querySelector('button[data-bs-target="#addAdminModal"]');
      if (addBtn) addBtn.style.display = 'none';
    }
  } catch(e) {
    window.location.href = '/login.html';
    return;
  }

  loadAdmins();

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  document.getElementById('saveAdminBtn').addEventListener('click', createAdmin);
  document.getElementById('confirmResetBtn').addEventListener('click', resetPassword);
});

async function loadAdmins() {
  try {
    const res = await fetch('/api/superadmin/users');
    if (!res.ok) throw new Error('Failed to load users');
    const users = await res.json();
    
    const tbody = document.getElementById('adminsTableBody');
    tbody.innerHTML = '';
    
    users.forEach(user => {
      const tr = document.createElement('tr');
      const isMe = user.username === currentUser.username;
      
      let roleBadge = '';
      if (user.role === 'OWNER') {
        roleBadge = '<span class="badge bg-danger">OWNER</span>';
      } else if (user.is_deputy_owner) {
        roleBadge = '<span class="badge bg-warning text-dark">Deputy Owner</span>';
      } else {
        roleBadge = '<span class="badge bg-secondary">Super Admin</span>';
      }

      // canManage logic
      let canManage = false;
      if (currentUser.role === 'OWNER' && user.role !== 'OWNER') {
        canManage = true;
      } else if (currentUser.is_deputy_owner && user.role === 'SUPER_ADMIN' && !user.is_deputy_owner) {
        canManage = true;
      }

      let actionsHtml = '';
      if (canManage) {
        actionsHtml = `
          <button class="btn btn-sm btn-outline-warning btn-reset" data-id="${user.id}" data-username="${user.username}">
            <i class="bi bi-key"></i> Reset
          </button>
        `;
        if (currentUser.role === 'OWNER' && user.role === 'SUPER_ADMIN') {
          const depAction = user.is_deputy_owner ? 'Remove Deputy' : 'Make Deputy';
          const depClass = user.is_deputy_owner ? 'btn-outline-danger' : 'btn-outline-info';
          actionsHtml += `
            <button class="btn btn-sm ${depClass} btn-deputy ms-1" data-id="${user.id}" data-deputy="${!user.is_deputy_owner}">
              ${depAction}
            </button>
          `;
        }
      }
      
      tr.innerHTML = `
        <td>${user.username} ${isMe ? '<span class="badge bg-primary ms-1">You</span>' : ''}</td>
        <td>${roleBadge}</td>
        <td>
          <div class="form-check form-switch">
            <input class="form-check-input toggle-status" type="checkbox" role="switch" 
                   data-id="${user.id}" ${user.is_active ? 'checked' : ''} ${!canManage || isMe ? 'disabled' : ''}>
          </div>
        </td>
        <td>${user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'Never'}</td>
        <td>${new Date(user.created_at).toLocaleDateString()}</td>
        <td class="text-end">${actionsHtml}</td>
      `;
      tbody.appendChild(tr);
    });

    // Attach event listeners for dynamically created buttons
    document.querySelectorAll('.toggle-status').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        const id = e.target.getAttribute('data-id');
        const isActive = e.target.checked;
        try {
          const res = await fetch(`/api/superadmin/users/${id}/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isActive })
          });
          if (!res.ok) throw new Error(await res.text());
        } catch(err) {
          alert('Failed to toggle status');
          e.target.checked = !isActive; // Revert
        }
      });
    });

    document.querySelectorAll('.btn-reset').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const btnEl = e.target.closest('button');
        document.getElementById('resetAdminId').value = btnEl.getAttribute('data-id');
        document.getElementById('resetUsernameDisplay').textContent = btnEl.getAttribute('data-username');
        document.getElementById('resetAdminPassword').value = '';
        document.getElementById('resetPasswordError').classList.add('d-none');
        const modal = new bootstrap.Modal(document.getElementById('resetPasswordModal'));
        modal.show();
      });
    });

    document.querySelectorAll('.btn-deputy').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const btnEl = e.target.closest('button');
        const id = btnEl.getAttribute('data-id');
        const makeDeputy = btnEl.getAttribute('data-deputy') === 'true';
        
        if (!confirm(makeDeputy ? 'Promote this user to Deputy Owner?' : 'Remove Deputy Owner status?')) return;
        
        try {
          const res = await fetch(`/api/superadmin/users/${id}/deputy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_deputy_owner: makeDeputy })
          });
          if (!res.ok) throw new Error(await res.text());
          loadAdmins();
        } catch(err) {
          alert('Failed to update deputy status: ' + err.message);
        }
      });
    });

  } catch(e) {
    document.getElementById('alertBox').textContent = e.message;
    document.getElementById('alertBox').classList.remove('d-none');
  }
}

async function createAdmin() {
  const username = document.getElementById('newAdminUsername').value.trim();
  const password = document.getElementById('newAdminPassword').value;
  const errorDiv = document.getElementById('addAdminError');
  const btn = document.getElementById('saveAdminBtn');

  if (!username || !password) {
    errorDiv.textContent = 'All fields are required';
    errorDiv.classList.remove('d-none');
    return;
  }

  errorDiv.classList.add('d-none');
  btn.disabled = true;

  try {
    const res = await fetch('/api/superadmin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    if (!res.ok) {
      let errStr = 'Failed to create admin';
      try {
        const data = await res.json();
        errStr = data.error || errStr;
      } catch (jsonErr) {
        errStr = await res.text();
      }
      throw new Error(errStr);
    }

    if (document.activeElement) document.activeElement.blur();
    bootstrap.Modal.getInstance(document.getElementById('addAdminModal')).hide();
    document.getElementById('newAdminUsername').value = '';
    document.getElementById('newAdminPassword').value = '';
    loadAdmins();
  } catch(e) {
    errorDiv.textContent = e.message;
    errorDiv.classList.remove('d-none');
  } finally {
    btn.disabled = false;
  }
}

async function resetPassword() {
  const id = document.getElementById('resetAdminId').value;
  const password = document.getElementById('resetAdminPassword').value;
  const errorDiv = document.getElementById('resetPasswordError');
  const btn = document.getElementById('confirmResetBtn');

  if (!password) {
    errorDiv.textContent = 'Password is required';
    errorDiv.classList.remove('d-none');
    return;
  }

  errorDiv.classList.add('d-none');
  btn.disabled = true;

  try {
    const res = await fetch(`/api/superadmin/users/${id}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    
    if (!res.ok) {
      let errStr = 'Failed to reset password';
      try {
        const data = await res.json();
        errStr = data.error || errStr;
      } catch (jsonErr) {
        errStr = await res.text();
      }
      throw new Error(errStr);
    }

    if (document.activeElement) document.activeElement.blur();
    bootstrap.Modal.getInstance(document.getElementById('resetPasswordModal')).hide();
    alert('Password reset successfully. User has been logged out.');
  } catch(e) {
    errorDiv.textContent = e.message;
    errorDiv.classList.remove('d-none');
  } finally {
    btn.disabled = false;
  }
}
