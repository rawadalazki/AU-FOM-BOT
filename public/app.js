// Dashboard State variables
let currentUser = null;
let currentLang = 'en';
let facultiesList = [];
let activeFaculty = null;
let activeTab = 'tab-menus';
let activeMenuNode = null;
let menuTreeData = [];

// Localization dictionaries
const i18n = {
  en: {
    tagline: 'Multilingual Faculty Bot Manager',
    demo_widget: 'Open Web Chatbot Demo',
    faculties_title: 'Faculty Bots',
    new_faculty_btn: '+ Create New',
    select_bot_title: 'Welcome to UniBot Hub',
    select_bot_desc: 'Select a faculty bot from the sidebar to customize menus, upload files, broadcast announcements, or duplicate it.',
    duplicate_btn: 'Duplicate Bot',
    delete_btn: 'Delete Bot',
    telegram_token_label: 'Telegram Bot Token',
    save_connect_btn: 'Save & Connect',
    status_offline: 'Status: Offline',
    tab_menu_builder: 'Interactive Menu Builder',
    tab_announcements: 'Broadcast Announcements',
    tab_subscribers: 'Bot Users & Analytics',
    menus_list_title: 'Menu Hierarchy',
    add_root_menu: '+ Add Root Button',
    edit_menu_title: 'Edit Menu Option',
    parent_label: 'Parent Menu:',
    button_title_en: 'Button Title (English)',
    button_title_ar: 'Button Title (Arabic)',
    sort_order: 'Sort Order (Lower numbers show first)',
    action_type: 'Action / Reply Type',
    opt_submenu: 'Submenu (Triggers nested options)',
    opt_text: 'Text Reply (Sends dynamic message)',
    opt_file: 'Document Download (Attaches file upload)',
    reply_content_en: 'Reply Content (English)',
    reply_content_ar: 'Reply Content (Arabic)',
    file_upload_label: 'Attach Document (PDF, Word, Images)',
    current_file: 'Current File:',
    remove_file: 'Remove attachment',
    save_changes: 'Save Changes',
    cancel: 'Cancel',
    new_broadcast_title: 'Create New Broadcast',
    broadcast_help_text: 'This announcement will be instantly sent to all Telegram subscribers and displayed in the Web Chatbot widget feed.',
    ann_title_en: 'Announcement Title (English)',
    ann_title_ar: 'Announcement Title (Arabic)',
    ann_content_en: 'Message Content (English)',
    ann_content_ar: 'Message Content (Arabic)',
    ann_file_label: 'Optional Attachment File (e.g. PDF Results sheet)',
    btn_broadcast: '📢 Broadcast Now',
    broadcast_history_title: 'Broadcast History',
    total_users: 'Total Bot Users',
    telegram_users: 'Telegram Subscribers',
    web_users: 'Web Chatbot Sessions',
    subscribers_list_title: 'Subscriber Registry',
    tbl_platform: 'Platform',
    tbl_chat_id: 'Chat / Session ID',
    tbl_username: 'Username',
    tbl_language: 'Language',
    tbl_joined: 'Joined At',
    modal_new_faculty_title: 'Create New Faculty Bot',
    fac_name_en: 'Faculty Name (English)',
    fac_name_ar: 'Faculty Name (Arabic)',
    fac_slug: 'Unique Short Identifier / URL Slug',
    slug_help: 'This is used in the chatbot widget tag.',
    btn_save: 'Save Bot',
    btn_cancel: 'Cancel',
    modal_duplicate_title: 'Duplicate Bot Configuration',
    duplicate_source_label: 'Source Bot:',
    new_fac_name_en: 'New Faculty Name (English)',
    new_fac_name_ar: 'New Faculty Name (Arabic)',
    new_fac_slug: 'New URL Slug',
    duplicate_alert: 'ℹ️ This action will copy all custom menus, nested submenus, responses, uploaded files, and announcements from the source bot. User records and Telegram Bot tokens will NOT be copied.',
    btn_confirm_duplicate: 'Duplicate Now'
  },
  ar: {
    tagline: 'إدارة بوتات الكليات متعددة اللغات',
    demo_widget: 'فتح تجربة البوت على الويب',
    faculties_title: 'بوتات الكليات',
    new_faculty_btn: '+ إنشاء جديد',
    select_bot_title: 'مرحباً بك في UniBot Hub',
    select_bot_desc: 'اختر أحد بوتات الكليات من القائمة الجانبية لتخصيص القوائم، رفع الملفات، بث الإعلانات، أو استنساخ البوت.',
    duplicate_btn: 'استنساخ البوت',
    delete_btn: 'حذف البوت',
    telegram_token_label: 'رمز الاتصال الخاص ببوت تيليجرام (Token)',
    save_connect_btn: 'حفظ وتوصيل',
    status_offline: 'الحالة: غير متصل',
    tab_menu_builder: 'منشئ القوائم التفاعلية',
    tab_announcements: 'بث الإعلانات',
    tab_subscribers: 'المستخدمون والإحصائيات',
    menus_list_title: 'هيكلية القوائم',
    add_root_menu: '+ إضافة زر رئيسي',
    edit_menu_title: 'تعديل خيار القائمة',
    parent_label: 'القائمة الأب:',
    button_title_en: 'عنوان الزر (بالإنجليزي)',
    button_title_ar: 'عنوان الزر (بالعربي)',
    sort_order: 'ترتيب الترتيب (الأرقام الأقل تظهر أولاً)',
    action_type: 'نوع الإجراء / الرد',
    opt_submenu: 'قائمة فرعية (تفتح خيارات أخرى)',
    opt_text: 'رد نصي (يرسل رسالة نصية)',
    opt_file: 'تحميل ملف (يرسل مستند مرفق)',
    reply_content_en: 'محتوى الرد (بالإنجليزي)',
    reply_content_ar: 'محتوى الرد (بالعربي)',
    file_upload_label: 'إرفاق ملف (PDF، Word، صور)',
    current_file: 'الملف الحالي:',
    remove_file: 'إزالة الملف المرفق',
    save_changes: 'حفظ التعديلات',
    cancel: 'إلغاء',
    new_broadcast_title: 'إنشاء إعلان جديد للبث',
    broadcast_help_text: 'سيتم إرسال هذا الإعلان فوراً لجميع المشتركين في التيليجرام وعرضه في شريط إعلانات الويب.',
    ann_title_en: 'عنوان الإعلان (بالإنجليزي)',
    ann_title_ar: 'عنوان الإعلان (بالعربي)',
    ann_content_en: 'تفاصيل الرسالة (بالإنجليزي)',
    ann_content_ar: 'تفاصيل الرسالة (بالعربي)',
    ann_file_label: 'ملف مرفق اختياري (مثال: جدول دراسي أو نتائج)',
    btn_broadcast: '📢 بث الإعلان الآن',
    broadcast_history_title: 'سجل الإعلانات المرسلة',
    total_users: 'إجمالي مستخدمي البوت',
    telegram_users: 'مشتركو تيليجرام',
    web_users: 'جلسات الويب',
    subscribers_list_title: 'سجل المشتركين والمستخدمين',
    tbl_platform: 'المنصة',
    tbl_chat_id: 'رقم المحادثة / الجلسة',
    tbl_username: 'اسم المستخدم',
    tbl_language: 'اللغة المحددة',
    tbl_joined: 'تاريخ الانضمام',
    modal_new_faculty_title: 'إنشاء بوت كلية جديد',
    fac_name_en: 'اسم الكلية (بالإنجليزي)',
    fac_name_ar: 'اسم الكلية (بالعربي)',
    fac_slug: 'رمز الكلية الفريد (يظهر في الرابط / Slug)',
    slug_help: 'يستخدم هذا الرمز لربط البوت بموقع الويب.',
    btn_save: 'حفظ البوت',
    btn_cancel: 'إلغاء',
    modal_duplicate_title: 'استنساخ إعدادات البوت',
    duplicate_source_label: 'البوت المصدر:',
    new_fac_name_en: 'اسم الكلية الجديد (بالإنجليزي)',
    new_fac_name_ar: 'اسم الكلية الجديد (بالعربي)',
    new_fac_slug: 'الرمز الفريد الجديد (Slug)',
    duplicate_alert: 'ℹ️ ستقوم هذه العملية بنسخ جميع القوائم التفاعلية والردود والملفات المرفوعة والإعلانات السابقة للبوت الجديد. لن يتم نسخ بيانات المستخدمين أو رموز اتصال تيليجرام.',
    btn_confirm_duplicate: 'استنساخ البوت الآن'
  }
};

