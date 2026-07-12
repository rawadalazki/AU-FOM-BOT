const dbHelper = require('./database');

async function getMenuPathContext(menuId) {
  try {
    const query = `
      WITH RECURSIVE menu_tree AS (
        SELECT id, parent_id, title_en, title_ar, reply_type, 1 as depth
        FROM menus
        WHERE id = $1
        UNION ALL
        SELECT m.id, m.parent_id, m.title_en, m.title_ar, m.reply_type, mt.depth + 1
        FROM menus m
        JOIN menu_tree mt ON m.id = mt.parent_id
      )
      SELECT * FROM menu_tree ORDER BY depth DESC;
    `;
    const { rows } = await dbHelper.pool.query(query, [menuId]);
    if (rows.length === 0) return null;

    const pathArr = rows.map(m => m.title_en || m.title_ar || 'Unknown');
    const menuPath = pathArr.join(' → ');
    
    const currentM = rows[rows.length - 1]; // depth 1
    const currentMenuTitle = currentM.title_en || currentM.title_ar || 'Unknown';
    const lastReplyType = currentM.reply_type || 'Unknown';
    
    let parentMenuTitle = 'Unknown';
    let parentId = currentM.parent_id;
    if (rows.length > 1) {
      const parentM = rows[rows.length - 2]; // depth 2
      parentMenuTitle = parentM.title_en || parentM.title_ar || 'Unknown';
    }

    return {
      currentMenuId: menuId,
      currentMenuTitle,
      parentMenuId: parentId,
      parentMenuTitle,
      menuPath,
      lastReplyType,
      pathArray: pathArr
    };
  } catch (err) {
    console.error('getMenuPathContext error', err);
    return null;
  }
}

async function buildMenuTree(facultyId) {
  const menus = await dbHelper.getMenusByFaculty(facultyId);
  if (!menus || menus.length === 0) return [];

  // Count files per menu
  const fileCounts = new Map();
  const fileQuery = await dbHelper.pool.query(
    'SELECT menu_id, COUNT(*) as fcount FROM menu_files GROUP BY menu_id'
  );
  for (const r of fileQuery.rows) {
    fileCounts.set(r.menu_id, parseInt(r.fcount, 10));
  }

  // Pre-calculate counts and maps
  const childrenMap = new Map();
  const nodeMap = new Map();

  for (const m of menus) {
    // Add legacy file support
    let fCount = fileCounts.get(m.id) || 0;
    if (m.telegram_file_id) fCount += 1;

    const node = {
      id: m.id,
      parent_id: m.parent_id,
      title: m.title_en || m.title_ar || 'Unknown',
      title_en: m.title_en || '',
      title_ar: m.title_ar || '',
      reply_type: m.reply_type || 'text',
      sort_order: m.sort_order,
      children_count: 0,
      has_children: false,
      file_count: fCount,
      has_files: fCount > 0,
      depth: 0,
      breadcrumb: ''
    };
    nodeMap.set(m.id, node);
    
    if (m.parent_id) {
      if (!childrenMap.has(m.parent_id)) childrenMap.set(m.parent_id, []);
      childrenMap.get(m.parent_id).push(node);
    }
  }

  // Calculate breadcrumbs and depth
  for (const node of nodeMap.values()) {
    let current = node;
    const path = [];
    let depth = 0;
    let safeGuard = 50;
    while (current && safeGuard-- > 0) {
      path.unshift(current.title);
      depth++;
      if (current.parent_id && current.parent_id !== current.id) {
        current = nodeMap.get(current.parent_id);
      } else {
        current = null;
      }
    }
    node.depth = depth;
    node.breadcrumb = path.join(' → ');
    
    const children = childrenMap.get(node.id);
    if (children) {
      node.children_count = children.length;
      node.has_children = children.length > 0;
    }
  }

  return Array.from(nodeMap.values());
}

