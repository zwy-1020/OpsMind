/* 运维知识库智能问答系统 - 主逻辑
   角色：admin=管理运维人员 / user=使用人员（RBAC，页面与操作按角色隔离） */

const state = {
  session: null,
  uid: null,
  name: null,
  role: 'user', // admin | user
  publishedCache: null
};

const CATEGORIES = ['数据库', '网络', '系统', '应用', '中间件', '其他'];
const STATUSES = ['草稿', '待审核', '已通过', '已驳回', '已发布', '已归档'];
const KINDS = ['故障案例', '常识知识'];

// 入库前本地脱敏（批量导入用；单条录入/上报走大模型脱敏）
// IPv4 保留首段，账号/密码/密钥/Token 值替换为 ***
function maskSensitive(text) {
  let s = String(text || '');
  s = s.replace(/\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '$1.*.*.*');
  s = s.replace(/((?:password|passwd|pwd|secret|token|apikey|api_key|access[_-]?key|private[_-]?key)[\s]*[:=][\s]*)(\S+)/gi, '$1***');
  s = s.replace(/((?:密码|口令|密钥|秘钥|令牌)[\s]*[:=：][\s]*)(\S+)/g, '$1***');
  return s;
}

/* ---------- 小工具 ---------- */
const $ = (sel) => document.querySelector(sel);
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
function statusTag(s) { return `<span class="tag tag-${esc(s)}">${esc(s)}</span>`; }
function catTag(c) { return `<span class="tag tag-cat">${esc(c || '其他')}</span>`; }
function plainTag(t) { return `<span class="tag tag-plain">${esc(t)}</span>`; }
function reportNo(id) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `OB-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(id).padStart(3, '0')}`;
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-mask').classList.remove('hidden');
}
function closeModal() { $('#modal-mask').classList.add('hidden'); }
$('#modal-mask').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });

async function refreshPublishedCache() {
  state.publishedCache = await DB.listPublished(300);
  return state.publishedCache;
}
window.App = {
  async logUsage(endpoint, modelId, usage) {
    await DB.logOperation(state.name, 'llm_call', endpoint, JSON.stringify({
      model: modelId,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens
    }));
  }
};

/* ---------- 认证 ---------- */
function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}
function showLoginError(msg) {
  showLogin();
  const el = $('#login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearAuthParams(urlObj) {
  for (const k of ['code', 'state', 'provider']) urlObj.searchParams.delete(k);
  history.replaceState(null, '', `${urlObj.pathname}${urlObj.search}${urlObj.hash}`);
}
async function enterApp() {
  const { data: session } = await cloud.auth.getSession();
  if (!session || !session.user) { showLogin(); return; }
  state.session = session;
  state.uid = session.user.id || null;
  state.name = session.user.name || session.user.email || '运维用户';
  try {
    await DB.registerProfile(state.name);
  } catch (e) { /* 已登记过则忽略 */ }
  let profile = null;
  if (state.uid) profile = await DB.getMyProfile(state.uid).catch(() => null);
  state.role = (profile && profile.role) === 'admin' ? 'admin' : 'user';
  DB.logOperation(state.name, '登录', null, 'role=' + state.role);
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#user-chip').innerHTML = `<b>${esc(state.name)}</b><br>${state.role === 'admin' ? '管理运维人员' : '使用人员'}`;
  renderNav();
  await refreshPublishedCache().catch(() => {});
  if (!location.hash || location.hash === '#/') location.hash = '#/ask';
  route();
}

$('#btn-workbuddy-login').addEventListener('click', async () => {
  const btn = $('#btn-workbuddy-login');
  btn.disabled = true;
  try {
    const { data, error } = await cloud.auth.signInWithOAuth({
      provider: 'workbuddy',
      redirectTo: location.origin + '/'
    });
    if (error) { showLoginError(error.message); return; }
    location.assign(data.url);
  } catch (e) {
    showLoginError(e.message || '登录失败，请重试');
  } finally {
    btn.disabled = false;
  }
});
$('#btn-logout').addEventListener('click', async () => {
  await cloud.auth.signOut();
  state.session = null; state.uid = null; state.name = null; state.role = 'user';
  showLogin();
});

/* ---------- 导航与路由 ---------- */
const NAV_DEFS = [
  { hash: '#/ask', label: '智能问答', roles: ['admin', 'user'] },
  { hash: '#/kb', label: '知识库', roles: ['admin', 'user'] },
  { hash: '#/report', label: '问题上报', roles: ['admin', 'user'] },
  { hash: '#/mine', label: '我的上报', roles: ['admin', 'user'] },
  { sep: '管理运维' },
  { hash: '#/review', label: '审核中心', roles: ['admin'], badge: () => state.pendingCount },
  { hash: '#/users', label: '用户管理', roles: ['admin'] },
  { hash: '#/logs', label: '操作日志', roles: ['admin'] }
];
async function refreshPendingCount() {
  if (state.role !== 'admin') return;
  try {
    const rows = await DB.listVisible({ status: '待审核', limit: 100 });
    state.pendingCount = rows.length;
    renderNav();
  } catch (e) { /* ignore */ }
}
function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const def of NAV_DEFS) {
    if (def.sep) {
      if (state.role === 'admin') {
        const s = document.createElement('div');
        s.className = 'nav-section';
        s.textContent = def.sep;
        nav.appendChild(s);
      }
      continue;
    }
    if (!def.roles.includes(state.role)) continue;
    const b = document.createElement('button');
    b.className = 'nav-item';
    b.dataset.hash = def.hash;
    b.innerHTML = esc(def.label) + (def.badge && def.badge() ? `<span class="badge">${def.badge()}</span>` : '');
    b.addEventListener('click', () => { location.hash = def.hash; });
    nav.appendChild(b);
  }
}
function route() {
  if (!state.session) return;
  const hash = location.hash || '#/ask';
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.hash === hash);
  });
  const view = $('#view');
  view.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  const pages = {
    '#/ask': renderAsk, '#/kb': renderKb, '#/report': renderReport, '#/mine': renderMine,
    '#/review': renderReview, '#/users': renderUsers, '#/logs': renderLogs
  };
  const fn = pages[hash] || renderAsk;
  Promise.resolve(fn(view)).catch((e) => {
    view.innerHTML = `<div class="card"><div class="hint-strip">页面加载失败：${esc(e.message)}</div></div>`;
  });
}
window.addEventListener('hashchange', route);

/* ---------- 智能问答 ---------- */
async function renderAsk(view) {
  view.innerHTML = `
    <div class="ask-hero">
      <h2>运维智能问答</h2>
      <p class="page-desc">用一句话描述故障现象，系统自动匹配知识库中最相似的历史案例（相似度阈值 0.85）</p>
    </div>
    <div class="card">
      <div class="ask-box">
        <textarea id="ask-input" maxlength="100" placeholder="例如：产品A 启动失败，报错 connection refused"></textarea>
        <button id="btn-ask" class="btn btn-primary" type="button">提问</button>
      </div>
      <div class="char-count"><span id="ask-count">0</span>/100 字（超出请使用问题上报入口提交完整报错）</div>
      <div id="ask-field-error" class="field-error hidden"></div>
    </div>
    <div id="ask-result"></div>`;

  const input = $('#ask-input');
  const count = $('#ask-count');
  input.addEventListener('input', () => {
    count.textContent = input.value.length;
    count.parentElement.classList.toggle('over', input.value.length >= 100);
    $('#ask-field-error').classList.add('hidden');
  });
  $('#btn-ask').addEventListener('click', () => doAsk());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doAsk();
  });

  async function doAsk() {
    const question = input.value.trim();
    const errEl = $('#ask-field-error');
    errEl.classList.add('hidden');
    // 提交拦截：≤100 字（后端/接口层同规则兜底，防止绕过前端直调）
    if (!question) { errEl.textContent = '请输入问题'; errEl.classList.remove('hidden'); return; }
    if (question.length > 100) {
      errEl.textContent = '问题描述请控制在 100 字以内，如需提交完整报错请使用问题上报入口';
      errEl.classList.remove('hidden');
      return;
    }
    const btn = $('#btn-ask');
    const box = $('#ask-result');
    btn.disabled = true;
    box.innerHTML = '<div class="card"><div class="loading"><div class="spinner"></div>正在检索知识库并匹配相似案例…</div></div>';
    try {
      if (!state.publishedCache) await refreshPublishedCache();
      const published = state.publishedCache || [];
      // ① 本地字符级相似度召回 Top 10（检索不消耗大模型 Token）
      const candidates = window.rankCandidates(question, published, 10).filter((c) => c.localScore > 0.03);
      let hits = [];
      let usedLLM = false;
      let llmError = null;
      if (candidates.length > 0) {
        // ② 大模型语义打分（仅 Top 10 候选片段，控制 Token）
        try {
          const scoreMap = await LLM.scoreMatches(question, candidates.map((c) => ({
            id: c.item.id, title: c.item.title, content: c.item.content
          })));
          usedLLM = true;
          hits = candidates
            .map((c) => ({ item: c.item, score: scoreMap.has(c.item.id) ? scoreMap.get(c.item.id) : 0 }))
            .filter((h) => h.score >= 0.85)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
        } catch (e) {
          llmError = e.message;
        }
        if (!usedLLM) {
          // 模型不可用时的降级：本地词面相似度兜底
          hits = candidates
            .filter((c) => c.localScore >= 0.45)
            .map((c) => ({ item: c.item, score: c.localScore }))
            .slice(0, 5);
        }
      }
      // 命中：引用计数 +1（热度统计）
      for (const h of hits) DB.incrementCite(h.item.id).catch(() => {});
      DB.logOperation(state.name, '智能问答', null, JSON.stringify({
        question_len: question.length, hits: hits.length, mode: usedLLM ? 'llm' : 'lexical'
      }));
      renderAskResult(box, question, hits, { usedLLM, llmError });
    } catch (e) {
      box.innerHTML = `<div class="card"><div class="hint-strip">问答失败：${esc(e.message)}</div></div>`;
    } finally {
      btn.disabled = false;
    }
  }
}