// ----------------------------------------------------
// Core Initialization
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login.html'; return; }
    currentUser = await res.json();
    if (currentUser.role === 'SUPER_ADMIN' || currentUser.role === 'OWNER') {
      const adminLink = document.getElementById('adminPanelLink');
      if (adminLink) adminLink.classList.remove('d-none');
    }
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login.html';
      });
    }
  } catch(e) {
    window.location.href = '/login.html';
    return;
  }

  setupTranslationToggle();
  setupNavigationTabs();
  loadFaculties();
  setupFormListeners();
  setupModalListeners();
});

// ----------------------------------------------------
// Language Switcher / Translation Engine
// ----------------------------------------------------
function setupTranslationToggle() {
  const switchBtn = document.getElementById('dashboard-lang-btn');
  switchBtn.addEventListener('click', () => {
    const nextLang = currentLang === 'en' ? 'ar' : 'en';
    setDashboardLanguage(nextLang);
  });
  // Default to english
  setDashboardLanguage('en');
}

function setDashboardLanguage(lang) {
  currentLang = lang;
  document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  document.documentElement.setAttribute('lang', lang);
  
  const switchBtn = document.getElementById('dashboard-lang-btn');
  switchBtn.innerText = lang === 'ar' ? 'English (LTR)' : 'العربية (RTL)';

  // Translate all elements with 'data-i18n'
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (i18n[lang][key]) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.placeholder = i18n[lang][key];
      } else {
        el.innerText = i18n[lang][key];
      }
    }
  });

  // Re-render components that have conditional strings
  if (activeFaculty) {
    renderMenuTree();
    updateBotStatusDisplay(activeFaculty);
  }
}

