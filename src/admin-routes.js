const AdminRoutes = {
  // Navigation / Base
  'admin_home': { roles: ['OWNER', 'DEPUTY_ADMIN', 'SUB_ADMIN'] },
  'close': { roles: ['OWNER', 'DEPUTY_ADMIN', 'SUB_ADMIN'] },
  'back': { roles: ['OWNER', 'DEPUTY_ADMIN', 'SUB_ADMIN'] },
  'cancel': { roles: ['OWNER', 'DEPUTY_ADMIN', 'SUB_ADMIN'] },
  
  // Menus
  'manage_menus': { roles: ['OWNER', 'DEPUTY_ADMIN', 'SUB_ADMIN'] },
  'manage_folders': { roles: ['OWNER', 'DEPUTY_ADMIN', 'SUB_ADMIN'] },

  // Announcements
  'new_announcement': { roles: ['OWNER', 'DEPUTY_ADMIN'] },
  'manage_announcements': { roles: ['OWNER', 'DEPUTY_ADMIN'] },

  // Statistics & Monitoring
  'statistics': { roles: ['OWNER', 'DEPUTY_ADMIN'] },
  'admin_monitoring': { roles: ['OWNER'] },
  'enable_monitoring': { roles: ['OWNER'] },
  'disable_monitoring': { roles: ['OWNER'] },
  
  // Settings & Configuration
  'core_settings': { roles: ['OWNER'] },
  'cfg_welcome': { roles: ['OWNER'] },
  'cfg_maintenance': { roles: ['OWNER'] },
  'cfg_empty_btn': { roles: ['OWNER'] },
  'cfg_unknown_text': { roles: ['OWNER'] },
  'cfg_no_file': { roles: ['OWNER'] },
  'cfg_home': { roles: ['OWNER'] },

  // Admin Management
  'manage_admins': { roles: ['OWNER'] },
  'manage_deputies': { roles: ['OWNER'] },
  'add_subadmin': { roles: ['OWNER'] },
  'view_subadmins': { roles: ['OWNER'] },
  'remove_subadmin': { roles: ['OWNER'] },
  
  // Misc
  'live_activity': { roles: ['OWNER'] }
};

module.exports = AdminRoutes;