function renderAskResult(box, question, hits, meta) {
  if (!hits.length) {
    box.innerHTML = `
      <div class="card nomatch">
        <div>
          <b>未找到匹配案例</b>
          <div class="kb-sub">知识库中暂无与「${esc(question)}」相似度 ≥ 0.85 的案例，欢迎上报该问题，审核通过后将自动入库。</div>
        </div>
        <div id="ai-thinking" class="solution" style="margin:10px 0;">
          <div class="loading" style="padding:6px 0;"><div class="spinner"></div>AI 正在生成通用排查思路…</div>
        </div>
        <button id="btn-goto-report" class="btn btn-primary" type="button">上报该问题</button>
      </div>`;
    let aiThinkingText = null;
    $('#btn-goto-report').addEventListener('click', () => {
      sessionStorage.setItem('report_prefill', question);
      if (aiThinkingText) sessionStorage.setItem('report_ai_thinking', aiThinkingText);
      else sessionStorage.removeItem('report_ai_thinking');
      location.hash = '#/report';
    });
    // AI 通用排查思路（未命中时兜底，失败静默隐藏）
    (async () => {
      const target = $('#ai-thinking');
      if (!target) return;
      try {
        const thinking = await LLM.suggestThinking(question);
        if (!$('#ai-thinking')) return;
        aiThinkingText = thinking;
        target.innerHTML = '<div class="lbl" style="font-weight:600;margin-bottom:6px;">💡 AI 排查思路（仅供参考，非知识库案例）</div>'
          + esc(thinking).replace(/\r?\n/g, '<br>');
      } catch (e) {
        target.remove();
      }
    })();
    return;
  }
  const note = meta.usedLLM
    ? ''
    : `<div class="hint-strip">大模型语义打分暂不可用（${esc(meta.llmError || '未知原因')}），已降级为关键词匹配，结果仅供参考。</div>`;
  box.innerHTML = note + hits.map((h) => {
    const it = h.item;
    const pct = Math.round(h.score * 100);
    const mid = h.score < 0.92 ? ' mid' : '';
    const isKnowledge = it.kind === '常识知识';
    const bodyHtml = isKnowledge
      ? `<div class="solution">${esc(it.content)}</div>${it.solution ? `<div class="kb-sub" style="margin-top:8px;">补充：${esc(it.solution)}</div>` : ''}`
      : `<div class="kb-sub">${esc(it.content)}</div><div class="solution">${esc(it.solution)}</div>`;
    return `
      <div class="card match-card">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;">
          <b>${esc(it.title)}</b>
          <span class="score-badge${mid}">相似度 ${pct}%</span>
        </div>
        <div class="kb-meta">${isKnowledge ? plainTag('常识知识') : ''}${catTag(it.category)}${it.product ? plainTag(it.product) : ''}${it.module ? plainTag(it.module) : ''}</div>
        ${bodyHtml}
        <div class="match-source">来源：运维知识库/${esc(it.product || '未分类')}/${fmtDate(it.updated_at).slice(0, 7)} · 适用环境：${esc(it.environment || '通用')} · 更新时间：${fmtDate(it.updated_at)} · 被引用 ${it.cite_count || 0} 次</div>
      </div>`;
  }).join('');
}