// ----------------------------------------------------
// Navigation Tab logic
// ----------------------------------------------------
function setupNavigationTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      activeTab = btn.getAttribute('data-tab');
      document.getElementById(activeTab).classList.add('active');

      if (activeFaculty) {
        if (activeTab === 'tab-announcements') {
          loadAnnouncements();
        } else if (activeTab === 'tab-subscribers') {
          loadSubscribers();
        }
      }
    });
  });
}

// ----------------------------------------------------
// REST API Core: Load faculties and populate sidebar
// ----------------------------------------------------
async function loadFaculties(selectId = null) {
  const container = document.getElementById('faculty-list-container');
  container.innerHTML = '<div class="loading-spinner"></div>';
  
  try {
    const res = await fetch('/api/faculties');
    facultiesList = await res.json();
    
    container.innerHTML = '';
    if (facultiesList.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:10px; color:var(--text-muted); font-size:13px;">No bot instances found</div>`;
      return;
    }

    facultiesList.forEach(fac => {
      const name = currentLang === 'ar' ? fac.name_ar : fac.name_en;
      
      const item = document.createElement('div');
      item.className = 'faculty-item';
      item.id = `fac-item-${fac.id}`;
      if (activeFaculty && activeFaculty.id === fac.id) {
        item.classList.add('active');
      }

      item.innerHTML = `
        <div class="faculty-item-info">
          <span class="faculty-item-name">${escapeHTML(name)}</span>
          <span class="faculty-item-slug">/${fac.slug}</span>
        </div>
        <div class="faculty-item-actions">
          <button class="btn btn-secondary btn-xs btn-dup" data-id="${fac.id}" title="Duplicate / استنساخ">👥</button>
        </div>
      `;

      // Click to open active faculty workspace
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-dup')) return; // ignore duplicate click
        selectFaculty(fac);
      });

      // Duplicate click
      item.querySelector('.btn-dup').addEventListener('click', (e) => {
        e.stopPropagation();
        openDuplicateModal(fac);
      });

      container.appendChild(item);
    });

    // Auto-select if requested
    if (selectId) {
      const found = facultiesList.find(f => f.id === selectId);
      if (found) selectFaculty(found);
    } else if (activeFaculty) {
      const refreshed = facultiesList.find(f => f.id === activeFaculty.id);
      if (refreshed) {
        selectFaculty(refreshed);
      }
    }
    renderCentralBotsDirectory();
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger); text-align:center; font-size:13px;">Failed to load faculties</div>`;
  }
}

