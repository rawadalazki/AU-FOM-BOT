const db = require('./database');

async function audit() {
  const client = await db.pool.connect();
  try {
    const { rows: memberships } = await client.query('SELECT * FROM bot_memberships ORDER BY created_at ASC');
    const { rows: faculties } = await client.query('SELECT id, name_en, admin_chat_id FROM faculties');
    const { rows: adminUsers } = await client.query('SELECT id, username, role, is_deputy_owner FROM admin_users');

    const result = {
      memberships,
      faculties,
      adminUsers
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Audit failed:', err);
  } finally {
    client.release();
    process.exit(0);
  }
}

audit();
