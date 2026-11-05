// 数据访问层：统一封装数据库操作、审计日志与 Token 用量记录
const DB = (function () {
  function unwrap(result, op) {
    if (result.error) {
      const e = result.error;
      if (e.code === '42501') throw new Error('没有权限执行此操作（' + op + '）');
      if (e.code === '23505') throw new Error('记录已存在（' + op + '）');
      throw new Error(e.message || '数据库操作失败（' + op + '）');
    }
    return result.data;
  }

  // ---------- 知识条目 ----------
  function listPublished(limit) {
    return cloud.database
      .from('knowledge_items')
      .select('*')
      .eq('status', '已发布')
      .order('cite_count', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(limit || 300)
      .then((r) => unwrap(r, '查询知识库'));
  }

  // 全量可见条目（已发布 + 本人相关；管理员可见全部），供列表页/审核页使用
  function listVisible(filters) {
    let q = cloud.database
      .from('knowledge_items')
      .select('*', { count: 'exact' })
      .order('updated_at', { ascending: false })
      .limit(filters && filters.limit ? filters.limit : 200);
    if (filters) {
      if (filters.status) q = q.eq('status', filters.status);
      if (filters.product) q = q.eq('product', filters.product);
      if (filters.category) q = q.eq('category', filters.category);
      if (filters.keyword) {
        q = q.or(
          'title.ilike.%' + filters.keyword + '%,content.ilike.%' + filters.keyword + '%'
        );
      }
    }
    return q.then((r) => unwrap(r, '查询知识库'));
  }

  function getItem(id) {
    return cloud.database
      .from('knowledge_items')
      .select('*')
      .eq('id', id)
      .maybeSingle()
      .then((r) => unwrap(r, '查询条目详情'));
  }

  function insertReport(payload) {
    // owner_id 由数据库 DEFAULT auth.uid() 填充，客户端不传
    return cloud.database
      .from('knowledge_items')
      .insert(payload)
      .select()
      .then((r) => unwrap(r, '提交问题上报'));
  }

  function updateItem(id, patch) {
    return cloud.database
      .from('knowledge_items')
      .update(patch)
      .eq('id', id)
      .select()
      .then((r) => {
        const rows = unwrap(r, '更新条目');
        if (Array.isArray(rows) && rows.length === 0) {
          throw new Error('更新未生效：条目可能不存在或不在你的可见范围内');
        }
        return rows[0];
      });
  }

  function deleteItem(id) {
    return cloud.database
      .from('knowledge_items')
      .delete()
      .eq('id', id)
      .select()
      .then((r) => {
        const rows = unwrap(r, '删除条目');
        if (Array.isArray(rows) && rows.length === 0) {
          throw new Error('删除未生效：条目可能不存在或不在你的可见范围内');
        }
        return true;
      });
  }

  async function incrementCite(id) {
    try {
      await cloud.database.rpc('increment_cite', { k_id: id });
    } catch (e) {
      console.warn('[cite]', e.message);
    }
  }

  // ---------- 个人档案 / 用户管理 ----------
  function registerProfile(name) {
    return cloud.database.rpc('register_profile', { p_name: name || '' });
  }

  function getMyProfile(ownerId) {
    return cloud.database
      .from('profiles')
      .select('*')
      .eq('owner_id', ownerId)
      .maybeSingle()
      .then((r) => unwrap(r, '查询个人档案'));
  }

  function listUsers() {
    return cloud.database
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: true })
      .then((r) => unwrap(r, '查询用户列表'));
  }

  function updateUserRole(ownerId, role) {
    return cloud.database
      .from('profiles')
      .update({ role: role })
      .eq('owner_id', ownerId)
      .select()
      .then((r) => {
        const rows = unwrap(r, '调整角色');
        if (Array.isArray(rows) && rows.length === 0) {
          throw new Error('角色调整未生效');
        }
        return rows[0];
      });
  }

  // ---------- 审核记录 ----------
  function insertAuditLog(row) {
    return cloud.database
      .from('audit_logs')
      .insert(row)
      .then((r) => unwrap(r, '写入审核记录'));
  }

  function listAuditLogs(knowledgeId) {
    return cloud.database
      .from('audit_logs')
      .select('*')
      .eq('knowledge_id', knowledgeId)
      .order('created_at', { ascending: false })
      .then((r) => unwrap(r, '查询审核记录'));
  }

  // ---------- 操作日志 ----------
  async function logOperation(operator, action, targetId, detail) {
    try {
      await cloud.database.from('operation_logs').insert({
        operator: operator || null,
        action: action,
        target_id: targetId ? String(targetId) : null,
        detail: detail || null
      });
    } catch (e) {
      console.warn('[log]', e.message);
    }
  }

  function listOperationLogs(limit) {
    return cloud.database
      .from('operation_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit || 200)
      .then((r) => unwrap(r, '查询操作日志'));
  }

  return {
    listPublished,
    listVisible,
    getItem,
    insertReport,
    updateItem,
    deleteItem,
    incrementCite,
    registerProfile,
    getMyProfile,
    listUsers,
    updateUserRole,
    insertAuditLog,
    listAuditLogs,
    logOperation,
    listOperationLogs
  };
})();