function renderCentralBotsDirectory() {
  const tbody = document.getElementById('central-bots-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';
  
  if (facultiesList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No bot instances registered / لا توجد بوتات مسجلة</td></tr>`;
    return;
  }

  facultiesList.forEach(fac => {
    const name = currentLang === 'ar' ? fac.name_ar : fac.name_en;
    const admins = fac.admin_chat_id ? fac.admin_chat_id.split(',').map(s => s.trim()) : [];
    const centralAdmin = admins.length > 0 ? admins[0] : 'None';
    const subAdmins = admins.length > 1 ? admins.slice(1).join(', ') : 'None';

    // Status styling
    let statusBg = 'rgba(149, 165, 166, 0.15)';
    let statusColor = '#95a5a6';
    let statusText = fac.bot_status || 'Offline';
    if (fac.bot_status === 'Active') {
      statusBg = 'rgba(46, 204, 113, 0.15)';
      statusColor = '#2ecc71';
      statusText = `@${fac.bot_username || 'Bot'}`;
    } else if (fac.bot_status === 'Connecting...') {
      statusBg = 'rgba(241, 196, 15, 0.15)';
      statusColor = '#f1c40f';
    } else if (fac.bot_status === 'Error') {
      statusBg = 'rgba(231, 76, 60, 0.15)';
      statusColor = '#e74c3c';
    }

    const row = document.createElement('tr');
    row.innerHTML = `
      <td style="padding: 12px; border-bottom: 1px solid var(--border-color);"><strong>${escapeHTML(name)}</strong></td>
      <td style="padding: 12px; border-bottom: 1px solid var(--border-color);"><code>/${fac.slug}</code></td>
      <td style="padding: 12px; border-bottom: 1px solid var(--border-color);">
        <span style="background: ${statusBg}; color: ${statusColor}; padding: 4px 8px; border-radius: 4px; font-weight: 500; font-size: 12px; border: 1px solid ${statusBg}; display: inline-block;">
          ${escapeHTML(statusText)}
        </span>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid var(--border-color);"><code style="color: var(--primary-color); font-weight: bold;">${escapeHTML(centralAdmin)}</code></td>
      <td style="padding: 12px; border-bottom: 1px solid var(--border-color);"><span style="font-size: 13px; color: var(--text-muted);">${escapeHTML(subAdmins)}</span></td>
    `;
    tbody.appendChild(row);
  });
}

function selectFaculty(faculty) {
  activeFaculty = faculty;
  
  // Highlight sidebar item
  document.querySelectorAll('.faculty-item').forEach(el => el.classList.remove('active'));
  const activeItem = document.getElementById(`fac-item-${faculty.id}`);
  if (activeItem) activeItem.classList.add('active');

  // Toggle workspace display states
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('editor-state').style.display = 'flex';

  // Populate active settings
  document.getElementById('active-faculty-name').innerText = currentLang === 'ar' ? faculty.name_ar : faculty.name_en;
  document.getElementById('active-faculty-slug').innerText = `Slug / المعرف: ${faculty.slug}`;
  document.getElementById('telegram-token-input').value = faculty.telegram_token || '';
  document.getElementById('telegram-admin-chat-input').value = faculty.admin_chat_id || '';
  document.getElementById('telegram-welcome-en').value = faculty.welcome_en || '';
  document.getElementById('telegram-welcome-ar').value = faculty.welcome_ar || '';
  document.getElementById('telegram-bot-enabled').checked = faculty.bot_enabled !== 0;
  document.getElementById('telegram-disabled-ar').value = faculty.disabled_message_ar || '';
  document.getElementById('telegram-disabled-en').value = faculty.disabled_message_en || '';
  document.getElementById('telegram-api-server').value = faculty.telegram_api_server || 'api.telegram.org';

  updateBotStatusDisplay(faculty);

  // Load active tab data
  loadMenusTree();
  if (activeTab === 'tab-announcements') {
    loadAnnouncements();
  } else if (activeTab === 'tab-subscribers') {
    loadSubscribers();
  }

  // Pre-configure demo widget target
  const demoLink = document.querySelector('.demo-widget-link');
  demoLink.href = `/widget/chatbot.html?faculty=${faculty.slug}`;
}

function updateBotStatusDisplay(faculty) {
  const dot = document.querySelector('.token-status-indicator .status-dot');
  const textEl = document.querySelector('.token-status-indicator .status-text');

  dot.className = 'status-dot';
  
  let statusText = '';
  switch (faculty.bot_status) {
    case 'Active':
      dot.classList.add('status-active');
      statusText = currentLang === 'ar' 
        ? `متصل نشط (@${faculty.bot_username})` 
        : `Connected (@${faculty.bot_username})`;
      break;
    case 'Connecting...':
      dot.classList.add('status-connecting');
      statusText = currentLang === 'ar' ? 'جاري الاتصال...' : 'Connecting...';
      break;
    case 'Error':
      dot.classList.add('status-error');
      statusText = (currentLang === 'ar' ? 'خطأ في التوصيل: ' : 'Error: ') + (faculty.bot_error || 'Invalid Token');
      break;
    default:
      dot.classList.add('status-offline');
      statusText = currentLang === 'ar' ? 'غير متصل' : 'Offline';
  }
  
  textEl.innerText = (currentLang === 'ar' ? 'حالة البوت: ' : 'Status: ') + statusText;
}

// ----------------------------------------------------
// Forms Listeners: Token submission, Faculty CRUD
// ----------------------------------------------------
function setupFormListeners() {
  // 1. Save Telegram Token
  const tokenForm = document.getElementById('telegram-token-form');
  tokenForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeFaculty) return;

    const token = document.getElementById('telegram-token-input').value.trim();
    const adminChatId = document.getElementById('telegram-admin-chat-input').value.trim();
    const welcomeEn = document.getElementById('telegram-welcome-en').value.trim();
    const welcomeAr = document.getElementById('telegram-welcome-ar').value.trim();
    const botEnabled = document.getElementById('telegram-bot-enabled').checked ? 1 : 0;
    const disabledAr = document.getElementById('telegram-disabled-ar').value.trim();
    const disabledEn = document.getElementById('telegram-disabled-en').value.trim();
    const apiServer = document.getElementById('telegram-api-server').value.trim() || 'api.telegram.org';
    const saveBtn = document.getElementById('btn-save-token');
    saveBtn.disabled = true;
    saveBtn.innerText = currentLang === 'ar' ? 'جاري الحفظ...' : 'Saving...';

    try {
      const res = await fetch(`/api/faculties/${activeFaculty.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name_en: activeFaculty.name_en,
          name_ar: activeFaculty.name_ar,
          slug: activeFaculty.slug,
          telegram_token: token,
          admin_chat_id: adminChatId,
          welcome_en: welcomeEn,
          welcome_ar: welcomeAr,
          bot_enabled: botEnabled,
          disabled_message_en: disabledEn,
          disabled_message_ar: disabledAr,
          telegram_api_server: apiServer
        })
      });

      if (res.ok) {
        // Poll status updates briefly
        setTimeout(() => loadFaculties(activeFaculty.id), 2000);
      } else {
        alert('Failed to save token');
      }
    } catch (err) {
      alert('Error connecting to backend');
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerText = currentLang === 'ar' ? 'حفظ وتوصيل' : 'Save & Connect';
    }
  });

  // 2. Delete Active Bot
  const deleteBtn = document.getElementById('btn-delete-active');
  deleteBtn.addEventListener('click', async () => {
    if (!activeFaculty) return;
    const confirmMsg = currentLang === 'ar' 
      ? 'هل أنت متأكد من حذف هذا البوت بالكامل؟ سيؤدي ذلك لحذف القوائم والإعلانات المرتبطة به!' 
      : 'Are you sure you want to delete this bot? This will permanently delete all menus and announcements associated with it!';
    
    if (confirm(confirmMsg)) {
      try {
        const res = await fetch(`/api/faculties/${activeFaculty.id}`, {
          method: 'DELETE'
        });
        if (res.ok) {
          activeFaculty = null;
          document.getElementById('editor-state').style.display = 'none';
          document.getElementById('empty-state').style.display = 'flex';
          loadFaculties();
        }
      } catch (err) {
        alert('Error deleting faculty');
      }
    }
  });

  // 3. Menu Form submit (Create/Update Menu)
  const menuForm = document.getElementById('menu-item-form');
  menuForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeFaculty) return;

    const id = document.getElementById('menu-item-id').value;
    const parentId = document.getElementById('menu-parent-id').value;
    const titleEn = document.getElementById('menu-title-en').value.trim();
    const titleAr = document.getElementById('menu-title-ar').value.trim();
    const replyType = document.getElementById('menu-reply-type').value;
    const replyContentEn = document.getElementById('menu-content-en').value.trim();
    const replyContentAr = document.getElementById('menu-content-ar').value.trim();
    const sortOrder = document.getElementById('menu-sort-order').value || '0';
    const fileInput = document.getElementById('menu-file-input');
    const removeFile = document.getElementById('menu-remove-file-chk').checked;

    const formData = new FormData();
    formData.append('faculty_id', activeFaculty.id);
    formData.append('parent_id', parentId || 'null');
    formData.append('title_en', titleEn);
    formData.append('title_ar', titleAr);
    formData.append('reply_type', replyType);
    formData.append('reply_content_en', replyContentEn);
    formData.append('reply_content_ar', replyContentAr);
    formData.append('sort_order', sortOrder);
    formData.append('remove_file', removeFile ? 'true' : 'false');
    
    if (fileInput.files.length > 0) {
      formData.append('file', fileInput.files[0]);
    }

    try {
      let res;
      if (id) {
        // Update
        res = await fetch(`/api/menus/${id}`, {
          method: 'PUT',
          body: formData
        });
      } else {
        // Create
        res = await fetch('/api/menus', {
          method: 'POST',
          body: formData
        });
      }

      if (res.ok) {
        document.getElementById('menu-form-card').style.display = 'none';
        menuForm.reset();
        loadMenusTree();
      } else {
        const err = await res.json();
        alert('Error saving menu: ' + err.error);
      }
    } catch (e) {
      alert('Network error saving menu item');
    }
  });

  // Reply Type Conditional Show/Hide
  const replyTypeSelect = document.getElementById('menu-reply-type');
  replyTypeSelect.addEventListener('change', () => {
    updateConditionalFormFields(replyTypeSelect.value);
  });

  document.getElementById('btn-cancel-menu').addEventListener('click', () => {
    document.getElementById('menu-form-card').style.display = 'none';
    document.getElementById('menu-item-form').reset();
  });

  // 4. Announcement Form submit
  const annForm = document.getElementById('announcement-form');
  annForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeFaculty) return;

    const titleEn = document.getElementById('ann-title-en').value.trim();
    const titleAr = document.getElementById('ann-title-ar').value.trim();
    const contentEn = document.getElementById('ann-content-en').value.trim();
    const contentAr = document.getElementById('ann-content-ar').value.trim();
    const fileInput = document.getElementById('ann-file-input');

    const formData = new FormData();
    formData.append('faculty_id', activeFaculty.id);
    formData.append('title_en', titleEn);
    formData.append('title_ar', titleAr);
    formData.append('content_en', contentEn);
    formData.append('content_ar', contentAr);

    if (fileInput.files.length > 0) {
      formData.append('file', fileInput.files[0]);
    }

    const broadcastBtn = annForm.querySelector('button[type="submit"]');
    broadcastBtn.disabled = true;
    broadcastBtn.innerText = currentLang === 'ar' ? 'جاري البث والارسال...' : 'Broadcasting...';

    try {
      const res = await fetch('/api/announcements', {
        method: 'POST',
        body: formData
      });

      if (res.ok) {
        annForm.reset();
        loadAnnouncements();
        alert(currentLang === 'ar' ? 'تم إرسال وبث الإعلان بنجاح!' : 'Announcement broadcasted successfully!');
      } else {
        const err = await res.json();
        alert('Broadcast failed: ' + err.error);
      }
    } catch (e) {
      alert('Error broadcasting announcement');
    } finally {
      broadcastBtn.disabled = false;
      broadcastBtn.innerText = currentLang === 'ar' ? '📢 بث الإعلان الآن' : '📢 Broadcast Now';
    }
  });
}

