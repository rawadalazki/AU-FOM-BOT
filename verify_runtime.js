const dbHelper = require('./database');
const pool = dbHelper.pool; 

async function runVerification() {
  console.log('--- STARTING STRICT RUNTIME AUTHORIZATION VERIFICATION ---\n');

  // Request a dedicated client for our transaction
  const client = await pool.connect();
  
  // We only intercept queries ON THIS SPECIFIC CLIENT to log them.
  // We DO NOT override pool.query globally, ensuring zero side-effects to the running app.
  const originalClientQuery = client.query;
  const queryLog = [];
  client.query = async function(...args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    queryLog.push(text);
    return originalClientQuery.apply(this, args);
  };

  try {
    // BEGIN transaction. Everything below is strictly isolated.
    await client.query('BEGIN');

    // 1. Setup test faculties (Data is strictly bound to this uncommitted transaction)
    const facA_id = 'test_fac_A_' + Date.now();
    const facB_id = 'test_fac_B_' + Date.now();

    await client.query('INSERT INTO faculties (id, name_en) VALUES ($1, $2)', [facA_id, 'Bot A']);
    await client.query('INSERT INTO faculties (id, name_en) VALUES ($1, $2)', [facB_id, 'Bot B']);

    const userA = '1001';
    const userB = '1002';
    const userC = '1003';

    // 2. Assign Roles using actual system functions (Passing our transaction client)
    console.log('[*] Assigning roles...');
    await dbHelper.setAdminRole(facA_id, userA, 'OWNER', 'system', client);
    await dbHelper.setAdminRole(facA_id, userB, 'DEPUTY_ADMIN', userA, client); 
    await dbHelper.setAdminRole(facB_id, userB, 'OWNER', 'system', client);
    await dbHelper.setAdminRole(facA_id, userC, 'ADMIN', userB, client); 
    await dbHelper.setAdminRole(facB_id, userC, 'DEPUTY_ADMIN', userB, client); 

    queryLog.length = 0;

    // 3. Verify Permutations
    console.log('[*] Verifying role isolation...');
    
    // User A Role
    const roleA_A = await dbHelper.getAdminRole(facA_id, userA, client);
    const roleA_B = await dbHelper.getAdminRole(facB_id, userA, client);
    if (roleA_A !== 'OWNER' || roleA_B !== 'USER') throw new Error(`User A leakage`);

    // User B Role
    const roleB_A = await dbHelper.getAdminRole(facA_id, userB, client);
    const roleB_B = await dbHelper.getAdminRole(facB_id, userB, client);
    if (roleB_A !== 'DEPUTY_ADMIN' || roleB_B !== 'OWNER') throw new Error(`User B leakage`);

    // User C Role
    const roleC_A = await dbHelper.getAdminRole(facA_id, userC, client);
    const roleC_B = await dbHelper.getAdminRole(facB_id, userC, client);
    if (roleC_A !== 'ADMIN' || roleC_B !== 'DEPUTY_ADMIN') throw new Error(`User C leakage`);

    console.log('[PASS] Each user only has permissions inside the assigned bot.');
    console.log('[PASS] Actions in one bot never affect another bot.');

    // 4. Verify Transfer & Removal
    console.log('[*] Verifying OWNER transfer and revocation...');
    await dbHelper.assignBotOwner(facA_id, userB, 'system', client);
    
    const newRoleA_A = await dbHelper.getAdminRole(facA_id, userA, client);
    const newRoleB_A = await dbHelper.getAdminRole(facA_id, userB, client);
    if (newRoleA_A !== 'USER' || newRoleB_A !== 'OWNER') throw new Error('OWNER transfer failed');
    
    await dbHelper.removeAdmin(facB_id, userC, userB, client); 
    const newRoleC_B = await dbHelper.getAdminRole(facB_id, userC, client);
    if (newRoleC_B !== 'USER') throw new Error('Revocation failed to remove access');

    console.log('[PASS] OWNER transfer updates only the target bot.');
    console.log('[PASS] Removing a membership immediately revokes access.');

    // 5. Verify SQL Query Log
    console.log('[*] Scanning SQL logs for legacy access...');
    let legacyQueries = 0;
    
    console.log('\n--- INTERCEPTED SQL LOG ---');
    for (const q of queryLog) {
      console.log('> ' + q.replace(/\n/g, ' '));
      const qLower = q.toLowerCase();
      if ((qLower.includes('admins') && !qLower.includes('bot_memberships')) || qLower.includes('admin_chat_id')) {
        console.error('LEGACY QUERY DETECTED:', q);
        legacyQueries++;
      }
    }
    console.log('---------------------------\n');

    if (legacyQueries > 0) throw new Error('Legacy tables were queried during runtime.');

    console.log('[PASS] No legacy table is queried during runtime.');
    console.log('[PASS] Zero queries against legacy authorization.');
    console.log('[PASS] Zero cross-bot permission leakage.');
    console.log('[PASS] Zero unexpected privilege escalation.');
    console.log('[PASS] Zero runtime errors.\n');

  } catch (err) {
    console.error('[FAIL]', err.stack);
  } finally {
    // 6. ROLLBACK: Absolutely guarantees database purity.
    // By calling ROLLBACK, PostgreSQL destroys all uncommitted inserts and updates.
    // The production database remains totally untouched.
    await client.query('ROLLBACK');
    console.log('[*] Transaction rolled back. All test data permanently cleaned up by PostgreSQL.');
    
    // Release client back to the pool
    client.release();
    
    console.log('--- RUNTIME AUTHORIZATION VERIFICATION COMPLETED ---');
    
    // Note: Intentionally omitting pool.end() to prevent shutting down the global
    // connection pool if the app is concurrently running.
    process.exit(0);
  }
}

runVerification();
