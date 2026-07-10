const dbHelper = require('./database');
const fs = require('node:fs');
const path = require('node:path');

console.log('--- STARTING DATABASE AND DUPLICATION API TEST ---');

try {
  // 1. Create a mock faculty
  const slug = 'test-fac-' + Date.now();
  console.log(`1. Creating test faculty with slug: ${slug}...`);
  const facId = dbHelper.createFaculty('Test Engineering Faculty', 'كلية الهندسة التجريبية', slug, 'test-token');
  console.log(`   Success! Faculty created with ID: ${facId}`);

  // 2. Create nested menus
  console.log('2. Inserting test menu structures (Parent & Child)...');
  const parentId = dbHelper.createMenu(
    facId,
    null,
    'Syllabus',
    'المنهج الدراسي',
    'submenu',
    null,
    null,
    null,
    null,
    1
  );
  
  const childId = dbHelper.createMenu(
    facId,
    parentId,
    'Year 1 Syllabus',
    'منهج السنة الأولى',
    'text',
    'Syllabus content here',
    'تفاصيل المنهج هنا',
    null,
    null,
    1
  );

  console.log(`   Success! Parent ID: ${parentId}, Child ID: ${childId}`);

  // 3. Create mock announcement
  console.log('3. Creating test announcement...');
  const annId = dbHelper.createAnnouncement(
    facId,
    'Important Alert',
    'تنبيه هام',
    'English content',
    'محتوى عربي',
    null,
    null
  );
  console.log(`   Success! Announcement ID: ${annId}`);

  // 4. Duplicate the entire faculty configuration
  console.log('4. Testing Duplication Engine logic...');
  const targetSlug = slug + '-copy';
  const targetFacId = dbHelper.createFaculty('Test Engineering Faculty (Copy)', 'كلية الهندسة التجريبية (نسخة)', targetSlug, '');
  
  // Clone Menus
  const menus = dbHelper.getMenusByFaculty(facId);
  const oldToNewId = {};
  const insertMenuStmt = dbHelper.db.prepare(`
    INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar, file_name, telegram_file_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let remaining = [...menus];
  let progress = true;

  while (remaining.length > 0 && progress) {
    progress = false;
    const nextRemaining = [];

    for (const menu of remaining) {
      if (menu.parent_id === null) {
        const info = insertMenuStmt.run(
          targetFacId,
          null,
          menu.title_en,
          menu.title_ar,
          menu.reply_type,
          menu.reply_content_en,
          menu.reply_content_ar,
          menu.file_name,
          menu.telegram_file_id,
          menu.sort_order
        );
        oldToNewId[menu.id] = info.lastInsertRowid;
        progress = true;
      } else if (oldToNewId[menu.parent_id] !== undefined) {
        const info = insertMenuStmt.run(
          targetFacId,
          oldToNewId[menu.parent_id],
          menu.title_en,
          menu.title_ar,
          menu.reply_type,
          menu.reply_content_en,
          menu.reply_content_ar,
          menu.file_name,
          menu.telegram_file_id,
          menu.sort_order
        );
        oldToNewId[menu.id] = info.lastInsertRowid;
        progress = true;
      } else {
        nextRemaining.push(menu);
      }
    }
    remaining = nextRemaining;
  }

  // 5. Verify the duplicated menu hierarchy
  console.log('5. Verifying duplicated menu structure...');
  const clonedMenus = dbHelper.getMenusByFaculty(targetFacId);
  
  if (clonedMenus.length !== 2) {
    throw new Error(`Expected 2 cloned menus, but got: ${clonedMenus.length}`);
  }

  const clonedParent = clonedMenus.find(m => m.parent_id === null);
  const clonedChild = clonedMenus.find(m => m.parent_id !== null);

  if (!clonedParent || clonedParent.title_en !== 'Syllabus') {
    throw new Error('Cloned parent menu not found or incorrect title');
  }

  if (!clonedChild || clonedChild.title_en !== 'Year 1 Syllabus') {
    throw new Error('Cloned child menu not found or incorrect title');
  }

  if (clonedChild.parent_id !== clonedParent.id) {
    throw new Error(`Parent-child mapping failed. Cloned child points to ${clonedChild.parent_id}, expected cloned parent ID ${clonedParent.id}`);
  }

  console.log('   Verification successful! Hierarchical tree successfully cloned.');

  // Clean up test rows
  console.log('6. Cleaning up test data...');
  dbHelper.deleteFaculty(facId);
  dbHelper.deleteFaculty(targetFacId);
  console.log('   Cleanup done.');
  
  console.log('\n✅ ALL DATABASE TESTS PASSED SUCCESSFULLY! ✅');
} catch (error) {
  console.error('\n❌ TEST FAILED: ❌');
  console.error(error.message);
  process.exit(1);
}