function updateConditionalFormFields(val) {
  const textFields = document.querySelectorAll('.reply-text-fields');
  const fileFields = document.querySelector('.reply-file-fields');

  if (val === 'submenu') {
    textFields.forEach(el => el.style.display = 'none');
    fileFields.style.display = 'none';
  } else if (val === 'text') {
    textFields.forEach(el => el.style.display = 'block');
    fileFields.style.display = 'none';
  } else if (val === 'file') {
    textFields.forEach(el => el.style.display = 'block');
    fileFields.style.display = 'block';
  }
}

// ----------------------------------------------------
// Menu Tree Building Engine
// ----------------------------------------------------
async function loadMenusTree() {
  if (!activeFaculty) return;
  const treeContainer = document.getElementById('menu-tree');
  treeContainer.innerHTML = '<div class="loading-spinner"></div>';

  try {
    const res = await fetch(`/api/menus?faculty_id=${activeFaculty.id}`);
    menuTreeData = await res.json();
    
    renderMenuTree();
  } catch (e) {
    treeContainer.innerHTML = '<div style="color:var(--danger);">Error loading menus</div>';
  }
}

function renderMenuTree() {
  const treeContainer = document.getElementById('menu-tree');
  treeContainer.innerHTML = '';

  const rootItems = menuTreeData.filter(m => m.parent_id === null);

  if (rootItems.length === 0) {
    treeContainer.innerHTML = `
      <div style="text-align: center; padding: 20px; color: var(--text-muted); font-size: 13.5px;">
        ${currentLang === 'ar' ? 'لا توجد عناصر في القائمة التفاعلية. اضغط على الزر بالأعلى لإضافة زر.' : 'No menu items found. Click above to add a root menu button.'}
      </div>
    `;
    return;
  }

  // Create document fragment for speed
  const fragment = document.createDocumentFragment();
  
  rootItems.forEach(item => {
    const nodeEl = buildTreeNodeElement(item);
    fragment.appendChild(nodeEl);
  });

  treeContainer.appendChild(fragment);
}

