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
  document.getElementById('confirmDeleteBtn').addEventListener('click', deleteAdmin);
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
          <button class="btn btn-sm btn-outline-danger btn-delete ms-1" data-id="${user.id}" data-username="${user.username}">
            <i class="bi bi-trash"></i> Delete
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
        const id = e.currentTarget.getAttribute('data-id');
        const username = e.currentTarget.getAttribute('data-username');
        document.getElementById('resetAdminId').value = id;
        document.getElementById('resetUsernameDisplay').textContent = username;
        document.getElementById('resetPasswordError').classList.add('d-none');
        document.getElementById('resetAdminPassword').value = '';
        new bootstrap.Modal(document.getElementById('resetPasswordModal')).show();
      });
    });

    document.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const username = e.currentTarget.getAttribute('data-username');
        document.getElementById('deleteAdminId').value = id;
        document.getElementById('deleteUsernameDisplay').textContent = username;
        document.getElementById('deleteAdminError').classList.add('d-none');
        new bootstrap.Modal(document.getElementById('deleteAdminModal')).show();
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

async function deleteAdmin() {
  const id = document.getElementById('deleteAdminId').value;
  const errorDiv = document.getElementById('deleteAdminError');
  const btn = document.getElementById('confirmDeleteBtn');

  errorDiv.classList.add('d-none');
  btn.disabled = true;

  try {
    const res = await fetch(`/api/superadmin/users/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!res.ok) {
      let errStr = 'Failed to delete admin';
      try {
        const data = await res.json();
        errStr = data.error || errStr;
      } catch (jsonErr) {
        errStr = await res.text();
      }
      throw new Error(errStr);
    }

    if (document.activeElement) document.activeElement.blur();
    bootstrap.Modal.getInstance(document.getElementById('deleteAdminModal')).hide();
    loadAdmins();
  } catch(e) {
    errorDiv.textContent = e.message;
    errorDiv.classList.remove('d-none');
  } finally {
    btn.disabled = false;
  }
}

// --- BACKUPS LOGIC ---
document.addEventListener('DOMContentLoaded', () => {
  const backupsTabBtn = document.getElementById('backups-tab');
  if (backupsTabBtn) {
    const triggerBackupLoad = () => {
      loadBackups();
      loadBackupSettings();
    };
    backupsTabBtn.addEventListener('click', triggerBackupLoad);
    backupsTabBtn.addEventListener('shown.bs.tab', triggerBackupLoad);
  }
  
  const refreshBtn = document.getElementById('refreshBackupsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadBackups);
  
  const createBtn = document.getElementById('createBackupBtn');
  if (createBtn) createBtn.addEventListener('click', createBackup);
  
  const restoreConfirm = document.getElementById('restoreConfirmInput');
  if (restoreConfirm) {
    restoreConfirm.addEventListener('input', (e) => {
      document.getElementById('confirmRestoreBtn').disabled = e.target.value !== 'RESTORE';
    });
  }
  
  const confirmResBtn = document.getElementById('confirmRestoreBtn');
  if (confirmResBtn) confirmResBtn.addEventListener('click', executeRestore);
  
  const confirmDelBtn = document.getElementById('confirmDeleteBackupBtn');
  if (confirmDelBtn) confirmDelBtn.addEventListener('click', executeDeleteBackup);

  const saveSchedBtn = document.getElementById('saveScheduleBtn');
  if (saveSchedBtn) saveSchedBtn.addEventListener('click', saveBackupSchedule);
});

async function loadBackupSettings() {
  if (!currentUser || (currentUser.role !== 'OWNER' && !currentUser.is_deputy_owner)) {
    const schedSelect = document.getElementById('backupScheduleSelect');
    if (schedSelect && schedSelect.parentElement) {
      schedSelect.parentElement.classList.add('d-none');
    }
    return;
  }

  try {
    const res = await fetch('/api/superadmin/settings/backup');
    if (res.ok) {
      const data = await res.json();
      const select = document.getElementById('backupScheduleSelect');
      if (select && data.intervalHours !== undefined) {
        select.value = data.intervalHours.toString();
      }
    }
  } catch(e) {
    console.error('Failed to load backup settings', e);
  }
}

async function saveBackupSchedule() {
  const btn = document.getElementById('saveScheduleBtn');
  const select = document.getElementById('backupScheduleSelect');
  if (!btn || !select) return;

  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

  try {
    const res = await fetch('/api/superadmin/settings/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalHours: select.value })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to save');
    }
    
    btn.innerHTML = '<i class="bi bi-check-lg text-success"></i>';
    setTimeout(() => { btn.innerHTML = originalText; btn.disabled = false; }, 2000);
    loadBackups(); // Refresh the next run time
  } catch(e) {
    alert('Error: ' + e.message);
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function loadBackups() {
  const tbody = document.getElementById('backupsTableBody');
  if (tbody && (!tbody.children || tbody.children.length === 0)) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-3 text-muted">Loading backups...</td></tr>';
  }

  try {
    const res = await fetch('/api/superadmin/backups');
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    
    // Update header
    const statusBadge = document.getElementById('backupConfiguredStatus');
    if (statusBadge) {
      if (data.isConfigured) {
        statusBadge.textContent = 'Storage: Configured';
        statusBadge.className = 'badge bg-success me-3';
      } else {
        statusBadge.textContent = 'Storage: Not Configured';
        statusBadge.className = 'badge bg-danger me-3';
      }
    }
    
    const nextRun = document.getElementById('backupNextRun');
    if (nextRun) {
      if (data.nextScheduledMs) {
        nextRun.textContent = 'Next auto backup: ' + new Date(data.nextScheduledMs).toLocaleString();
      } else {
        nextRun.textContent = 'Auto backup disabled';
      }
    }
    
    if (tbody) tbody.innerHTML = '';
    
    if (!data.backups || data.backups.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center py-3 text-muted">No backups found</td></tr>';
      return;
    }
    
    // Determine permissions
    let canDownloadDelete = currentUser && (currentUser.role === 'OWNER' || currentUser.is_deputy_owner);
    
    data.backups.forEach(b => {
      const isAuto = b.key.includes('-auto-');
      const tr = document.createElement('tr');
      
      let actionsHtml = `
        <button class="btn btn-sm btn-outline-danger btn-restore-backup" data-key="${b.key}" data-date="${new Date(b.createdAt).toLocaleString()}">
          <i class="bi bi-arrow-counterclockwise"></i> Restore
        </button>
      `;
      
      if (canDownloadDelete) {
        actionsHtml += `
          <a href="/api/superadmin/backups/download?key=${encodeURIComponent(b.key)}" class="btn btn-sm btn-outline-primary ms-1" target="_blank" title="Download">
            <i class="bi bi-download"></i>
          </a>
          <button class="btn btn-sm btn-outline-secondary btn-delete-backup ms-1" data-key="${b.key}" data-date="${new Date(b.createdAt).toLocaleString()}" title="Delete">
            <i class="bi bi-trash"></i>
          </button>
        `;
      }
      
      tr.innerHTML = `
        <td>${new Date(b.createdAt).toLocaleString()}</td>
        <td>${isAuto ? '<span class="badge bg-info text-dark">Auto</span>' : '<span class="badge bg-secondary">Manual</span>'}</td>
        <td>${b.sizeHuman}</td>
        <td class="text-end">${actionsHtml}</td>
      `;
      if (tbody) tbody.appendChild(tr);
    });
    
    // Attach listeners
    document.querySelectorAll('.btn-restore-backup').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = e.currentTarget.getAttribute('data-key');
        const date = e.currentTarget.getAttribute('data-date');
        document.getElementById('restoreBackupKey').value = key;
        document.getElementById('restoreBackupDateDisplay').textContent = date;
        document.getElementById('restoreConfirmInput').value = '';
        document.getElementById('confirmRestoreBtn').disabled = true;
        document.getElementById('restoreBackupError').classList.add('d-none');
        new bootstrap.Modal(document.getElementById('restoreBackupModal')).show();
      });
    });
    
    document.querySelectorAll('.btn-delete-backup').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = e.currentTarget.getAttribute('data-key');
        const date = e.currentTarget.getAttribute('data-date');
        document.getElementById('deleteBackupKey').value = key;
        document.getElementById('deleteBackupDateDisplay').textContent = date;
        document.getElementById('deleteBackupError').classList.add('d-none');
        new bootstrap.Modal(document.getElementById('deleteBackupModal')).show();
      });
    });
    
  } catch(e) {
    console.error('Error in loadBackups:', e);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center py-3 text-danger">Error loading backups: ${e.message}</td></tr>`;
    }
  }
}