async function validateHierarchy(facultyId) {
  const menus = await dbHelper.getMenusByFaculty(facultyId);
  const nodeMap = new Map();
  menus.forEach(m => nodeMap.set(m.id, m));

  const warnings = [];
  const orphans = [];
  const duplicateOrders = [];
  const circularRefs = [];
  const unreachable = [];
  const selfParents = [];
  const duplicateTitles = [];
  const excessiveDepth = [];
  const brokenBreadcrumbs = [];

  let totalText = 0;
  let totalMedia = 0;
  let totalFile = 0;
  let rootMenus = 0;
  let deepestLevel = 0;

  const parentToTitles = new Map();
  const parentToSortOrders = new Map();

  for (const m of menus) {
    if (m.reply_type === 'text') totalText++;
    else if (m.reply_type === 'file' || m.reply_type === 'audio' || m.reply_type === 'video' || m.reply_type === 'document' || m.reply_type === 'photo') {
      if (m.reply_type === 'file' || m.reply_type === 'document') totalFile++;
      else totalMedia++;
    }

    if (!m.parent_id) {
      rootMenus++;
    }

    // Self-parent
    if (m.parent_id === m.id) {
      selfParents.push(m.id);
      warnings.push(`Menu ${m.id} is its own parent.`);
    }

    // Orphan
    if (m.parent_id && !nodeMap.has(m.parent_id)) {
      orphans.push(m.id);
      warnings.push(`Menu ${m.id} points to non-existent parent ${m.parent_id}.`);
    }

    // Duplicate titles & sort orders under same parent
    const pKey = m.parent_id || 'root';
    
    if (!parentToTitles.has(pKey)) parentToTitles.set(pKey, new Set());
    const tSet = parentToTitles.get(pKey);
    const title = m.title_en || m.title_ar || '';
    if (tSet.has(title)) {
      duplicateTitles.push(m.id);
      warnings.push(`Menu ${m.id} has duplicate title "${title}" under parent ${pKey}.`);
    } else {
      tSet.add(title);
    }

    if (!parentToSortOrders.has(pKey)) parentToSortOrders.set(pKey, new Set());
    const sSet = parentToSortOrders.get(pKey);
    if (sSet.has(m.sort_order)) {
      duplicateOrders.push(m.id);
      warnings.push(`Menu ${m.id} shares sort_order ${m.sort_order} with a sibling under parent ${pKey}.`);
    } else {
      sSet.add(m.sort_order);
    }
  }

  // Circular ref & depth & unreachable
  const reachableFromRoot = new Set();
  
  for (const m of menus) {
    const visited = new Set();
    let current = m;
    let depth = 0;
    let isCircular = false;
    let isBroken = false;

    while (current) {
      if (visited.has(current.id)) {
        isCircular = true;
        break;
      }
      visited.add(current.id);
      depth++;

      if (current.parent_id) {
        if (!nodeMap.has(current.parent_id)) {
          isBroken = true;
          break;
        }
        current = nodeMap.get(current.parent_id);
      } else {
        // Reached root
        for (const v of visited) reachableFromRoot.add(v);
        break;
      }
    }

    if (depth > deepestLevel) deepestLevel = depth;
    
    if (isCircular) {
      circularRefs.push(m.id);
      warnings.push(`Menu ${m.id} is in a circular reference loop.`);
    }
    
    if (depth > 20 && !isCircular) {
      excessiveDepth.push(m.id);
      warnings.push(`Menu ${m.id} exceeds maximum recommended hierarchy depth (depth: ${depth}).`);
    }

    if (isBroken && !isCircular) {
      brokenBreadcrumbs.push(m.id);
      warnings.push(`Menu ${m.id} has a broken breadcrumb chain.`);
    }
  }

  for (const m of menus) {
    if (!reachableFromRoot.has(m.id) && !circularRefs.includes(m.id) && !brokenBreadcrumbs.includes(m.id) && !orphans.includes(m.id)) {
      unreachable.push(m.id);
      warnings.push(`Menu ${m.id} is unreachable from the root menu.`);
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
    statistics: {
      total_menus: menus.length,
      root_menus: rootMenus,
      deepest_level: deepestLevel,
      total_text_menus: totalText,
      total_file_menus: totalFile,
      total_media_menus: totalMedia,
      orphan_count: orphans.length,
      circular_reference_count: circularRefs.length,
      duplicate_order_count: duplicateOrders.length,
      self_parent_count: selfParents.length,
      duplicate_title_count: duplicateTitles.length,
      excessive_depth_count: excessiveDepth.length,
      broken_breadcrumb_count: brokenBreadcrumbs.length,
      unreachable_count: unreachable.length
    },
    issues: {
      orphans,
      circularRefs,
      duplicateOrders,
      selfParents,
      duplicateTitles,
      excessiveDepth,
      brokenBreadcrumbs,
      unreachable
    }
  };
}

module.exports = {
  getMenuPathContext,
  buildMenuTree,
  validateHierarchy
};