function buildTreeNodeElement(item) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.id = `menu-node-${item.id}`;

  const title = currentLang === 'ar' ? item.title_ar : item.title_en;
  
  let typeLabel = '';
  let typeIcon = '';
  switch (item.reply_type) {
    case 'submenu':
      typeLabel = currentLang === 'ar' ? 'قائمة فرعية' : 'Submenu';
      typeIcon = '📂';
      break;
    case 'text':
      typeLabel = currentLang === 'ar' ? 'رد نصي' : 'Text Reply';
      typeIcon = '💬';
      break;
    case 'file':
      typeLabel = currentLang === 'ar' ? 'تحميل مستند' : 'Document';
      typeIcon = '📄';
      break;
  }

  const content = document.createElement('div');
  content.className = 'tree-node-content';
  if (activeMenuNode && activeMenuNode.id === item.id) {
    content.classList.add('active');
  }

  content.innerHTML = `
    <div class="node-title-group">
      <span class="node-icon">${typeIcon}</span>
      <span class="node-title">${escapeHTML(title)}</span>
      <span class="node-lang-indicator">(${typeLabel})</span>
    </div>
    <div class="node-actions">
      ${item.reply_type === 'submenu' ? `<button class="btn btn-secondary btn-xs btn-add-child" title="Add Child">+ Add Child</button>` : ''}
      <button class="btn btn-danger btn-xs btn-delete-menu">🗑️</button>
    </div>
  `;

  // Select node for editing
  content.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-add-child') || e.target.classList.contains('btn-delete-menu')) return;
    openMenuEditor(item);
  });

  // Delete node option
  content.querySelector('.btn-delete-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteMenuItem(item.id);
  });

  // Add child to submenu
  if (item.reply_type === 'submenu') {
    content.querySelector('.btn-add-child').addEventListener('click', (e) => {
      e.stopPropagation();
      openNewMenuForm(item.id, title);
    });
  }

  node.appendChild(content);

  // Recursively append child nodes
  const children = menuTreeData.filter(m => m.parent_id === item.id);
  if (children.length > 0) {
    children.forEach(child => {
      node.appendChild(buildTreeNodeElement(child));
    });
  }

  return node;
}

function openMenuEditor(item) {
  activeMenuNode = item;

  // Toggle active highlights
  document.querySelectorAll('.tree-node-content').forEach(el => el.classList.remove('active'));
  const activeNodeEl = document.querySelector(`#menu-node-${item.id} > .tree-node-content`);
  if (activeNodeEl) activeNodeEl.classList.add('active');

  // Fill in form values
  document.getElementById('menu-editor-title').innerText = currentLang === 'ar' ? 'تعديل خيار القائمة' : 'Edit Menu Option';
  document.getElementById('menu-item-id').value = item.id;
  document.getElementById('menu-parent-id').value = item.parent_id || '';
  document.getElementById('menu-title-en').value = item.title_en;
  document.getElementById('menu-title-ar').value = item.title_ar;
  document.getElementById('menu-sort-order').value = item.sort_order;
  document.getElementById('menu-reply-type').value = item.reply_type;
  document.getElementById('menu-content-en').value = item.reply_content_en || '';
  document.getElementById('menu-content-ar').value = item.reply_content_ar || '';
  
  // Show parent indicator if nested
  const parentIndicator = document.getElementById('menu-parent-indicator');
  if (item.parent_id) {
    const parentMenu = menuTreeData.find(m => m.id === item.parent_id);
    document.getElementById('menu-parent-title').innerText = parentMenu ? (currentLang === 'ar' ? parentMenu.title_ar : parentMenu.title_en) : 'Parent';
    parentIndicator.style.display = 'block';
  } else {
    parentIndicator.style.display = 'none';
  }

  // Handle file info display
  const currentFileDiv = document.getElementById('menu-current-file');
  const fileLink = document.getElementById('menu-file-link');
  const filesListDiv = document.getElementById('menu-files-list');
  const filesUl = document.getElementById('menu-files-ul');
  document.getElementById('menu-remove-file-chk').checked = false;
  
  // Reset both displays
  currentFileDiv.style.display = 'none';
  filesListDiv.style.display = 'none';
  filesUl.innerHTML = '';

  if (item.reply_type === 'file' && item.files && item.files.length > 0) {
    // Multi-file display
    item.files.forEach(f => {
      const li = document.createElement('li');
      li.style.cssText = 'padding: 4px 0; font-size: 13px;';
      li.innerHTML = `📄 <a href="${f.file_url}" target="_blank" style="color:var(--accent); text-decoration:none; font-weight:500;">${escapeHTML(f.file_name || 'file')}</a>`;
      filesUl.appendChild(li);
    });
    filesListDiv.style.display = 'block';
    // Also show legacy single-file display for the remove checkbox
    if (item.file_name && item.file_url) {
      fileLink.innerText = item.file_name;
      fileLink.href = item.file_url;
      currentFileDiv.style.display = 'flex';
    }
  } else if (item.reply_type === 'file' && item.file_name && item.file_url) {
    // Legacy single-file fallback
    fileLink.innerText = item.file_name;
    fileLink.href = item.file_url;
    currentFileDiv.style.display = 'flex';
  }

  updateConditionalFormFields(item.reply_type);
  document.getElementById('menu-form-card').style.display = 'block';
}

