document.addEventListener('DOMContentLoaded', () => {
  // Check role from superadmin.js currentUser
  const checkRole = setInterval(() => {
    if (typeof currentUser !== 'undefined' && currentUser !== null) {
      clearInterval(checkRole);
      if (currentUser.role === 'OWNER' || currentUser.is_deputy_owner) {
        document.getElementById('errorsTabItem').classList.remove('d-none');
        initErrorsDashboard();
      }
    }
  }, 100);
});

let currentFullContext = null;

function initErrorsDashboard() {
  document.getElementById('refreshErrorsBtn').addEventListener('click', loadErrors);
  document.getElementById('errorFilterSeverity').addEventListener('change', loadErrors);
  document.getElementById('errorFilterStatus').addEventListener('change', loadErrors);

  document.getElementById('copyErrJsonBtn').addEventListener('click', () => {
    if (currentFullContext) {
      navigator.clipboard.writeText(JSON.stringify(currentFullContext, null, 2));
      alert('Copied JSON to clipboard');
    }
  });

  document.getElementById('copyErrStackBtn').addEventListener('click', () => {
    const stack = document.getElementById('errStackText')?.innerText || '';
    navigator.clipboard.writeText(stack);
    alert('Copied Stack Trace to clipboard');
  });

  document.getElementById('errExpandAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#errorContextModal .collapse').forEach(c => new bootstrap.Collapse(c, {toggle: false}).show());
  });

  document.getElementById('errCollapseAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#errorContextModal .collapse').forEach(c => new bootstrap.Collapse(c, {toggle: false}).hide());
  });

  document.getElementById('errors-tab').addEventListener('shown.bs.tab', loadErrors);
}