/* ---------- 知识库列表 ---------- */
async function renderKb(view) {
  const isAdmin = state.role === 'admin';
  view.innerHTML = `
    <div class="page-title">知识库</div>
    <p class="page-desc">按产品、模块、故障分类检索已沉淀的排障案例${isAdmin ? '，可编辑、删除或新增录入' : ''}</p>
    <div class="toolbar">
      <input type="search" id="kb-kw" placeholder="搜索标题 / 报错关键字" />
      <select id="kb-cat"><option value="">全部分类</option>${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select>
      <input type="text" id="kb-product" placeholder="按产品过滤" style="width:150px" />
      ${isAdmin ? `<select id="kb-status"><option value="">全部状态</option>${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select>` : ''}
      <button id="btn-kb-search" class="btn btn-primary" type="button">检索</button>
      ${isAdmin ? `<button id="btn-kb-tpl" class="btn" type="button">下载模板</button>
      <button id="btn-kb-import" class="btn" type="button">批量导入</button>
      <button id="btn-kb-ai" class="btn" type="button">AI 智能入库</button>
      <button id="btn-kb-new" class="btn" type="button">新增录入</button>` : ''}
    </div>
    <div class="card"><div id="kb-list"><div class="loading"><div class="spinner"></div>加载中…</div></div></div>`;

  async function load() {
    const list = $('#kb-list');
    list.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
    try {
      const filters = {
        keyword: $('#kb-kw').value.trim(),
        category: $('#kb-cat').value,
        product: $('#kb-product').value.trim() || null,
        limit: 200
      };
      const statusEl = $('#kb-status');
      if (statusEl && statusEl.value) filters.status = statusEl.value;
      else if (!isAdmin) filters.status = '已发布';
      const rows = await DB.listVisible(filters);
      if (!rows.length) { list.innerHTML = '<div class="empty">暂无符合条件的知识条目</div>'; return; }
      list.innerHTML = rows.map((it) => `
        <div class="kb-row">
          <div class="kb-main">
            <div class="kb-title" data-id="${it.id}">${esc(it.title)}</div>
            <div class="kb-sub">${esc(String(it.content || '').slice(0, 80))}${String(it.content || '').length > 80 ? '…' : ''}</div>
            <div class="kb-meta">${it.kind === '常识知识' ? plainTag('常识知识') : ''}${statusTag(it.status)}${catTag(it.category)}${it.product ? plainTag(it.product) : ''}${it.module ? plainTag(it.module) : ''}${(it.tags || []).slice(0, 4).map(plainTag).join('')}</div>
            <div class="kb-sub">引用 ${it.cite_count || 0} 次 · 更新 ${fmtDate(it.updated_at)}${it.reporter ? ' · 上报人 ' + esc(it.reporter) : ''}</div>
          </div>
          <div class="kb-actions">
            <button class="btn btn-sm btn-view" data-id="${it.id}" type="button">查看</button>
            ${isAdmin ? `<button class="btn btn-sm btn-edit" data-id="${it.id}" type="button">编辑</button>
            <button class="btn btn-sm btn-del" data-id="${it.id}" type="button">删除</button>` : ''}
          </div>
        </div>`).join('');
      list.querySelectorAll('.kb-title, .btn-view').forEach((el) => {
        el.addEventListener('click', () => viewItem(Number(el.dataset.id)));
      });
      list.querySelectorAll('.btn-edit').forEach((el) => {
        el.addEventListener('click', () => editItem(Number(el.dataset.id), () => load()));
      });
      list.querySelectorAll('.btn-del').forEach((el) => {
        el.addEventListener('click', () => confirmDelete(Number(el.dataset.id), () => load()));
      });
    } catch (e) {
      list.innerHTML = `<div class="hint-strip">加载失败：${esc(e.message)}</div>`;
    }
  }
  $('#btn-kb-search').addEventListener('click', load);
  $('#kb-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  const newBtn = $('#btn-kb-new');
  if (newBtn) newBtn.addEventListener('click', () => createItem(() => load()));
  const tplBtn = $('#btn-kb-tpl');
  if (tplBtn) tplBtn.addEventListener('click', downloadTemplate);
  const importBtn = $('#btn-kb-import');
  if (importBtn) importBtn.addEventListener('click', () => importModal(() => load()));
  const aiBtn = $('#btn-kb-ai');
  if (aiBtn) aiBtn.addEventListener('click', () => aiIngestModal(() => load()));
  await load();
}

/* ---------- Excel 模板下载与批量导入（管理员） ---------- */
const TPL_HEADERS = ['标题*', '类型', '知识内容/问题描述*', '解决方案(故障案例必填)', '所属产品', '所属模块', '故障分类', '适用环境', '适用版本', '标签(逗号分隔)'];

function downloadTemplate() {
  if (typeof XLSX === 'undefined') { toast('Excel 组件未加载，请刷新重试', true); return; }
  const rows = [
    TPL_HEADERS,
    ['产品A 启动失败 - connection refused', '故障案例', '产品A 服务启动时报错 connection refused，无法连接依赖的数据库端口，服务反复重启。', '① 检查目标端口是否监听；② 查看服务日志确认依赖是否就绪；③ 重启服务。', '产品A', '服务启动', '网络', '生产环境 / Linux', 'v2.x', 'connection refused,端口,启动失败'],
    ['什么是 inode', '常识知识', 'inode 是 Linux 文件系统的索引节点，存储文件的元数据（权限、大小、时间戳、数据块位置）。每个文件占用一个 inode，inode 耗尽后即使磁盘有空间也无法创建新文件，可用 df -i 查看。', '', 'Linux', '文件系统', '系统', '通用', '', 'inode,linux,文件系统']
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = TPL_HEADERS.map((h, i) => ({ wch: [38, 10, 50, 50, 12, 12, 10, 16, 10, 22][i] }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '知识库');
  // 说明页
  const help = XLSX.utils.aoa_to_sheet([
    ['填写说明'],
    ['1. 带 * 为必填列：标题、知识内容/问题描述。类型为"故障案例"时解决方案必填。'],
    ['2. 类型只允许填：故障案例 / 常识知识（常识知识=基本概念、原理、最佳实践，可不填解决方案）。'],
    ['3. 故障分类只允许填：数据库 / 网络 / 系统 / 应用 / 中间件 / 其他，其他值将归为"其他"。'],
    ['4. 标签用逗号分隔，最多 6 个。'],
    ['5. 请勿在内容中放置真实 IP、账号、密码、密钥；系统导入时会自动脱敏（IP 保留首段，凭据值替换为 ***）。'],
    ['6. 标题与库内已有条目重复的行会被跳过；同一次导入中标题重复的行也只保留第一条。'],
    ['7. 导入后条目立即发布（来源：管理员录入），可在知识库列表中编辑或删除。']
  ]);
  help['!cols'] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(wb, help, '填写说明');
  XLSX.writeFile(wb, '知识库批量导入模板.xlsx');
  toast('模板已下载，请按"填写说明"页准备数据');
}

function importModal(onDone) {
  openModal(`
    <h3>Excel 批量导入</h3>
    <p style="color:var(--text-2);line-height:1.8;">请先点击「知识库 → 下载模板」获取模板并按说明填写，再选择填写好的 .xlsx 文件。<br/>导入内容将自动脱敏并立即发布；与库内或本文件内标题重复的行会被跳过。</p>
    <input type="file" id="imp-file" accept=".xlsx,.xls" style="margin:14px 0;" />
    <div id="imp-preview"></div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">取消</button>
    </div>`);
  $('#imp-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await previewImport(file);
  });

  async function previewImport(file) {
    const box = $('#imp-preview');
    box.innerHTML = '<div class="loading"><div class="spinner"></div>解析文件中…</div>';
    try {
      if (typeof XLSX === 'undefined') throw new Error('Excel 组件未加载');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      if (!grid.length) throw new Error('文件为空');
      // 按表头定位列（容忍列顺序调整）
      const head = grid[0].map((h) => String(h).trim());
      const col = (names) => {
        for (const n of names) {
          const norm = (h) => String(h || '').replace(/\*/g, '').trim();
          let i = head.findIndex((h) => h && norm(h) === n);
          if (i < 0) i = head.findIndex((h) => h && norm(h).startsWith(n));
          if (i >= 0) return i;
        }
        return -1;
      };
      const idx = {
        title: col(['标题']), kind: col(['类型']), content: col(['知识内容/问题描述', '问题描述', '知识内容']),
        solution: col(['解决方案']), product: col(['所属产品']), module: col(['所属模块']),
        category: col(['故障分类']), env: col(['适用环境']), version: col(['适用版本']), tags: col(['标签'])
      };
      if (idx.title < 0 || idx.content < 0) {
        throw new Error('未识别到"标题"或"知识内容/问题描述"列，请使用下载的标准模板');
      }
      const dataRows = grid.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
      if (!dataRows.length) throw new Error('没有数据行');

      // 解析 + 校验
      const existing = await DB.listVisible({ limit: 500 });
      const seenTitles = new Set(existing.map((r) => r.title));
      const valid = [];
      const errors = [];
      for (let i = 0; i < dataRows.length; i++) {
        const r = dataRows[i];
        const rowNo = i + 2;
        const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] || '').trim() : '');
        const title = maskSensitive(get('title'));
        const content = maskSensitive(get('content'));
        const kind = get('kind') === '常识知识' ? '常识知识' : '故障案例';
        const solution = kind === '故障案例' ? maskSensitive(get('solution')) : (get('solution') ? maskSensitive(get('solution')) : null);
        const category = CATEGORIES.includes(get('category')) ? get('category') : '其他';
        const tags = get('tags').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
        if (!title || !content) { errors.push(`第 ${rowNo} 行：标题或知识内容为空`); continue; }
        if (title.length > 80) { errors.push(`第 ${rowNo} 行：标题超过 80 字`); continue; }
        if (kind === '故障案例' && !solution) { errors.push(`第 ${rowNo} 行：故障案例必须填写解决方案`); continue; }
        if (seenTitles.has(title)) { errors.push(`第 ${rowNo} 行：标题「${title.slice(0, 30)}…」与库内/前面行重复，已跳过`); continue; }
        seenTitles.add(title);
        valid.push({
          title, content, solution: solution || null,
          product: maskSensitive(get('product')) || '未分类',
          module: maskSensitive(get('module')) || null,
          category, tags,
          environment: maskSensitive(get('env')) || null,
          version: get('version') || null,
          kind, source: '管理员录入', status: '已发布',
          creator: state.name, auditor: state.name,
          audit_time: new Date().toISOString()
        });
      }
      // 预览
      const previewRows = valid.slice(0, 8).map((v) => `
        <tr><td>${esc(v.title.slice(0, 26))}${v.title.length > 26 ? '…' : ''}</td>
        <td>${plainTag(v.kind)}</td><td>${catTag(v.category)}</td>
        <td>${esc(v.product)}</td></tr>`).join('');
      box.innerHTML = `
        <div class="hint-strip ${errors.length ? '' : 'info'}">
          共解析 <b>${dataRows.length}</b> 行：可导入 <b>${valid.length}</b> 行${errors.length ? `，跳过 <b>${errors.length}</b> 行（见下方）` : ''}。
          确认后导入的条目将立即发布，内容已自动脱敏。
        </div>
        ${previewRows ? `<table class="tbl"><thead><tr><th>标题</th><th>类型</th><th>分类</th><th>产品</th></tr></thead><tbody>${previewRows}</tbody></table>
        ${valid.length > 8 ? `<div class="kb-sub" style="margin-top:6px;">仅预览前 8 行，共 ${valid.length} 行。</div>` : ''}` : ''}
        ${errors.length ? `<div style="max-height:110px;overflow-y:auto;margin-top:8px;"><div class="field-error">${errors.map(esc).join('<br/>')}</div></div>` : ''}
        <div class="modal-actions">
          <button class="btn" type="button" onclick="closeModal()">取消</button>
          <button class="btn btn-primary" id="imp-go" type="button" ${valid.length ? '' : 'disabled'}>确认导入 ${valid.length} 行</button>
        </div>`;
      if (!valid.length) return;
      $('#imp-go').addEventListener('click', async () => {
        const btn = $('#imp-go');
        btn.disabled = true;
        btn.textContent = '导入中…';
        try {
          const CHUNK = 20;
          let inserted = 0;
          for (let i = 0; i < valid.length; i += CHUNK) {
            const rows = valid.slice(i, i + CHUNK);
            await cloud.database.from('knowledge_items').insert(rows);
            inserted += rows.length;
          }
          await DB.logOperation(state.name, '批量导入', null, `导入 ${inserted} 条（跳过 ${errors.length} 条）`);
          toast(`导入完成：${inserted} 条已入库`);
          closeModal();
          await refreshPublishedCache().catch(() => {});
          onDone && onDone();
        } catch (err) {
          toast('导入失败：' + err.message, true);
          btn.disabled = false;
          btn.textContent = `确认导入 ${valid.length} 行`;
        }
      });
    } catch (e) {
      box.innerHTML = `<div class="hint-strip">解析失败：${esc(e.message)}</div>`;
    }
  }
}

