(function () {
  // 1. Get configuration from the script tag
  const scriptTag = document.getElementById('unibot-widget-script');
  const facultySlug = scriptTag ? scriptTag.getAttribute('data-faculty') : 'fom';
  const serverUrl = window.location.origin; // Assume widget runs on same host or can make absolute requests

  // Generate or retrieve persistent user session ID
  let chatId = localStorage.getItem(`unibot_${facultySlug}_chat_id`);
  if (!chatId) {
    chatId = 'web_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    localStorage.setItem(`unibot_${facultySlug}_chat_id`, chatId);
  }

  // Get preferred language, default to English
  let language = localStorage.getItem(`unibot_${facultySlug}_lang`) || 'en';

  // Inject CSS Stylesheet dynamically if not loaded
  if (!document.getElementById('unibot-widget-styles')) {
    const link = document.createElement('link');
    link.id = 'unibot-widget-styles';
    link.rel = 'stylesheet';
    link.href = `${serverUrl}/widget/widget.css`;
    document.head.appendChild(link);
  }

  // State Variables
  let isOpen = false;
  let activeTab = 'chat'; // 'chat' or 'announcements'
  let facultyNameEn = 'Faculty Bot';
  let facultyNameAr = 'بوت الكلية';

  // Create Container
  const container = document.createElement('div');
  container.id = 'unibot-widget-container';
  container.setAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  document.body.appendChild(container);

  // Render Widget HTML Markup
  container.innerHTML = `
    <div class="unibot-chat-window" id="unibot-window">
      <div class="unibot-chat-header">
        <div class="unibot-chat-title-group">
          <h3 class="unibot-chat-title" id="unibot-header-title">Loading...</h3>
          <span class="unibot-chat-subtitle" id="unibot-header-subtitle">UniBot Assistant</span>
        </div>
        <div class="unibot-chat-header-actions">
          <button class="unibot-lang-toggle" id="unibot-lang-toggle-btn">${language === 'ar' ? 'English' : 'العربية'}</button>
          <button class="unibot-close-btn" id="unibot-close-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
      
      <div class="unibot-tabs">
        <div class="unibot-tab active" id="unibot-tab-chat" data-tab="chat">Chat / المحادثة</div>
        <div class="unibot-tab" id="unibot-tab-announcements" data-tab="announcements">Announcements / الإعلانات</div>
      </div>

      <div class="unibot-search-bar" id="unibot-search-bar-wrapper">
        <input type="text" id="unibot-search-input" placeholder="Search files... / ابحث عن ملفات...">
      </div>

      <div class="unibot-chat-body" id="unibot-chat-messages">
        <!-- Chat history dynamically added here -->
      </div>

      <div class="unibot-announcements-panel" id="unibot-announcements-list">
        <!-- Announcements dynamically added here -->
      </div>
    </div>

    <button class="unibot-trigger-btn" id="unibot-trigger-btn">
      <svg class="chat-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
    </button>
  `;

  // Select DOM Elements
  const widgetWindow = document.getElementById('unibot-window');
  const triggerBtn = document.getElementById('unibot-trigger-btn');
  const closeBtn = document.getElementById('unibot-close-btn');
  const langToggleBtn = document.getElementById('unibot-lang-toggle-btn');
  const messagesContainer = document.getElementById('unibot-chat-messages');
  const announcementsContainer = document.getElementById('unibot-announcements-list');
  const headerTitle = document.getElementById('unibot-header-title');
  const tabChat = document.getElementById('unibot-tab-chat');
  const tabAnnounce = document.getElementById('unibot-tab-announcements');
  const searchInput = document.getElementById('unibot-search-input');
  const searchWrapper = document.getElementById('unibot-search-bar-wrapper');

  // Toggle Widget Open/Close
  triggerBtn.addEventListener('click', () => {
    isOpen = !isOpen;
    if (isOpen) {
      widgetWindow.classList.add('open');
      triggerBtn.classList.add('active');
      // On first open, load data if empty
      if (messagesContainer.children.length === 0) {
        initSession();
      }
      loadAnnouncements();
    } else {
      widgetWindow.classList.remove('open');
      triggerBtn.classList.remove('active');
    }
  });

  closeBtn.addEventListener('click', () => {
    isOpen = false;
    widgetWindow.classList.remove('open');
    triggerBtn.classList.remove('active');
  });

  // Toggle Tab
  const setTab = (tab) => {
    activeTab = tab;
    if (tab === 'chat') {
      tabChat.classList.add('active');
      tabAnnounce.classList.remove('active');
      messagesContainer.style.display = 'flex';
      searchWrapper.style.display = 'block';
      announcementsContainer.classList.remove('active');
    } else {
      tabChat.classList.remove('active');
      tabAnnounce.classList.add('active');
      messagesContainer.style.display = 'none';
      searchWrapper.style.display = 'none';
      announcementsContainer.classList.add('active');
      loadAnnouncements();
    }
  };

  tabChat.addEventListener('click', () => setTab('chat'));
  tabAnnounce.addEventListener('click', () => setTab('announcements'));

  // Language Change Toggle
  langToggleBtn.addEventListener('click', () => {
    const newLang = language === 'en' ? 'ar' : 'en';
    setLanguage(newLang);
  });

  function setLanguage(newLang) {
    language = newLang;
    localStorage.setItem(`unibot_${facultySlug}_lang`, newLang);
    container.setAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    langToggleBtn.innerText = language === 'ar' ? 'English' : 'العربية';
    
    // Clear chat display and restart session to render UI in selected language
    messagesContainer.innerHTML = '';
    
    // Update labels
    tabChat.innerText = language === 'ar' ? 'المحادثة' : 'Chat';
    tabAnnounce.innerText = language === 'ar' ? 'الإعلانات' : 'Announcements';
    document.getElementById('unibot-header-subtitle').innerText = language === 'ar' ? 'مساعدك الشخصي' : 'UniBot Assistant';
    searchInput.placeholder = language === 'ar' ? 'ابحث عن ملفات...' : 'Search files...';

    initSession();
    loadAnnouncements();
  }

  // Search input debounced event
  let searchTimeout = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    if (query.length < 2) return;

    searchTimeout = setTimeout(() => {
      performWidgetSearch(query);
    }, 500);
  });

  async function performWidgetSearch(query) {
    appendUserMessage(query);
    const typingIndicator = appendTypingIndicator();
    
    try {
      const res = await fetch(`${serverUrl}/api/chat/search?faculty_slug=${facultySlug}&query=${encodeURIComponent(query)}&language=${language}`);
      const list = await res.json();
      
      typingIndicator.remove();
      searchInput.value = '';
      
      if (res.ok) {
        if (list.length > 0) {
          const text = language === 'ar' 
            ? `🔍 تم العثور على ${list.length} ملفات تطابق "${query}":` 
            : `🔍 Found ${list.length} files matching "${query}":`;
          
          const options = list.map(item => ({
            id: item.id,
            title_en: item.title_en,
            title_ar: item.title_ar,
            reply_type: 'file'
          }));
          
          appendBotMessage(text, options, null);
        } else {
          const noResults = language === 'ar'
            ? `❌ لم يتم العثور على ملفات تطابق "${query}"`
            : `❌ No files found matching "${query}"`;
          appendBotMessage(noResults, []);
        }
      } else {
        appendBotMessage(language === 'ar' ? 'عذراً، فشل البحث.' : 'Sorry, search failed.');
      }
    } catch(e) {
      typingIndicator.remove();
      appendBotMessage(language === 'ar' ? 'عذراً، فشل الاتصال بالخادم.' : 'Sorry, connection error.');
    }
  }

  // REST API Interactions
  async function initSession() {
    try {
      const res = await fetch(`${serverUrl}/api/chat/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_slug: facultySlug,
          chat_id: chatId,
          language: language,
          username: 'Web Visitor'
        })
      });
      const data = await res.json();
      
      if (res.ok) {
        facultyNameEn = data.faculty_name_en;
        facultyNameAr = data.faculty_name_ar;
        headerTitle.innerText = language === 'ar' ? facultyNameAr : facultyNameEn;

        // Welcome Message
        const welcomeText = language === 'ar' 
          ? (data.welcome_ar || `مرحباً بك في بوت ${facultyNameAr}. كيف يمكنني مساعدتك اليوم؟`)
          : (data.welcome_en || `Welcome to the ${facultyNameEn} Bot. How can I help you today?`);

        appendBotMessage(welcomeText, data.menus);
      } else {
        showError(data.error || 'Initialization failed');
      }
    } catch (e) {
      showError('Unable to connect to the server');
    }
  }

  async function loadAnnouncements() {
    try {
      const res = await fetch(`${serverUrl}/api/chat/announcements?faculty_slug=${facultySlug}`);
      const list = await res.json();
      
      if (res.ok) {
        renderAnnouncements(list);
      }
    } catch (e) {
      announcementsContainer.innerHTML = `<div style="padding: 10px; color: var(--chat-text-muted); text-align: center;">Error loading announcements</div>`;
    }
  }

  async function selectMenuOption(menuId, optionText) {
    // Append User Choice to Chat Stream
    appendUserMessage(optionText);

    // Add typing indicator
    const typingIndicator = appendTypingIndicator();

    try {
      const res = await fetch(`${serverUrl}/api/chat/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_slug: facultySlug,
          chat_id: chatId,
          menu_id: menuId,
          language: language
        })
      });
      const data = await res.json();
      
      // Remove typing indicator
      typingIndicator.remove();

      if (res.ok) {
        const title = language === 'ar' ? data.title_ar : data.title_en;
        
        if (data.reply_type === 'submenu') {
          // Output submenu prompt
          const submenuPrompt = language === 'ar' 
            ? `لقد اخترت قسم ${title}. يرجى اختيار خيار فرعي:` 
            : `You selected ${title}. Please select a sub-option:`;
          appendBotMessage(submenuPrompt, data.menus, data.parent_id);
        } else if (data.reply_type === 'text') {
          const content = language === 'ar' ? data.reply_content_ar : data.reply_content_en;
          appendBotMessage(content || '', [], data.parent_id);
        } else if (data.reply_type === 'file') {
          const content = language === 'ar' ? data.reply_content_ar : data.reply_content_en;
          appendBotMessage(content || '', [], data.parent_id, data.file_name, data.file_url);
        }
      } else {
        appendBotMessage(language === 'ar' ? 'حدث خطأ ما. يرجى المحاولة لاحقاً.' : 'An error occurred. Please try again.');
      }
    } catch (e) {
      typingIndicator.remove();
      appendBotMessage(language === 'ar' ? 'فشل الاتصال بالخادم.' : 'Failed to connect to the server.');
    }
  }

  // DOM Appenders
  function appendUserMessage(text) {
    const msg = document.createElement('div');
    msg.className = 'unibot-message unibot-message-user';
    msg.innerHTML = `<div class="unibot-message-content">${escapeHTML(text)}</div>`;
    messagesContainer.appendChild(msg);
    scrollToBottom();
  }

  function appendBotMessage(text, options = [], parentId = undefined, fileName = null, fileUrl = null) {
    const msg = document.createElement('div');
    msg.className = 'unibot-message unibot-message-bot';
    
    let contentHtml = `<div class="unibot-message-content">${escapeHTML(text)}`;
    
    // Add file link card if file is attached
    if (fileUrl) {
      contentHtml += `
        <a href="${serverUrl}${fileUrl}" target="_blank" class="unibot-file-card">
          <div class="unibot-file-icon">
            <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          </div>
          <div class="unibot-file-info">
            <span class="unibot-file-name">${escapeHTML(fileName || 'Download Document')}</span>
            <span class="unibot-file-download-label">${language === 'ar' ? 'اضغط للتحميل' : 'Click to Download'}</span>
          </div>
        </a>
      `;
    }

    contentHtml += `</div>`;
    msg.innerHTML = contentHtml;

    // Add buttons
    if ((options && options.length > 0) || parentId !== undefined) {
      let buttonsContainer = null;
      if (options && options.length > 0) {
        buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'unibot-menu-buttons';
        
        // Render menu options
        options.forEach(opt => {
          const title = language === 'ar' ? opt.title_ar : opt.title_en;
          const btn = document.createElement('button');
          btn.className = 'unibot-btn-option';
          btn.innerHTML = `<span>${escapeHTML(title)}</span><span class="unibot-btn-icon">${language === 'ar' ? '◀' : '▶'}</span>`;
          btn.addEventListener('click', () => {
            // Disable all sibling buttons in this message to avoid double clicks
            const siblings = buttonsContainer.querySelectorAll('.unibot-btn-option');
            siblings.forEach(s => s.disabled = true);
            selectMenuOption(opt.id, title);
          });
          buttonsContainer.appendChild(btn);
        });
        msg.appendChild(buttonsContainer);
      }

      // Add "Back" button if nested
      if (parentId !== undefined) {
        const backBtn = document.createElement('button');
        backBtn.className = 'unibot-btn-back';
        
        const backLabel = language === 'ar' ? '⬅️ العودة للقائمة السابقة' : '⬅️ Back to Previous Menu';
        backBtn.innerHTML = `<span>${backLabel}</span>`;
        
        backBtn.addEventListener('click', () => {
          if (buttonsContainer) {
            const siblings = buttonsContainer.querySelectorAll('.unibot-btn-option');
            siblings.forEach(s => s.disabled = true);
          }
          backBtn.disabled = true;
          
          if (parentId === null) {
            // Back to main
            initSession();
          } else {
            selectMenuOption(parentId, language === 'ar' ? 'العودة' : 'Back');
          }
        });
        msg.appendChild(backBtn);
      }
    }

    messagesContainer.appendChild(msg);
    scrollToBottom();
  }

  function appendTypingIndicator() {
    const msg = document.createElement('div');
    msg.className = 'unibot-message unibot-message-bot';
    msg.innerHTML = `
      <div class="unibot-message-content" style="padding: 10px 15px; display: flex; gap: 4px; align-items: center;">
        <span style="width: 6px; height: 6px; border-radius: 50%; background: var(--chat-text-muted); display: inline-block; animation: typingBounce 1.4s infinite both;"></span>
        <span style="width: 6px; height: 6px; border-radius: 50%; background: var(--chat-text-muted); display: inline-block; animation: typingBounce 1.4s infinite both 0.2s;"></span>
        <span style="width: 6px; height: 6px; border-radius: 50%; background: var(--chat-text-muted); display: inline-block; animation: typingBounce 1.4s infinite both 0.4s;"></span>
      </div>
      <style>
        @keyframes typingBounce {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }
      </style>
    `;
    messagesContainer.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function renderAnnouncements(list) {
    if (!list || list.length === 0) {
      announcementsContainer.innerHTML = `
        <div style="padding: 30px 10px; color: var(--chat-text-muted); text-align: center; font-size: 13.5px;">
          ${language === 'ar' ? 'لا توجد إعلانات حالياً' : 'No announcements at the moment.'}
        </div>
      `;
      return;
    }

    announcementsContainer.innerHTML = '';
    list.forEach(ann => {
      const title = language === 'ar' ? ann.title_ar : ann.title_en;
      const content = language === 'ar' ? ann.content_ar : ann.content_en;
      const dateStr = new Date(ann.sent_at).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });

      const card = document.createElement('div');
      card.className = 'unibot-announcement-card';
      
      let cardHtml = `
        <div class="unibot-announcement-header">
          <h4 class="unibot-announcement-title">${escapeHTML(title)}</h4>
          <span class="unibot-announcement-date">${dateStr}</span>
        </div>
        <p class="unibot-announcement-content">${escapeHTML(content)}</p>
      `;

      if (ann.file_url) {
        cardHtml += `
          <a href="${serverUrl}${ann.file_url}" target="_blank" class="unibot-file-card" style="margin-top: 5px;">
            <div class="unibot-file-icon" style="width: 32px; height: 32px;">
              <svg viewBox="0 0 24 24" style="width: 16px; height: 16px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
            </div>
            <div class="unibot-file-info">
              <span class="unibot-file-name" style="font-size: 12px;">${escapeHTML(ann.file_name || 'Attached File')}</span>
            </div>
          </a>
        `;
      }

      card.innerHTML = cardHtml;
      announcementsContainer.appendChild(card);
    });
  }

  function showError(text) {
    headerTitle.innerText = 'Offline';
    messagesContainer.innerHTML = `
      <div style="padding: 20px; color: #ef4444; font-size: 13.5px; text-align: center;">
        ⚠️ ${escapeHTML(text)}
      </div>
    `;
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Expose triggers in the global space if needed
  window.UniBotWidget = {
    open: () => {
      isOpen = true;
      widgetWindow.classList.add('open');
      triggerBtn.classList.add('active');
    },
    close: () => {
      isOpen = false;
      widgetWindow.classList.remove('open');
      triggerBtn.classList.remove('active');
    },
    setLanguage: (lang) => setLanguage(lang)
  };
})();