function openNewMenuForm(parentId = null, parentTitle = '') {
  activeMenuNode = null;
  document.querySelectorAll('.tree-node-content').forEach(el => el.classList.remove('active'));

  // Reset form
  document.getElementById('menu-item-form').reset();
  document.getElementById('menu-item-id').value = '';
  document.getElementById('menu-parent-id').value = parentId || '';
  document.getElementById('menu-editor-title').innerText = currentLang === 'ar' ? 'إضافة زر جديد للقائمة' : 'Add New Menu Button';
  
  const parentIndicator = document.getElementById('menu-parent-indicator');
  if (parentId) {
    document.getElementById('menu-parent-title').innerText = parentTitle;
    parentIndicator.style.display = 'block';
  } else {
    parentIndicator.style.display = 'none';
  }

  document.getElementById('menu-current-file').style.display = 'none';
  updateConditionalFormFields('submenu'); // default select type triggers hide of replies
  document.getElementById('menu-reply-type').value = 'submenu';
  document.getElementById('menu-form-card').style.display = 'block';
}

async function deleteMenuItem(menuId) {
  const confirmMsg = currentLang === 'ar' 
    ? 'هل أنت متأكد من حذف هذا الزر بالكامل؟ سيتم حذف جميع الخيارات الفرعية التابعة له!' 
    : 'Are you sure you want to delete this menu item? All sub-options nested inside it will also be deleted!';

  if (confirm(confirmMsg)) {
    try {
      const res = await fetch(`/api/menus/${menuId}`, { method: 'DELETE' });
      if (res.ok) {
        document.getElementById('menu-form-card').style.display = 'none';
        loadMenusTree();
      }
    } catch (e) {
      alert('Failed to delete menu item');
    }
  }
}

// Hook click for main add root button
document.getElementById('btn-add-root-menu').addEventListener('click', () => {
  openNewMenuForm(null, '');
});

// ----------------------------------------------------
// Announcements Loader & Layout
// ----------------------------------------------------
async function loadAnnouncements() {
  if (!activeFaculty) return;
  const listContainer = document.getElementById('announcements-history-container');
  listContainer.innerHTML = '<div class="loading-spinner"></div>';

  try {
    const res = await fetch(`/api/announcements?faculty_id=${activeFaculty.id}`);
    const list = await res.json();
    
    listContainer.innerHTML = '';
    if (list.length === 0) {
      listContainer.innerHTML = `<div style="padding: 20px; color: var(--text-muted); text-align: center;">${currentLang === 'ar' ? 'لم يتم بث أي إعلان بعد' : 'No announcements sent yet.'}</div>`;
      return;
    }

    list.forEach(ann => {
      const title = currentLang === 'ar' ? ann.title_ar : ann.title_en;
      const content = currentLang === 'ar' ? ann.content_ar : ann.content_en;
      const dateStr = new Date(ann.sent_at).toLocaleString();

      const item = document.createElement('div');
      item.className = 'announcement-item';
      
      let itemHtml = `
        <div class="announcement-item-header">
          <span class="announcement-item-title">${escapeHTML(title)}</span>
          <span class="announcement-item-date">${dateStr}</span>
        </div>
        <div class="announcement-item-content">${escapeHTML(content)}</div>
      `;

      if (ann.file_url) {
        itemHtml += `
          <div style="margin-top: 8px; font-size:12px;">
            📎 <a href="${ann.file_url}" target="_blank" style="color:var(--accent); font-weight:600; text-decoration:none;">${escapeHTML(ann.file_name)}</a>
          </div>
        `;
      }

      item.innerHTML = itemHtml;
      listContainer.appendChild(item);
    });

  } catch (e) {
    listContainer.innerHTML = '<div style="color:var(--danger); padding:10px;">Failed to load history</div>';
  }
}