async function viewItem(id) {
  openModal('<div class="loading"><div class="spinner"></div>加载中…</div>');
  try {
    const it = await DB.getItem(id);
    if (!it) { openModal('<p>条目不存在或不在可见范围内。</p>'); return; }
    const isKnowledge = it.kind === '常识知识';
    openModal(`
      <h3>${esc(it.title)}</h3>
      <div class="kb-meta" style="margin-bottom:14px;">${isKnowledge ? plainTag('常识知识') : ''}${statusTag(it.status)}${catTag(it.category)}${it.product ? plainTag(it.product) : ''}${it.module ? plainTag(it.module) : ''}</div>
      <div class="detail-block"><div class="lbl">${isKnowledge ? '知识内容' : '问题描述 / 报错现象'}</div><div class="val">${esc(it.content)}</div></div>
      ${it.solution ? `<div class="detail-block"><div class="lbl">${isKnowledge ? '补充说明' : '解决方案 / 处理步骤'}</div><div class="val">${esc(it.solution)}</div></div>` : ''}
      <div class="detail-block"><div class="lbl">适用环境 / 版本</div><div class="val">${esc(it.environment || '通用')}${it.version ? ' · ' + esc(it.version) : ''}</div></div>
      <div class="detail-block"><div class="lbl">来源与追溯</div><div class="val">${esc(it.source)} · 更新 ${fmtDate(it.updated_at)} · 引用 ${it.cite_count || 0} 次${it.reporter ? ' · 上报人 ' + esc(it.reporter) : ''}${it.auditor ? ' · 审核人 ' + esc(it.auditor) : ''}</div></div>
      ${it.audit_opinion ? `<div class="detail-block"><div class="lbl">审核意见</div><div class="val">${esc(it.audit_opinion)}</div></div>` : ''}
      <div class="modal-actions"><button class="btn" type="button" onclick="closeModal()">关闭</button></div>`);
  } catch (e) {
    openModal(`<p>加载失败：${esc(e.message)}</p>`);
  }
}

