/**
 * src/backup/index.js — Entry point for the backup module.
 *
 * Creates a singleton BackupService instance and re-exports a
 * backward-compatible API that matches what server.js expects:
 *   - startScheduler()
 *   - stopScheduler()
 *   - performBackup()
 *
 * Also exposes the full BackupService instance for advanced use
 * by the Web Platform and Telegram Bot in the future.
 */

'use strict';

const BackupService = require('./backup-service');

// Singleton instance
const backupService = new BackupService();

module.exports = {
  // ── Backward-compatible API (used by server.js) ──
  startScheduler: () => backupService.startScheduler(),
  stopScheduler: () => backupService.stopScheduler(),
  performBackup: (triggeredBy) => backupService.createBackup(triggeredBy || 'manual'),

  // ── Extended API (for future Telegram Bot / Web Platform integration) ──
  backupService,

  // Convenience re-exports
  createBackup: (triggeredBy) => backupService.createBackup(triggeredBy),
  restoreBackup: (backupKey) => backupService.restoreBackup(backupKey),
  listBackups: () => backupService.listBackups(),
  deleteBackup: (backupKey) => backupService.deleteBackup(backupKey),
  cleanup: () => backupService.cleanup(),
  isConfigured: () => backupService.isConfigured()
};