async function createBackup() {
  const btn = document.getElementById('createBackupBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Creating...';
  
  try {
    const res = await fetch('/api/superadmin/backups/create', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create backup');
    alert('Backup created successfully!');
    loadBackups();
  } catch(e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-plus-circle"></i> Create Manual Backup';
  }
}

async function executeRestore() {
  const key = document.getElementById('restoreBackupKey').value;
  const btn = document.getElementById('confirmRestoreBtn');
  const errDiv = document.getElementById('restoreBackupError');
  
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Restoring...';
  errDiv.classList.add('d-none');
  
  try {
    const res = await fetch('/api/superadmin/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Restore failed');
    
    alert('Database restored successfully! All active sessions have been terminated. You will now be redirected to login.');
    window.location.href = '/login.html';
  } catch(e) {
    errDiv.textContent = e.message;
    errDiv.classList.remove('d-none');
    btn.disabled = false;
    btn.textContent = 'Restore Database';
  }
}

async function executeDeleteBackup() {
  const key = document.getElementById('deleteBackupKey').value;
  const btn = document.getElementById('confirmDeleteBackupBtn');
  const errDiv = document.getElementById('deleteBackupError');
  
  btn.disabled = true;
  errDiv.classList.add('d-none');
  
  try {
    const res = await fetch('/api/superadmin/backups?key=' + encodeURIComponent(key), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete backup');
    
    bootstrap.Modal.getInstance(document.getElementById('deleteBackupModal')).hide();
    loadBackups();
  } catch(e) {
    errDiv.textContent = e.message;
    errDiv.classList.remove('d-none');
  } finally {
    btn.disabled = false;
  }
}
