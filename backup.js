/**
 * backup.js — Thin re-export of the backup module.
 *
 * All backup logic lives in src/backup/. This file exists solely to
 * preserve the require('./backup') import in server.js without changes.
 */

'use strict';

module.exports = require('./src/backup');