// ----------------------------------------------------
// Subscribers & Analytics Tab Loader
// ----------------------------------------------------
async function loadSubscribers() {
  if (!activeFaculty) return;
  const tbody = document.getElementById('subscriber-table-body');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;"><div class="loading-spinner"></div></td></tr>';

  try {
    const res = await fetch(`/api/bot_users?faculty_id=${activeFaculty.id}`);
    const data = await res.json();

    // Fill counts
    document.getElementById('stats-total-users').innerText = data.total;
    document.getElementById('stats-telegram-users').innerText = data.telegram;
    document.getElementById('stats-web-users').innerText = data.web;

    tbody.innerHTML = '';
    if (data.users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">${currentLang === 'ar' ? 'لا يوجد مستخدمين مسجلين بعد.' : 'No registered users found.'}</td></tr>`;
      return;
    }

    data.users.forEach(user => {
      const dateStr = new Date(user.created_at).toLocaleString();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong style="text-transform: capitalize; color: ${user.platform === 'telegram' ? '#3b82f6' : '#10b981'};">${user.platform}</strong></td>
        <td><code>${escapeHTML(user.chat_id)}</code></td>
        <td>${escapeHTML(user.username || 'Visitor')}</td>
        <td><span class="slug-badge" style="padding: 2px 6px;">${user.language.toUpperCase()}</span></td>
        <td>${dateStr}</td>
      `;
      tbody.appendChild(tr);
    });

  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger);">Error loading subscribers registry</td></tr>`;
  }
}

// ----------------------------------------------------
// Modals Open/Close triggers
// ----------------------------------------------------
function setupModalListeners() {
  const modalFaculty = document.getElementById('modal-faculty');
  const btnNewFaculty = document.getElementById('btn-new-faculty');
  const modalFacultyClose = document.getElementById('modal-faculty-close');
  const modalFacultyCancel = document.getElementById('modal-faculty-cancel');

  btnNewFaculty.addEventListener('click', () => {
    document.getElementById('faculty-form').reset();
    document.getElementById('modal-faculty-title').innerText = currentLang === 'ar' ? 'إنشاء بوت كلية جديد' : 'Create New Faculty Bot';
    modalFaculty.classList.add('open');
  });

  const closeFacModal = () => modalFaculty.classList.remove('open');
  modalFacultyClose.addEventListener('click', closeFacModal);
  modalFacultyCancel.addEventListener('click', closeFacModal);

  // Submit Create Faculty Bot
  document.getElementById('faculty-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameEn = document.getElementById('faculty-name-en').value.trim();
    const nameAr = document.getElementById('faculty-name-ar').value.trim();
    const slug = document.getElementById('faculty-slug-input').value.trim().toLowerCase();

    try {
      const res = await fetch('/api/faculties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name_en: nameEn, name_ar: nameAr, slug })
      });
      const data = await res.json();
      
      if (res.ok) {
        closeFacModal();
        loadFaculties(data.id);
      } else {
        alert('Failed: ' + data.error);
      }
    } catch (err) {
      alert('Error creating faculty bot');
    }
  });

  // Duplicate Modal listeners
  const modalDuplicate = document.getElementById('modal-duplicate');
  const modalDuplicateClose = document.getElementById('modal-duplicate-close');
  const modalDuplicateCancel = document.getElementById('modal-duplicate-cancel');

  const closeDupModal = () => modalDuplicate.classList.remove('open');
  modalDuplicateClose.addEventListener('click', closeDupModal);
  modalDuplicateCancel.addEventListener('click', closeDupModal);

  document.getElementById('duplicate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sourceId = document.getElementById('duplicate-source-id').value;
    const nameEn = document.getElementById('duplicate-name-en').value.trim();
    const nameAr = document.getElementById('duplicate-name-ar').value.trim();
    const slug = document.getElementById('duplicate-slug-input').value.trim().toLowerCase();

    try {
      const res = await fetch(`/api/faculties/${sourceId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name_en: nameEn, name_ar: nameAr, slug })
      });
      const data = await res.json();
      
      if (res.ok) {
        closeDupModal();
        loadFaculties(data.id);
      } else {
        alert('Duplication failed: ' + data.error);
      }
    } catch (err) {
      alert('Error duplicating bot instance');
    }
  });

  // Button duplicate active in bar
  document.getElementById('btn-duplicate-active').addEventListener('click', () => {
    if (activeFaculty) {
      openDuplicateModal(activeFaculty);
    }
  });
}

function openDuplicateModal(faculty) {
  document.getElementById('duplicate-form').reset();
  document.getElementById('duplicate-source-id').value = faculty.id;
  
  const sourceName = currentLang === 'ar' ? faculty.name_ar : faculty.name_en;
  document.getElementById('duplicate-source-name').innerText = sourceName;
  
  document.getElementById('duplicate-name-en').value = faculty.name_en + ' (Copy)';
  document.getElementById('duplicate-name-ar').value = faculty.name_ar + ' (نسخة)';
  document.getElementById('duplicate-slug-input').value = faculty.slug + '-copy';

  document.getElementById('modal-duplicate').classList.add('open');
}

// ----------------------------------------------------
// Security Sanitation
// ----------------------------------------------------
function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