function itemForm(it, onSaved) {
  const isEdit = !!it;
  it = it || {};
  openModal(`
    <h3>${isEdit ? '编辑知识条目' : '新增录入（管理员）'}</h3>
    <div class="form-row">
      <div><label>条目类型</label><select id="f-kind">
        ${KINDS.map((k) => `<option ${k === (it.kind || '故障案例') ? 'selected' : ''}>${k}</option>`).join('')}
      </select></div>
      <div><label>故障分类 *</label><select id="f-category">${CATEGORIES.map((c) => `<option ${c === (it.category || '其他') ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    </div>
    <label>问题标题 *（一句话概括，≤ 80 字）</label><input type="text" id="f-title" maxlength="80" value="${esc(it.title || '')}" />
    <label id="f-content-lbl">问题描述 / 报错现象 *</label><textarea id="f-content">${esc(it.content || '')}</textarea>
    <div id="f-sol-wrap">
      <label>解决方案 / 处理步骤<span id="f-sol-req"> *</span></label><textarea id="f-solution">${esc(it.solution || '')}</textarea>
    </div>
    <div class="form-row">
      <div><label>所属产品</label><input type="text" id="f-product" value="${esc(it.product || '')}" placeholder="通用类常识可留空" /></div>
      <div><label>所属模块</label><input type="text" id="f-module" value="${esc(it.module || '')}" /></div>
    </div>
    <div class="form-row">
      <div><label>适用环境</label><input type="text" id="f-env" value="${esc(it.environment || '')}" placeholder="生产/测试、OS 等" /></div>
      <div><label>适用版本</label><input type="text" id="f-version" value="${esc(it.version || '')}" /></div>
      <div><label>关键词标签（逗号分隔）</label><input type="text" id="f-tags" value="${esc((it.tags || []).join(','))}" /></div>
    </div>
    ${isEdit ? '' : `<label>状态</label><select id="f-status"><option>已发布</option><option>草稿</option></select><div class="hint-strip info" style="margin-top:10px;">提交时将调用大模型自动校验/补全分类与标签，并对 IP、账号、密钥等敏感信息脱敏。</div>`}
    <div id="f-error" class="field-error hidden"></div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="f-save" type="button">${isEdit ? '保存' : '自动归类并入库'}</button>
    </div>`);
  // 类型切换：常识知识可不填解决方案
  const kindSel = $('#f-kind');
  function syncKindUI() {
    const isK = kindSel.value === '常识知识';
    $('#f-sol-wrap').style.display = isK ? 'none' : '';
    $('#f-content-lbl').textContent = isK ? '知识内容 *（概念、原理、最佳实践等）' : '问题描述 / 报错现象 *';
  }
  kindSel.addEventListener('change', syncKindUI);
  syncKindUI();

  $('#f-save').addEventListener('click', async () => {
    const err = $('#f-error');
    err.classList.add('hidden');
    const kind = $('#f-kind').value;
    const title = $('#f-title').value.trim();
    const content = $('#f-content').value.trim();
    const solution = $('#f-solution').value.trim();
    const product = $('#f-product').value.trim();
    if (!title || !content || (kind === '故障案例' && !solution)) {
      err.textContent = kind === '故障案例' ? '请填写标题、问题描述与解决方案' : '请填写标题与知识内容';
      err.classList.remove('hidden');
      return;
    }
    const btn = $('#f-save');
    btn.disabled = true;
    btn.textContent = isEdit ? '保存中…' : '归类中…';
    try {
      const tags = $('#f-tags').value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      if (isEdit) {
        await DB.updateItem(it.id, {
          kind, title, content,
          solution: kind === '常识知识' ? (solution || null) : solution,
          product: product || (kind === '常识知识' ? '通用' : '未分类'),
          module: $('#f-module').value.trim() || null,
          category: $('#f-category').value,
          environment: $('#f-env').value.trim() || null,
          version: $('#f-version').value.trim() || null,
          tags,
          updated_at: new Date().toISOString()
        });
        await DB.insertAuditLog({ knowledge_id: it.id, auditor: state.name, action: '修改', opinion: '编辑条目' });
        await DB.logOperation(state.name, '编辑条目', it.id, title);
        toast('已保存');
      } else {
        // 管理员录入同样走自动归类 + 脱敏
        let cls = { product, module: $('#f-module').value.trim() || null, category: $('#f-category').value, tags, maskedTitle: title, maskedContent: content };
        try {
          const c = await LLM.classifyReport(title, content);
          cls = { ...cls, product: c.product || product, module: c.module || cls.module, category: c.category, tags: c.tags.length ? c.tags : tags, maskedTitle: c.maskedTitle, maskedContent: c.maskedContent };
        } catch (e) { toast('自动归类不可用，已按手动分类入库'); }
        const status = $('#f-status').value;
        const rows = await DB.insertReport({
          kind,
          title: cls.maskedTitle, content: cls.maskedContent,
          solution: kind === '常识知识' ? (solution || null) : solution,
          product: cls.product || (kind === '常识知识' ? '通用' : '未分类'),
          module: cls.module, category: cls.category, tags: cls.tags,
          environment: $('#f-env').value.trim() || null,
          version: $('#f-version').value.trim() || null,
          source: '管理员录入', status: status === '草稿' ? '草稿' : '已发布',
          auditor: state.name, audit_time: new Date().toISOString(),
          creator: state.name
        });
        await DB.logOperation(state.name, '新增录入', rows[0].id, cls.maskedTitle);
        toast('已入库');
      }
      closeModal();
      await refreshPublishedCache().catch(() => {});
      await refreshPendingCount();
      onSaved && onSaved();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = isEdit ? '保存' : '自动归类并入库';
    }
  });
}
function editItem(id, onSaved) {
  DB.getItem(id).then((it) => it && itemForm(it, onSaved));
}
function confirmDelete(id, onDone) {
  openModal(`
    <h3>删除知识条目</h3>
    <p style="line-height:1.7;">确定删除该条目吗？删除后不可恢复，操作将记入审计日志。</p>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" id="btn-del-confirm" type="button">确认删除</button>
    </div>`);
  $('#btn-del-confirm').addEventListener('click', async () => {
    try {
      await DB.deleteItem(id);
      await DB.logOperation(state.name, '删除条目', id, null);
      toast('已删除');
      closeModal();
      await refreshPublishedCache().catch(() => {});
      onDone && onDone();
    } catch (e) { toast(e.message, true); }
  });
}
function createItem(onSaved) { itemForm(null, onSaved); }

/* ---------- AI 智能入库：资料/处理步骤 → 结构化条目（管理员） ---------- */
function aiIngestModal(onDone) {
  openModal(`
    <h3>AI 智能入库</h3>
    <p style="color:var(--text-2);line-height:1.8;">粘贴产品资料、FAQ 或某个问题的处理步骤，AI 自动拆分整理成结构化知识条目（可编辑），确认后入库。建议单次 ≤ 6000 字；入库前自动脱敏并查重。</p>
    <label>所属产品 *</label>
    <input type="text" id="ai-product" maxlength="30" placeholder="例如：aisort（资料中没有产品信息时也会按此填写）" />
    <label>整理模型</label>
    <select id="ai-model"><option value="">加载模型列表中…</option></select>
    <label>资料 / 处理步骤文本 *</label>
    <textarea id="ai-material" style="min-height:200px;" maxlength="8000" placeholder="粘贴产品文档片段、故障处理记录、操作步骤、聊天记录中的排障过程等原始文本……"></textarea>
    <div class="char-count"><span id="ai-count">0</span>/8000 字</div>
    <div id="ai-err" class="field-error hidden"></div>
    <div id="ai-result"></div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">关闭</button>
      <button class="btn btn-primary" id="ai-parse" type="button">AI 整理</button>
    </div>`);
  const material = $('#ai-material');
  material.addEventListener('input', () => { $('#ai-count').textContent = material.value.length; });

  // 模型选择器：列出可用模型，记住上次选择；哪个模型快/稳就用哪个
  const savedModel = localStorage.getItem('kb_ingest_model') || '';
  (async () => {
    const sel = $('#ai-model');
    if (!sel) return;
    try {
      const models = await LLM.listModels();
      if (!models.length) { sel.innerHTML = '<option value="">（环境未配置模型）</option>'; return; }
      sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('');
      const preferred = savedModel && models.some((m) => m.id === savedModel) ? savedModel : models[0].id;
      sel.value = preferred;
    } catch (e) {
      sel.innerHTML = '<option value="">（默认模型，列表加载失败）</option>';
    }
  })();

  $('#ai-parse').addEventListener('click', async () => {
    const err = $('#ai-err');
    err.classList.add('hidden');
    const product = $('#ai-product').value.trim();
    const text = material.value.trim();
    if (!product) { err.textContent = '请填写所属产品'; err.classList.remove('hidden'); return; }
    if (text.length < 10) { err.textContent = '请粘贴至少 10 字的资料或处理步骤文本'; err.classList.remove('hidden'); return; }
    const btn = $('#ai-parse');
    const modelSel = $('#ai-model');
    const modelId = modelSel ? modelSel.value : '';
    if (modelId) localStorage.setItem('kb_ingest_model', modelId);
    btn.disabled = true;
    btn.textContent = 'AI 整理中…（长文本约需 1-2 分钟）';
    $('#ai-result').innerHTML = '<div class="loading" style="padding:10px 0;"><div class="spinner"></div>正在解析资料并整理知识条目…</div>';
    try {
      const entries = await LLM.organizeMaterial(text, product, modelId || undefined);
      if (!entries.length) {
        $('#ai-result').innerHTML = '<div class="hint-strip">AI 未能从该文本中整理出有效知识条目，请检查内容或换一段更完整的资料。</div>';
        btn.disabled = false;
        btn.textContent = 'AI 整理';
        return;
      }
      renderAiEntries(entries, product, onDone, btn);
    } catch (e) {
      $('#ai-result').innerHTML = '';
      err.textContent = 'AI 整理失败：' + e.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'AI 整理';
    }
  });
}

function renderAiEntries(entries, product, onDone, parseBtn) {
  const catOpts = (v) => CATEGORIES.map((c) => `<option ${c === v ? 'selected' : ''}>${c}</option>`).join('');
  $('#ai-result').innerHTML = `
    <h4 style="margin:14px 0 8px;">整理出 ${entries.length} 条知识条目（可编辑，勾选后入库）</h4>
    ${entries.map((e, i) => `
      <div class="card ai-entry" data-idx="${i}" style="margin-bottom:10px;">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">
          <input type="checkbox" class="ai-check" checked />
          <select class="ai-kind" style="width:120px;"><option ${e.kind === '故障案例' ? 'selected' : ''}>故障案例</option><option ${e.kind === '常识知识' ? 'selected' : ''}>常识知识</option></select>
          <input type="text" class="ai-title" maxlength="80" value="${esc(e.title)}" style="flex:1;" />
        </div>
        <textarea class="ai-content" style="min-height:60px;" placeholder="知识内容 / 问题描述">${esc(e.content)}</textarea>
        <textarea class="ai-solution" style="min-height:60px;${e.kind === '常识知识' ? 'display:none;' : ''}" placeholder="解决方案 / 处理步骤">${esc(e.solution)}</textarea>
        <div class="form-row">
          <div><label>分类</label><select class="ai-cat">${catOpts(e.category)}</select></div>
          <div><label>模块</label><input type="text" class="ai-module" maxlength="30" value="${esc(e.module)}" /></div>
        </div>
        <div class="form-row">
          <div><label>适用环境</label><input type="text" class="ai-env" maxlength="60" value="${esc(e.environment)}" /></div>
          <div><label>适用版本</label><input type="text" class="ai-ver" maxlength="60" value="${esc(e.version)}" /></div>
        </div>
        <label>标签（逗号分隔）</label>
        <input type="text" class="ai-tags" value="${esc(e.tags.join(','))}" />
      </div>`).join('')}
    <div class="modal-actions" style="justify-content:space-between;">
      <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="ai-all" checked /> 全选</label>
      <button class="btn btn-primary" id="ai-save" type="button">入库所选</button>
    </div>`;
  if (parseBtn) { parseBtn.disabled = false; parseBtn.textContent = '重新整理'; }
  $('#ai-all').addEventListener('change', (e) => {
    document.querySelectorAll('#ai-result .ai-check').forEach((c) => { c.checked = e.target.checked; });
  });
  document.querySelectorAll('#ai-result .ai-kind').forEach((sel) => {
    sel.addEventListener('change', () => {
      const card = sel.closest('.ai-entry');
      card.querySelector('.ai-solution').style.display = sel.value === '常识知识' ? 'none' : '';
    });
  });

  $('#ai-save').addEventListener('click', async () => {
    const saveBtn = $('#ai-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '入库中…';
    try {
      // 查重：库内已有标题 + 本次已入库标题
      const existing = await DB.listVisible({ limit: 500 });
      const seen = new Set(existing.map((r) => r.title));
      let saved = 0, skipped = 0;
      const cards = document.querySelectorAll('#ai-result .ai-entry');
      for (const card of cards) {
        if (!card.querySelector('.ai-check').checked) continue;
        const kind = card.querySelector('.ai-kind').value;
        const title = maskSensitive(card.querySelector('.ai-title').value.trim());
        const content = maskSensitive(card.querySelector('.ai-content').value.trim());
        const solution = maskSensitive(card.querySelector('.ai-solution').value.trim());
        if (!title || !content || (kind === '故障案例' && !solution)) { skipped++; continue; }
        if (seen.has(title)) { skipped++; continue; }
        seen.add(title);
        const rows = await DB.insertReport({
          kind, title, content,
          solution: kind === '常识知识' ? (solution || null) : solution,
          product: maskSensitive(product) || '未分类',
          module: maskSensitive(card.querySelector('.ai-module').value.trim()) || null,
          category: card.querySelector('.ai-cat').value,
          environment: maskSensitive(card.querySelector('.ai-env').value.trim()) || null,
          version: card.querySelector('.ai-ver').value.trim() || null,
          tags: card.querySelector('.ai-tags').value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6),
          source: '管理员录入', status: '已发布',
          auditor: state.name, audit_time: new Date().toISOString(),
          creator: state.name
        });
        await DB.logOperation(state.name, 'AI 智能入库', rows[0].id, title);
        saved++;
      }
      toast(`已入库 ${saved} 条${skipped ? `，跳过 ${skipped} 条（重复或必填缺失）` : ''}`);
      closeModal();
      await refreshPublishedCache().catch(() => {});
      onDone && onDone();
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = '入库所选';
      toast(e.message, true);
    }
  });
}

/* ---------- 问题上报 ---------- */
async function renderReport(view) {
  const prefill = sessionStorage.getItem('report_prefill') || '';
  sessionStorage.removeItem('report_prefill');
  // 问答未命中时生成的 AI 排查思路，随上报一并带给管理员
  const aiThinking = sessionStorage.getItem('report_ai_thinking') || '';
  sessionStorage.removeItem('report_ai_thinking');
  const triedPrefill = aiThinking
    ? '【AI 初步排查思路（系统生成，仅供参考，未实际验证）】\n' + aiThinking
    : '';
  view.innerHTML = `
    <div class="page-title">问题上报</div>
    <p class="page-desc">知识库未命中时提交完整报错与说明；提交后由大模型自动归类并脱敏，管理员审核通过后自动入库并通知你。</p>
    <div class="card">
      <label>问题标题 *（一句话概括，≤ 50 字）</label>
      <input type="text" id="rp-title" maxlength="50" placeholder="例如：产品B 发布后定时任务全部未执行" />
      <label>问题描述 *（完整报错、日志片段与现象，≤ 1000 字）</label>
      <textarea id="rp-content" style="min-height:180px;" maxlength="1000" placeholder="请尽量包含：① 报错原文 / 日志片段；② 出现时间与频率；③ 涉及的服务、版本与环境；④ 已尝试过的处理及结果。注意：请勿包含真实 IP、账号密码与密钥，系统会在入库前自动脱敏。">${esc(prefill)}</textarea>
      <div class="char-count"><span id="rp-count">${prefill.length}</span>/1000 字（信息越完整越易命中）</div>
      <div id="rp-dup" class="hint-strip hidden"></div>
      <label>已尝试的处理方法${aiThinking ? '（已自动填入 AI 排查思路，可修改或补充实际执行结果）' : '（可选）'}</label>
      <textarea id="rp-tried" style="min-height:70px;" placeholder="如已尝试某些操作请填写，帮助管理员更快定位">${esc(triedPrefill)}</textarea>
      <div id="rp-error" class="field-error hidden"></div>
      <div style="margin-top:14px;"><button id="btn-report" class="btn btn-primary" type="button">提交上报</button></div>
    </div>`;

  const content = $('#rp-content');
  const count = $('#rp-count');
  let dupTimer = null;
  function checkDup() {
    count.textContent = content.value.length;
    const text = content.value.trim();
    clearTimeout(dupTimer);
    $('#rp-dup').classList.add('hidden');
    if (text.length < 8 || !state.publishedCache) return;
    dupTimer = setTimeout(() => {
      const top = window.rankCandidates(text, state.publishedCache, 1)[0];
      if (top && top.localScore >= 0.55) {
        const el = $('#rp-dup');
        el.textContent = `提示：知识库中已有相似案例《${top.item.title}》（词面相似度 ${Math.round(top.localScore * 100)}%）。若为同一问题，建议先到知识库查看该案例；仍可继续提交，管理员审核时会提示合并。`;
        el.classList.remove('hidden');
      }
    }, 400);
  }
  content.addEventListener('input', checkDup);
  if (prefill) checkDup();

  $('#btn-report').addEventListener('click', async () => {
    const err = $('#rp-error');
    err.classList.add('hidden');
    const title = $('#rp-title').value.trim();
    const desc = content.value.trim();
    const tried = $('#rp-tried').value.trim();
    // 表单校验：上报入口仅限 1000 字上限
    if (!title) { err.textContent = '请填写问题标题'; err.classList.remove('hidden'); return; }
    if (desc.length > 1000) {
      err.textContent = `问题描述当前 ${desc.length} 字，上报入口最多 1000 字`;
      err.classList.remove('hidden');
      return;
    }
    const btn = $('#btn-report');
    btn.disabled = true;
    btn.textContent = '自动归类中…';
    try {
      let cls = {
        product: '未分类', module: null, category: '其他', tags: [],
        maskedTitle: title, maskedContent: desc
      };
      try {
        cls = await LLM.classifyReport(title, desc);
      } catch (e) {
        toast('自动归类暂不可用，已按默认分类提交，管理员会人工归类');
      }
      const solution = tried || '（上报时未提供解决方案，待管理员审核补充）';
      const rows = await DB.insertReport({
        title: cls.maskedTitle,
        content: cls.maskedContent,
        solution,
        product: cls.product,
        module: cls.module,
        category: cls.category,
        tags: cls.tags,
        source: '用户上报',
        status: '待审核',
        reporter: state.name,
        report_time: new Date().toISOString(),
        creator: state.name
      });
      const id = rows[0].id;
      await DB.logOperation(state.name, '问题上报', id, JSON.stringify({ title: cls.maskedTitle, category: cls.category, product: cls.product }));
      await refreshPendingCount();
      view.innerHTML = `
        <div class="card" style="text-align:center;padding:40px;">
          <h2 style="margin-bottom:10px;">上报成功，等待审核</h2>
          <p style="color:var(--text-2);line-height:1.9;">
            上报编号：<b>${reportNo(id)}</b> · 状态：待审核<br/>
            自动归类结果：${catTag(cls.category)} ${plainTag(cls.product)}${cls.module ? ' ' + plainTag(cls.module) : ''}<br/>
            ${cls.tags.length ? '关键词标签：' + cls.tags.map(plainTag).join(' ') + '<br/>' : ''}
            已对 IP、账号、密钥等敏感信息自动脱敏。管理员审核通过后将自动入库并通知你，<br/>可在「我的上报」中随时查看进度。
          </p>
          <div style="margin-top:18px;display:flex;gap:10px;justify-content:center;">
            <button class="btn" type="button" onclick="location.hash='#/mine'">查看我的上报</button>
            <button class="btn" type="button" onclick="location.hash='#/ask'">返回问答</button>
          </div>
        </div>`;
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = '提交上报';
    }
  });
}

/* ---------- 我的上报 ---------- */
async function renderMine(view) {
  view.innerHTML = `
    <div class="page-title">我的上报</div>
    <p class="page-desc">查看本人上报问题的审核进度与结果</p>
    <div class="card"><div id="mine-list"><div class="loading"><div class="spinner"></div>加载中…</div></div></div>`;
  try {
    const rows = await DB.listVisible({ limit: 300 });
    const mine = rows
      .filter((r) => r.owner_id === state.uid && r.source === '用户上报')
      .sort((a, b) => new Date(b.report_time || b.created_at) - new Date(a.report_time || a.created_at));
    const box = $('#mine-list');
    if (!mine.length) {
      box.innerHTML = '<div class="empty">还没有上报记录。问答未命中时可在「问题上报」提交新问题。</div>';
      return;
    }
    box.innerHTML = `<table class="tbl">
      <thead><tr><th>编号</th><th>标题</th><th>归类</th><th>状态</th><th>上报时间</th><th>审核意见</th></tr></thead>
      <tbody>${mine.map((r) => `
        <tr>
          <td style="white-space:nowrap;">${reportNo(r.id)}</td>
          <td><a href="javascript:void(0)" class="kb-title" data-id="${r.id}">${esc(r.title)}</a></td>
          <td>${catTag(r.category)}${r.product ? plainTag(r.product) : ''}</td>
          <td>${statusTag(r.status)}</td>
          <td style="white-space:nowrap;">${fmtDate(r.report_time || r.created_at)}</td>
          <td style="max-width:220px;">${esc(r.audit_opinion || '-')}</td>
        </tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('.kb-title').forEach((el) => {
      el.addEventListener('click', () => viewItem(Number(el.dataset.id)));
    });
  } catch (e) {
    $('#mine-list').innerHTML = `<div class="hint-strip">加载失败：${esc(e.message)}</div>`;
  }
}

/* ---------- 审核中心（管理员） ---------- */
async function renderReview(view) {
  if (state.role !== 'admin') { view.innerHTML = '<div class="card">仅管理运维人员可访问。</div>'; return; }
  view.innerHTML = `
    <div class="page-title">审核中心</div>
    <p class="page-desc">处理待审核上报：通过后自动入库；疑似重复可提示合并；所有操作记入审计日志</p>
    <div class="toolbar" id="rv-tabs">
      ${['待审核', '已驳回', '已发布', '全部'].map((t, i) => `<button class="btn btn-sm rv-tab ${i === 0 ? 'btn-primary' : ''}" data-tab="${t}" type="button">${t}</button>`).join('')}
    </div>
    <div class="card"><div id="rv-list"><div class="loading"><div class="spinner"></div>加载中…</div></div></div>`;

  let currentTab = '待审核';
  const tabsEl = $('#rv-tabs');
  tabsEl.querySelectorAll('.rv-tab').forEach((b) => {
    b.addEventListener('click', () => {
      tabsEl.querySelectorAll('.rv-tab').forEach((x) => x.classList.remove('btn-primary'));
      b.classList.add('btn-primary');
      currentTab = b.dataset.tab;
      load();
    });
  });

  async function load() {
    const box = $('#rv-list');
    box.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
    try {
      let rows = await DB.listVisible({ limit: 300 });
      if (currentTab !== '全部') rows = rows.filter((r) => r.status === currentTab);
      if (!rows.length) { box.innerHTML = `<div class="empty">暂无「${esc(currentTab)}」状态的条目</div>`; return; }
      const published = state.publishedCache || [];
      box.innerHTML = rows.map((it) => {
        // 疑似重复检测（与已发布条目做词面相似度）
        let dup = null;
        if (it.status === '待审核') {
          const top = window.rankCandidates(it.title + ' ' + it.content, published.filter((p) => p.id !== it.id), 1)[0];
          if (top && top.localScore >= 0.55) dup = top;
        }
        return `
        <div class="kb-row">
          <div class="kb-main">
            <div class="kb-title" data-id="${it.id}">${esc(it.title)}</div>
            <div class="kb-sub">${esc(String(it.content || '').slice(0, 100))}${String(it.content || '').length > 100 ? '…' : ''}</div>
            <div class="kb-meta">${statusTag(it.status)}${catTag(it.category)}${it.product ? plainTag(it.product) : ''}${(it.tags || []).slice(0, 4).map(plainTag).join('')}</div>
            <div class="kb-sub">上报人：${esc(it.reporter || '-')} · ${fmtDate(it.report_time || it.created_at)} · 来源：${esc(it.source)}</div>
            ${dup ? `<div class="hint-strip" style="margin-top:8px;">疑似重复：《${esc(dup.item.title)}》（词面相似度 ${Math.round(dup.localScore * 100)}%）。可选择"合并"：驳回本条并增加原案例引用。</div>` : ''}
            ${it.audit_opinion ? `<div class="kb-sub">审核意见：${esc(it.audit_opinion)}</div>` : ''}
          </div>
          <div class="kb-actions">
            <button class="btn btn-sm btn-view" data-id="${it.id}" type="button">查看</button>
            ${it.status === '待审核' ? `
              <button class="btn btn-sm btn-success btn-pass" data-id="${it.id}" type="button">通过</button>
              <button class="btn btn-sm btn-danger btn-reject" data-id="${it.id}" type="button">驳回</button>
              <button class="btn btn-sm btn-edit" data-id="${it.id}" type="button">修改补充</button>
              ${dup ? `<button class="btn btn-sm btn-merge" data-id="${it.id}" data-target="${dup.item.id}" data-target-title="${esc(dup.item.title)}" type="button">合并</button>` : ''}` : ''}
          </div>
        </div>`;
      }).join('');
      box.querySelectorAll('.kb-title, .btn-view').forEach((el) => el.addEventListener('click', () => viewItem(Number(el.dataset.id))));
      box.querySelectorAll('.btn-pass').forEach((el) => el.addEventListener('click', () => passItem(Number(el.dataset.id))));
      box.querySelectorAll('.btn-reject').forEach((el) => el.addEventListener('click', () => rejectItem(Number(el.dataset.id))));
      box.querySelectorAll('.btn-edit').forEach((el) => el.addEventListener('click', () => editItem(Number(el.dataset.id), () => { load(); refreshPendingCount(); })));
      box.querySelectorAll('.btn-merge').forEach((el) => el.addEventListener('click', () => mergeItem(Number(el.dataset.id), Number(el.dataset.target), el.dataset.targetTitle)));
    } catch (e) {
      box.innerHTML = `<div class="hint-strip">加载失败：${esc(e.message)}</div>`;
    }
  }

  async function passItem(id) {
    const it = await DB.getItem(id);
    openModal(`
      <h3>审核通过</h3>
      <div class="detail-block"><div class="lbl">问题</div><div class="val">${esc(it.content)}</div></div>
      <div class="detail-block"><div class="lbl">解决方案</div><div class="val">${esc(it.solution)}</div></div>
      <label>审核意见（可选，将同步给上报人）</label>
      <textarea id="au-opinion" placeholder="例如：方案可行，已补充环境说明"></textarea>
      <div class="hint-strip info" style="margin-top:10px;">通过后将自动入库（状态：已发布），上报人可在「我的上报」中收到结果。</div>
      <div class="modal-actions">
        <button class="btn" type="button" onclick="closeModal()">取消</button>
        <button class="btn btn-success" id="au-ok" type="button">确认通过</button>
      </div>`);
    $('#au-ok').addEventListener('click', async () => {
      try {
        await DB.updateItem(id, {
          status: '已发布',
          auditor: state.name,
          audit_time: new Date().toISOString(),
          audit_opinion: $('#au-opinion').value.trim() || null,
          updated_at: new Date().toISOString()
        });
        await DB.insertAuditLog({ knowledge_id: id, auditor: state.name, action: '通过', opinion: $('#au-opinion').value.trim() || null });
        await DB.logOperation(state.name, '审核通过', id, it.title);
        toast('已通过并入库，上报人可在"我的上报"查看结果');
        closeModal();
        await refreshPublishedCache().catch(() => {});
        await refreshPendingCount();
        load();
      } catch (e) { toast(e.message, true); }
    });
  }

  async function rejectItem(id) {
    const it = await DB.getItem(id);
    openModal(`
      <h3>驳回上报</h3>
      <p style="margin-bottom:10px;">标题：${esc(it.title)}</p>
      <label>驳回理由 *（将同步给上报人）</label>
      <textarea id="rj-opinion" placeholder="例如：信息不完整，请补充报错日志；或与已有案例重复"></textarea>
      <div class="modal-actions">
        <button class="btn" type="button" onclick="closeModal()">取消</button>
        <button class="btn btn-danger" id="rj-ok" type="button">确认驳回</button>
      </div>`);
    $('#rj-ok').addEventListener('click', async () => {
      const opinion = $('#rj-opinion').value.trim();
      if (!opinion) { toast('请填写驳回理由', true); return; }
      try {
        await DB.updateItem(id, {
          status: '已驳回',
          auditor: state.name,
          audit_time: new Date().toISOString(),
          audit_opinion: opinion,
          updated_at: new Date().toISOString()
        });
        await DB.insertAuditLog({ knowledge_id: id, auditor: state.name, action: '驳回', opinion });
        await DB.logOperation(state.name, '审核驳回', id, it.title);
        toast('已驳回');
        closeModal();
        await refreshPendingCount();
        load();
      } catch (e) { toast(e.message, true); }
    });
  }

  async function mergeItem(id, targetId, targetTitle) {
    openModal(`
      <h3>合并重复上报</h3>
      <p style="line-height:1.8;">本条上报将被驳回（理由：与已有案例重复合并），同时原案例《${esc(targetTitle)}》引用次数 +1。<br/>此操作记入审计日志，不可自动撤销。</p>
      <div class="modal-actions">
        <button class="btn" type="button" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" id="mg-ok" type="button">确认合并</button>
      </div>`);
    $('#mg-ok').addEventListener('click', async () => {
      try {
        await DB.updateItem(id, {
          status: '已驳回',
          auditor: state.name,
          audit_time: new Date().toISOString(),
          audit_opinion: `与已有案例《${targetTitle}》重复，已合并`,
          updated_at: new Date().toISOString()
        });
        await DB.insertAuditLog({ knowledge_id: id, auditor: state.name, action: '驳回', opinion: `合并至条目 #${targetId}` });
        await DB.incrementCite(targetId);
        await DB.logOperation(state.name, '合并重复', id, `合并至 #${targetId}`);
        toast('已合并');
        closeModal();
        await refreshPendingCount();
        load();
      } catch (e) { toast(e.message, true); }
    });
  }

  await load();
  await refreshPendingCount();
}