function escapeHtml(unsafe) {
    return (unsafe || '').toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

async function loadErrors() {
  const severity = document.getElementById('errorFilterSeverity').value;
  const status = document.getElementById('errorFilterStatus').value;
  
  const tbody = document.getElementById('errorsTableBody');
  tbody.innerHTML = '<tr><td colspan="8" class="text-center">Loading...</td></tr>';

  try {
    const res = await fetch(`/api/errors?severity=${severity}&status=${status}`);
    if (!res.ok) throw new Error('Failed to fetch errors');
    const { data } = await res.json();
    
    tbody.innerHTML = '';
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No runtime errors found.</td></tr>';
      return;
    }

    data.forEach(err => {
      const tr = document.createElement('tr');
      let sevClass = 'bg-secondary';
      if (err.severity === 'CRITICAL') sevClass = 'bg-danger';
      else if (err.severity === 'ERROR') sevClass = 'bg-warning text-dark';
      else if (err.severity === 'WARNING') sevClass = 'bg-info text-dark';
      
      const badge = `<span class="badge ${sevClass}">${err.severity}</span>`;
      const botStr = err.bot_id || 'N/A';
      const userStr = err.user_telegram_id || 'N/A';
      
      tr.innerHTML = `
        <td>${badge}</td>
        <td>F${err.faculty_id} / ${botStr}</td>
        <td>${userStr} <br><small class="text-muted">${escapeHtml(err.operation)}</small></td>
        <td style="max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(err.error_message)}">${escapeHtml(err.error_message)}</td>
        <td>${err.occurrence_count}</td>
        <td>${new Date(err.last_occurrence).toLocaleString()}</td>
        <td>${err.resolved ? '<span class="text-success"><i class="bi bi-check-circle"></i> Resolved</span>' : '<span class="text-danger"><i class="bi bi-x-circle"></i> Unresolved</span>'}</td>
        <td class="text-end">
           <button class="btn btn-sm btn-outline-primary" onclick="viewErrorContext(${err.id})">View Full Context</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-danger text-center">Error loading data: ${e.message}</td></tr>`;
  }
}

window.viewErrorContext = async function(id) {
  const modal = new bootstrap.Modal(document.getElementById('errorContextModal'));
  modal.show();
  
  const body = document.getElementById('errorContextBody');
  body.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-primary" role="status"></div></div>';
  currentFullContext = null;

  try {
    const res = await fetch(`/api/errors/${id}`);
    if (!res.ok) throw new Error('Failed to load full context');
    const err = await res.json();
    const ctx = err.full_context || {};
    currentFullContext = ctx;

    const histStr = (ctx.Last_10_Operations || []).map(h => {
      return `<tr>
        <td>${new Date(h.timestamp).toLocaleTimeString()}</td>
        <td>${escapeHtml(h.type)}</td>
        <td>${escapeHtml(h.op)}</td>
        <td>${escapeHtml(h.admin_state || 'N/A')}</td>
      </tr>`;
    }).join('');

    body.innerHTML = `
      <div class="mb-3 d-flex justify-content-between">
        <div>
           <strong>Resolved Status:</strong> ${err.resolved ? 'Resolved' : 'Unresolved'}
           ${err.resolved && err.resolved_by ? `(by ${err.resolved_by} at ${new Date(err.resolved_at).toLocaleString()})` : ''}
        </div>
        <div>
           <button class="btn btn-sm ${err.resolved ? 'btn-warning' : 'btn-success'}" onclick="toggleResolveError(${err.id}, ${!err.resolved})">
             ${err.resolved ? 'Mark Unresolved' : 'Mark Resolved'}
           </button>
        </div>
      </div>

      <div class="accordion" id="errorAccordion">
        <!-- General Information -->
        <div class="accordion-item">
          <h2 class="accordion-header" id="h-general">
            <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#c-general">
              General Information
            </button>
          </h2>
          <div id="c-general" class="accordion-collapse collapse show">
            <div class="accordion-body">
              <table class="table table-sm table-bordered">
                <tbody>
                  <tr><th>Severity</th><td>${err.severity}</td><th>Faculty</th><td>${err.faculty_id}</td></tr>
                  <tr><th>Bot</th><td>${escapeHtml(err.bot_id)}</td><th>User ID</th><td>${escapeHtml(err.user_telegram_id)}</td></tr>
                  <tr><th>Operation</th><td>${escapeHtml(err.operation)}</td><th>Occurrences</th><td>${err.occurrence_count}</td></tr>
                  <tr><th>First Seen</th><td>${new Date(err.first_occurrence).toLocaleString()}</td><th>Last Seen</th><td>${new Date(err.last_occurrence).toLocaleString()}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        
        <!-- Stack Trace -->
        <div class="accordion-item">
          <h2 class="accordion-header" id="h-stack">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-stack">
              Stack Trace
            </button>
          </h2>
          <div id="c-stack" class="accordion-collapse collapse">
            <div class="accordion-body bg-dark text-light">
              <pre id="errStackText" style="margin:0; white-space:pre-wrap; word-wrap:break-word;">${escapeHtml(err.stack_trace)}</pre>
            </div>
          </div>
        </div>

        <!-- User History -->
        <div class="accordion-item">
          <h2 class="accordion-header" id="h-history">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-history">
              User History (Last 10 Ops)
            </button>
          </h2>
          <div id="c-history" class="accordion-collapse collapse">
            <div class="accordion-body p-0">
               <table class="table table-sm table-striped m-0">
                 <thead><tr><th>Time</th><th>Type</th><th>Operation</th><th>Admin State</th></tr></thead>
                 <tbody>${histStr || '<tr><td colspan="4" class="text-center">No history</td></tr>'}</tbody>
               </table>
            </div>
          </div>
        </div>

        <!-- Server Metrics -->
        <div class="accordion-item">
          <h2 class="accordion-header" id="h-metrics">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-metrics">
              Server Metrics
            </button>
          </h2>
          <div id="c-metrics" class="accordion-collapse collapse">
            <div class="accordion-body">
               <pre class="bg-light p-2 border">${escapeHtml(JSON.stringify(ctx.Server_Info || {}, null, 2))}</pre>
            </div>
          </div>
        </div>

        <!-- Telegram Update -->
        <div class="accordion-item">
          <h2 class="accordion-header" id="h-tg">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-tg">
              Telegram Update Payload
            </button>
          </h2>
          <div id="c-tg" class="accordion-collapse collapse">
            <div class="accordion-body">
               ${ctx.Telegram_Update ? `<pre class="bg-light p-2 border" style="white-space:pre-wrap; word-wrap:break-word;">${escapeHtml(JSON.stringify(ctx.Telegram_Update, null, 2))}</pre>` : 'No Telegram Update Available'}
            </div>
          </div>
        </div>

        <!-- HTTP Request -->
        <div class="accordion-item">
          <h2 class="accordion-header" id="h-http">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-http">
              HTTP Request Payload
            </button>
          </h2>
          <div id="c-http" class="accordion-collapse collapse">
            <div class="accordion-body">
               ${ctx.HTTP_Request ? `<pre class="bg-light p-2 border" style="white-space:pre-wrap; word-wrap:break-word;">${escapeHtml(JSON.stringify(ctx.HTTP_Request, null, 2))}</pre>` : 'No HTTP Request Available'}
            </div>
          </div>
        </div>

        <!-- Full Context JSON -->
        <div class="accordion-item">
          <h2 class="accordion-header" id="h-json">
            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-json">
              Raw Full Context (JSONB)
            </button>
          </h2>
          <div id="c-json" class="accordion-collapse collapse">
            <div class="accordion-body">
               <pre class="bg-dark text-light p-2 border" style="white-space:pre-wrap; word-wrap:break-word;">${escapeHtml(JSON.stringify(ctx, null, 2))}</pre>
            </div>
          </div>
        </div>

      </div>
    `;
  } catch (e) {
    body.innerHTML = `<div class="alert alert-danger">Error loading context: ${e.message}</div>`;
  }
};

window.toggleResolveError = async function(id, resolveStatus) {
  try {
    const res = await fetch(`/api/errors/${id}/resolve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: resolveStatus })
    });
    if (!res.ok) throw new Error('Failed to update resolution status');
    
    // Refresh modal and list
    viewErrorContext(id);
    loadErrors();
  } catch (e) {
    alert(e.message);
  }
};