/* ---------- 用户管理（管理员） ---------- */
async function renderUsers(view) {
  if (state.role !== 'admin') { view.innerHTML = '<div class="card">仅管理运维人员可访问。</div>'; return; }
  view.innerHTML = `
    <div class="page-title">用户管理</div>
    <p class="page-desc">RBAC 角色分配：管理运维人员可审核与维护知识库；使用人员可问答、查库与上报。不能修改自己的角色以避免锁死。</p>
    <div class="card"><div id="users-list"><div class="loading"><div class="spinner"></div>加载中…</div></div></div>`;
  async function load() {
    try {
      const rows = await DB.listUsers();
      $('#users-list').innerHTML = `<table class="tbl">
        <thead><tr><th>用户名</th><th>角色</th><th>注册时间</th><th>钉钉 ID</th></tr></thead>
        <tbody>${rows.map((u) => `
          <tr>
            <td><b>${esc(u.name || '未命名')}</b><div class="kb-sub">${u.owner_id === state.uid ? '（当前登录）' : ''}</div></td>
            <td>${u.owner_id === state.uid
              ? (u.role === 'admin' ? plainTag('管理运维人员') : plainTag('使用人员'))
              : `<select data-owner="${esc(u.owner_id)}" data-name="${esc(u.name || '')}" style="width:150px;">
                   <option value="user" ${u.role === 'user' ? 'selected' : ''}>使用人员</option>
                   <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理运维人员</option>
                 </select>`}
            </td>
            <td>${fmtDate(u.created_at)}</td>
            <td>${esc(u.dingtalk_id || '-')}</td>
          </tr>`).join('')}</tbody></table>`;
      $('#users-list').querySelectorAll('select').forEach((sel) => {
        sel.addEventListener('change', async () => {
          const role = sel.value;
          const owner = sel.dataset.owner;
          try {
            await DB.updateUserRole(owner, role);
            await DB.logOperation(state.name, '调整角色', owner, `${sel.dataset.name} → ${role === 'admin' ? '管理运维人员' : '使用人员'}`);
            toast('角色已更新');
          } catch (e) {
            toast(e.message, true);
            load();
          }
        });
      });
    } catch (e) {
      $('#users-list').innerHTML = `<div class="hint-strip">加载失败：${esc(e.message)}</div>`;
    }
  }
  await load();
}

/* ---------- 操作日志 / Token 统计（管理员） ---------- */
async function renderLogs(view) {
  if (state.role !== 'admin') { view.innerHTML = '<div class="card">仅管理运维人员可访问。</div>'; return; }
  view.innerHTML = `
    <div class="page-title">操作日志与 Token 用量</div>
    <p class="page-desc">全部增删改查与审核操作审计；大模型调用按接口维度统计 Token（/ask、/classify）</p>
    <div id="usage-stats"></div>
    <div class="card">
      <div id="logs-list"><div class="loading"><div class="spinner"></div>加载中…</div></div>
    </div>`;
  try {
    const logs = await DB.listOperationLogs(300);
    // Token 用量聚合
    const byEndpoint = {};
    let totalTokens = 0;
    let calls = 0;
    for (const log of logs) {
      if (log.action !== 'llm_call' || !log.detail) continue;
      try {
        const d = JSON.parse(log.detail);
        const ep = log.target_id || 'other';
        byEndpoint[ep] = byEndpoint[ep] || { calls: 0, tokens: 0 };
        byEndpoint[ep].calls += 1;
        byEndpoint[ep].tokens += d.total_tokens || 0;
        totalTokens += d.total_tokens || 0;
        calls += 1;
      } catch (e) { /* ignore */ }
    }
    $('#usage-stats').innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="num">${totalTokens.toLocaleString()}</div><div class="lbl">大模型 Token 总用量</div></div>
        <div class="stat-card"><div class="num">${calls}</div><div class="lbl">模型调用次数</div></div>
        ${Object.keys(byEndpoint).map((ep) => `
          <div class="stat-card"><div class="num">${byEndpoint[ep].tokens.toLocaleString()}</div><div class="lbl">${esc(ep)} · ${byEndpoint[ep].calls} 次调用</div></div>`).join('')}
      </div>`;
    $('#logs-list').innerHTML = `<table class="tbl">
      <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>明细</th></tr></thead>
      <tbody>${logs.map((l) => {
        let detail = l.detail || '';
        if (l.action === 'llm_call') {
          try {
            const d = JSON.parse(l.detail);
            detail = `${d.model} · 输入 ${d.prompt_tokens} / 输出 ${d.completion_tokens} Token`;
          } catch (e) { /* keep raw */ }
        }
        return `<tr>
          <td style="white-space:nowrap;">${fmtDate(l.created_at)}</td>
          <td>${esc(l.operator || '-')}</td>
          <td>${esc(l.action)}</td>
          <td>${esc(l.target_id || '-')}</td>
          <td style="max-width:320px;word-break:break-all;">${esc(detail)}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  } catch (e) {
    $('#logs-list').innerHTML = `<div class="hint-strip">加载失败：${esc(e.message)}</div>`;
  }
}

/* ---------- 启动：回调优先于路由守卫 ---------- */
(async function init() {
  if (typeof WorkBuddyCloud === 'undefined') {
    showLoginError('初始化失败：云服务 SDK 未加载，请刷新页面重试。');
    return;
  }
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('code') || url.searchParams.has('error')) {
      const provider = url.searchParams.get('provider');
      if (provider !== 'workbuddy') {
        showLoginError('授权回调缺少有效的登录方式，请重新登录。');
        return;
      }
      const { data: session, error } = await cloud.auth.handleWorkBuddyCallback();
      if (error) { showLoginError(error.message); return; }
      if (session) {
        clearAuthParams(url);
        await enterApp();
        return;
      }
      // 空 result：非本 provider 回调，按普通访问继续
    }
    const { data: session, error } = await cloud.auth.getSession();
    if (error || !session) { showLogin(); return; }
    await enterApp();
  } catch (e) {
    showLoginError('初始化失败：' + (e.message || e) + '，请刷新重试');
  }
})();

if (typeof cloud !== 'undefined' && cloud.auth && cloud.auth.onAuthStateChange) {
  cloud.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.session = null;
      showLogin();
    }
  });
}
