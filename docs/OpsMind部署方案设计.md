# OpsMind 部署方案设计（三方案：现状托管 / 纯前端本地 / 轻量后端）

> 目标：完整覆盖三种部署形态——**方案 C 当前在用的 WorkBuddy 云服务托管版（基线）**、方案 A 纯前端本地版、方案 B 轻量后端版；后两者可脱离 WorkBuddy 独立部署，并在页面内自定义大模型 API（Base URL / API Key / 模型名），保留现有全部业务功能与界面。
> 版本：v1.1（新增方案 C 现状基线）｜ 编写时间：2026-11-05

**阅读顺序建议**：先看「方案 C（当前在用 · 基线）」了解现状与能力边界 → 再看 A / B 两个演进路线 → 最后看「三、三方案对比与选型」。

| 章节 | 内容 | 适用读者 |
|------|------|----------|
| 零 | 共性前提：需要替换的三件事与端口契约 | 所有人（先读） |
| 方案 C | **当前线上运行的托管版**：规划/分析/设计/模块/算法/业务逻辑/评估 | 运维、评审 |
| 方案 A | 纯前端本地版：IndexedDB + 浏览器直连模型 | 个人/离线场景 |
| 方案 B | 轻量后端版：Node BFF + PostgreSQL + Key 加密 | 团队生产/私有化 |
| 三、四 + 附录 | 三方案对比、选型建议、文件级改造清单、ADR | 决策者 |

---

## 零、共性前提：需要替换的三件事

现有系统（＝方案 C，当前线上版本）依赖 WorkBuddy 云服务提供三类能力。方案 C **原样保留这三层依赖**；方案 A / B 则需等价替换（下表第三列即替换物）：

| 现依赖 | 作用 | 独立部署后 |
|--------|------|------------|
| `cloud.auth` | WorkBuddy 账号免密登录、会话保持 | 自有登录（本地口令 / 账号密码 + JWT） |
| `cloud.database` | PostgreSQL + RLS 行级安全，浏览器直连 | 本地存储（方案 A）或后端 API（方案 B） |
| `cloud.llm` | 免密钥大模型通道（流式） | OpenAI 兼容 API，用户自定义配置 |

**架构解耦的关键决策**：现有 `js/app.js`（约 1800 行视图与交互逻辑）与 `js/similarity.js`（本地检索算法）**完全复用，零改动**。改造只发生在三个适配层：

```
app.js  ──►  api.js（端口/接口层）  ──►  实现①：IndexedDB 仓库（方案 A）
                                     └─►  实现②：REST 客户端（方案 B）
app.js  ──►  llm.js（模型能力层）  ──►  浏览器直连（A）／后端 SSE 代理（B）
```

定义稳定的「端口契约」，两套实现可互换：

```js
// api.js 对外暴露的契约（签名不变）
DB.login(username, password) → { user }
DB.me() → { id, name, role }
DB.listItems(filter) → KnowledgeItem[]
DB.getItem(id) → KnowledgeItem
DB.insertReport(payload) → KnowledgeItem
DB.updateItem(id, patch) → void
DB.deleteItem(id) → void
DB.listReports(mine) → KnowledgeItem[]
DB.audit(id, action, opinion) → void
DB.listLogs() → OperationLog[]
DB.listUsers() → Profile[]
DB.setRole(userId, role) → void
DB.logUsage(endpoint, model, usage) → void

LLM.listModels() → Model[]
LLM.chatJSON(system, user, endpoint, timeoutMs, modelId) → object
LLM.classifyReport(title, content) → { product, module, category, tags, maskedTitle, maskedContent }
LLM.scoreMatches(question, candidates) → Map<id, score>
LLM.suggestThinking(question) → string
LLM.organizeMaterial(text, product, modelId) → Entry[]
```

---

# 方案 A：纯前端本地版（Local-Only）

## A1. 系统规划

### A1.1 定位与边界

| 项 | 内容 |
|----|------|
| 定位 | 单机/个人使用、离线可用、零运维成本的「个人运维知识助手」 |
| 使用者 | 1 人（本机浏览器），可选「本地管理员口令」保护 |
| 明确不支持 | 多人共享数据、跨设备同步、服务端审计、并发写入 |
| 数据边界 | 全部数据存储在浏览器 IndexedDB，清缓存/换浏览器即丢失（需定期导出备份） |
| 交付形态 | 静态站点（Nginx / 对象存储 / GitHub Pages / 本地双击打开需 http 服务） |

### A1.2 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| UI | 原生 HTML/CSS/JS（现有代码） | 零构建、零依赖 |
| 存储 | IndexedDB（无库或极小的 `idb` 封装） | 容量大（数百 MB~GB）、支持索引查询、异步 |
| 登录 | 本地口令 + PBKDF2 派生密钥校验（WebCrypto） | 纯前端无服务端，只能做「本机访问控制」 |
| 大模型 | 浏览器 `fetch` 直连 OpenAI 兼容 API（SSE 流式） | 无需后端；Key 存 IndexedDB |
| 配置 | 页面「系统设置」表单，存 IndexedDB `settings` | 用户自助配置 Base URL / Key / 模型 |
| 部署 | Nginx 静态托管 + HTTPS | 可离线内网部署 |

### A1.3 工期与成本

| 项 | 估算 |
|----|------|
| 开发 | 0.5–1 人日（改 `api.js` + 新增 `store.js` + 设置页 + `llm.js` 改造） |
| 运维 | 几乎为零（静态文件） |
| 硬件 | 任意能跑浏览器的终端 |

### A1.4 演进路线

阶段 1：本地存储 + 直连模型（本期）
阶段 2：加「导出/导入 JSON 全库备份」+ 定时提醒
阶段 3：如需共享 → 平滑升级到方案 B（契约不变，只换 `api.js` 实现）

---

## A2. 系统分析

### A2.1 角色与用例

| 角色 | 说明 | 用例 |
|------|------|------|
| 本机使用者（兼任管理员） | 单用户，默认拥有全部权限 | 登录/登出、问答、查库、上报、审核、批量导入导出、AI 智能入库、配置模型、查看日志、备份数据 |

> 说明：方案 A 的 RBAC 退化为「单一身份」，但仍保留 `role` 字段，便于升级到方案 B 时数据兼容。

### A2.2 功能需求（保留 / 裁剪）

| 功能 | 处理 | 说明 |
|------|------|------|
| 智能问答（100 字限制、Top-K、0.85 阈值、AI 排查思路） | 保留 | 核心价值 |
| 知识库检索与筛选 | 保留 | IndexedDB 索引实现 |
| 管理员录入 / 编辑 / 删除 | 保留 | 本地即可 |
| 问题上报 / 审核 | 保留（简化） | 单用户时上报→自动待审核→可自行审核 |
| Excel 模板下载 / 批量导入 | 保留 | SheetJS 本地打包 |
| AI 智能入库 | 保留 | 直连模型 |
| 用户管理、角色分配 | **裁剪** | 单用户无意义 |
| 操作日志 | 保留（本地） | 便于自查，不支持服务端审计 |
| Token 用量统计 | 保留（本地） | 直连后可拿到真实 usage |
| 钉钉机器人 | 不支持 | 需服务端 |

### A2.3 非功能需求

| 维度 | 指标 / 说明 |
|------|------------|
| 容量 | 1 万条知识条目内检索仍为毫秒级（内存召回）；IndexedDB 上限受浏览器配额约束 |
| 性能 | 首屏 < 1s；本地召回 < 50ms；问答主要耗时在模型网络往返 |
| 安全 | **明确弱点**：API Key 明文存浏览器、无服务端鉴权、可被同机其他程序读取 → 仅适合个人受控环境 |
| 可用性 | 离线可查库；问答依赖外网模型服务 |
| 可维护 | 单文件部署，升级即替换静态资源（需版本号戳避免缓存） |

### A2.4 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| API Key 泄露（浏览器可读） | 额度被盗刷 | 使用**限额子 Key**、仅授权必要模型、定期轮换；不在公用电脑使用 |
| 浏览器清缓存导致数据丢失 | 知识资产丢失 | 「导出全库 JSON」+ 每周提醒；备份文件可再导入 |
| CORS 限制 | 直连部分厂商 API 失败 | 设置页提示需支持 CORS 的服务；或改用支持跨域的代理网关（如 one-api 自建） |
| 多设备数据不一致 | 认知混乱 | 明确定位为单机工具；跨设备用备份文件迁移 |
| IndexedDB 配额被浏览器回收 | 数据丢失 | 申请 `persist()` 持久化权限；提示用户备份 |

---

## A3. 系统设计

### A3.1 总体架构（浏览器内四层）

```
┌────────────────────────────────────────────────────────────┐
│                        浏览器（唯一运行环境）                 │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 视图层 app.js（复用现有：路由/渲染/表单校验/导入导出）  │  │
│  └───────────────┬──────────────────────┬───────────────┘  │
│                  │                      │                  │
│  ┌───────────────▼──────────┐  ┌────────▼───────────────┐  │
│  │ 数据端口 api.js           │  │ 模型端口 llm.js         │  │
│  └───────────────┬──────────┘  └────────┬───────────────┘  │
│                  │                      │                  │
│  ┌───────────────▼──────────┐  ┌────────▼───────────────┐  │
│  │ store.js（IndexedDB 仓库）│  │ llm-client.js（SSE）    │  │
│  │ 对象仓：knowledge/audit/  │  │ 看门狗/重试/内容抢救     │  │
│  │ logs/settings             │  │ 解析器 parseLoose       │  │
│  └──────────────────────────┘  └────────┬───────────────┘  │
│                                          │ fetch(SSE)      │
└──────────────────────────────────────────┼──────────────────┘
                                           ▼
                             OpenAI 兼容 API（用户自填 Key）
```

### A3.2 数据模型（IndexedDB）

```js
// 数据库：opsmind，版本 1
knowledge: { keyPath:'id', autoIncrement:true,
             indexes: { by_status, by_product, by_category, by_updated,
                        by_title（唯一性靠应用层归一化查重） } }
  字段：与现有 knowledge_items 表 1:1（id/title/content/kind/product/module/
        category/solution/environment/version/tags/source/status/reporter/
        report_time/auditor/audit_time/audit_opinion/cite_count/creator/
        created_at/updated_at）

audit:     { keyPath:'id', autoIncrement:true, indexes:{ by_knowledge } }
logs:      { keyPath:'id', autoIncrement:true, indexes:{ by_created } }
settings:  { keyPath:'key' }   // llm.baseUrl / llm.apiKey / llm.model / llm.timeoutMs / auth.hash / auth.salt
usage:     { keyPath:'id', autoIncrement:true, indexes:{ by_endpoint, by_time } }  // Token 统计
```

**为什么保留与云端一致的表结构**：升级方案 B 时可直接把这些记录导出成 SQL/Excel，无需字段映射。

### A3.3 部署架构

```
[浏览器] ──HTTPS──► [Nginx 静态站点]           （可选内网/本地）
       └──HTTPS──► [大模型 API 服务]（外网）
```

---

## A4. 模块划分

| 模块 | 文件 | 职责 | 关键点 |
|------|------|------|--------|
| 视图与交互 | `js/app.js` | 路由、页面渲染、表单校验、导入导出 UI | **零改动** |
| 本地检索 | `js/similarity.js` | 字符级相似度召回 Top-K | **零改动** |
| 数据端口 | `js/api.js` | 契约实现（改为调 store.js） | 替换实现，签名不变 |
| 本地仓库 | `js/store.js`（新） | IndexedDB 封装：增删改查、索引查询、事务、备份导入导出 | 新增 |
| 模型端口 | `js/llm.js` | 提示词与 JSON 解析（复用），传输层改为 fetch | 改传输层 |
| 模型客户端 | `js/llm-client.js`（新） | SSE 解析、看门狗、重试、内容抢救、错误归一化 | 新增 |
| 本地认证 | `js/local-auth.js`（新） | PBKDF2 口令设置/校验、会话标记（sessionStorage） | 新增 |
| 设置页 | `js/settings-view.js`（新） | Base URL / Key / 模型 / 超时配置、连通性测试、备份恢复 | 新增 |
| 配置 | `js/config.js` | 仅保留 `APP_NAME` 等常量 | 删 endpoint/key |

---

## A5. 关键算法

### A5.1 混合检索（本地召回 + 模型重排）

```
输入：question（≤100 字）
1) 归一化：去标点/空白、英文转小写、全角转半角
2) 特征：字符 bigram 集合 Sq；对每条知识构建 (title×2 + content + tags + solution) 的 bigram 集合 Sk
3) 相似度：score = |Sq ∩ Sk| / sqrt(|Sq|·|Sk|)    （余弦形，抗长文本稀释）
4) 召回：按 score 降序取 Top 10（无模型参与，控费）
5) 重排：LLM.scoreMatches(question, top10) 返回 0~1 语义分
6) 过滤：score ≥ 0.85 保留，取前 5；命中则按分数降序展示，累计 cite_count
7) 未命中：展示「AI 排查思路」+「上报该问题」入口
```

**降级链**：模型超时/失败 → 直接用本地 score ≥ 0.45 的候选作为结果（附降级提示）。

### A5.2 SSE 流式解析状态机

```
状态：IDLE → FIRST_CHUNK → STREAMING → DONE
每收到一段：按 "\n\n" 切事件；行前缀 "data: " 取值
  - "[DONE]" → DONE
  - JSON.parse 失败 → 丢弃该事件（不中断）
  - choices[0].delta.content → 追加到缓冲区
  - usage 字段 → 记录 Token
看门狗：
  FIRST_CHUNK 超过 20s 未到 → 判定挂起（可重试）
  STREAMING 阶段 30s 无新事件 → 判定挂死 → 若缓冲区已含 JSON 边界，按完成处理（内容抢救）
```

### A5.3 内容抢救与宽松解析

```js
parseLoose(text):
  1) 空文本 → 抛 EMPTY_OUTPUT（触发重试）
  2) 剥离 ```json 围栏
  3) 取首个 '{' 到末个 '}' 的子串（去掉前后解释性文字）
  4) JSON.parse；失败则尝试补齐未闭合的引号/括号（最多 3 层）
  5) 仍失败 → 抛错（触发重试，最多 3 次，共享总时限）
```

### A5.4 本机口令（PBKDF2）

```
注册：salt = random(16B)；hash = PBKDF2-SHA256(password, salt, 210000, 32B)
校验：constantTimeEqual(hash, PBKDF2(input, salt))
会话：sessionStorage 存 {at: 时间戳}，超过 12h 失效；仅作本机访问控制，不提供数据加密
```

### A5.5 脱敏流水线

```
① 正则层：IP(v4/v6) → 保留首段掩码（10.0.0.1 → 10.*.*.*）；账号/密码/密钥/Token/AK/SK 的
   key=value 形式 → 值替换 ***；内网域名 → ****.internal
② 模型层：LLM 重写 title/content，指令要求「语义不变、只掩码敏感值」
③ 兜底层：写入前再跑一次正则（防止模型漏掩）
④ 白名单：JDK 默认值 changeit、示例占位符等不掩码，保证步骤可执行
```

### A5.6 标题查重

```
normalize(t) = 去空白/标点、小写、去掉「如何处理/怎么解决」等停用词
重复判定：normalize 后完全相等，或 bigram 相似度 ≥ 0.9 → 视为重复（提示合并/跳过）
```

---

## A6. 业务逻辑

### A6.1 智能问答流程

```
用户输入(≤100字, maxlength + 实时计数 + 提交拦截)
   │
   ├─ 本地召回 Top10 ──(候选为空)──► 未命中分支
   │        │
   │        ▼
   │   LLM 语义打分（20s 首结果看门狗，失败降级关键词）
   │        │
   │   ≥0.85 ? ─否─► 未命中分支：AI 排查思路(异步) + 上报入口
   │        │是
   │        ▼
   │   取前 5 展示：标题/相似度/分类/解决方案/来源/适用环境/更新时间
   │   cite_count += 1；写问答日志
   ▼
「上报该问题」→ 携带 AI 思路到上报表单（前缀标注「系统生成，未验证」）
```

### A6.2 上报与审核状态机（方案 A 简化）

```
草稿 ──提交──► 待审核 ──通过──► 已发布（参与召回）
                  │  └──驳回──► 已驳回 ──修改后重提──► 待审核
                  └──修改补充──► 待审核（记录审核意见）
归档：管理员手动（不参与召回）
```

### A6.3 AI 智能入库流程

```
粘贴文本(≤8000字) + 产品名 + 选择模型
   │
   ▼ 提示词：拆分规则 + 整理规则 + 脱敏规则 + 最多10条 + 只输出 JSON
模型返回 → parseLoose → 逐条规范化（kind 枚举校验/分类兜底/tags 截断）
   │
   ▼ 卡片预览（可改类型/标题/内容/解决方案，可取消勾选）
   │
   ▼ 查重（normalize 标题）→ 入库（status=已发布, source=管理员录入）→ 写日志
```

---

## A7. 落地步骤

1. 新增 `store.js`：IndexedDB 建库、CRUD、索引查询、导入导出
2. 改写 `api.js`：签名不变，内部转调 `store.js`；`DB.login` 改本地口令
3. 新增 `local-auth.js` + 登录页表单（替换 WorkBuddy 登录按钮）
4. 改写 `llm.js` 传输层 → `llm-client.js`（fetch + SSE + 看门狗 + 抢救）
5. 新增设置页：模型配置 + 「测试连接」（发一条 1 token 的请求验证）+ 备份恢复
6. 删除 `js/vendor/workbuddy-cloud-sdk.global.js` 引用与 `cloud.js`
7. 自测：登录→录入→问答→上报→审核→导入导出→备份恢复
8. 部署：Nginx 托管 + 资源版本戳

---
---

# 方案 B：轻量后端版（BFF + PostgreSQL）

## B1. 系统规划

### B1.1 定位与边界

| 项 | 内容 |
|----|------|
| 定位 | 团队共享的运维知识中台，可替代现 WorkBuddy 托管形态，完全自主可控 |
| 使用者 | 多用户，双角色（管理运维人员 / 使用人员），可扩展多产品线 |
| 数据 | PostgreSQL 集中存储，支持备份、审计、报表 |
| 部署 | 单机 Docker Compose（app + db + nginx），可平滑扩到多副本 |
| 关键安全要求 | **API Key 仅存服务端并加密**；浏览器不接触任何密钥 |

### B1.2 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| 前端 | 现有原生 JS（复用 `app.js` / `similarity.js`） | 零构建、改造面小 |
| BFF | Node.js 20 + Express 4 | 与前端同语言，团队易维护 |
| 数据库 | PostgreSQL 15（`pg` 驱动，无 ORM 或轻量 knex） | 沿用现有表结构，支持 JSONB/全文索引 |
| 认证 | bcrypt + JWT（httpOnly Cookie）+ CSRF 双提交 | 自托管标准做法 |
| 模型代理 | 自定义 SSE 转发路由 | 隐藏 Key、解决 CORS、可限流计量 |
| 反代 | Nginx（TLS 终止、静态资源、`/api` 反代、SSE 关闭缓冲） | SSE 必须 `proxy_buffering off` |
| 部署 | Docker + docker-compose | 一条命令起环境 |
| 可选 | Redis（会话/限流）、Prometheus（指标） | 规模上来再加 |

### B1.3 工期与成本

| 阶段 | 内容 | 估算 |
|------|------|------|
| P1 | 后端骨架 + 认证 + 知识库/上报/审核 CRUD | 1 人日 |
| P2 | LLM 代理（SSE）+ 设置页 + 加密存储 | 0.5 人日 |
| P3 | 前端适配（api.js 换 REST）+ 联调 | 0.5 人日 |
| P4 | 部署脚本、迁移工具、压测与文档 | 0.5 人日 |
| 合计 | | 2–2.5 人日 |

---

## B2. 系统分析

### B2.1 角色与权限矩阵

| 能力 | 使用人员 (user) | 管理运维人员 (admin) |
|------|:---:|:---:|
| 问答 / 查库（仅已发布） | ✔ | ✔ |
| 上报问题 / 查看本人上报 | ✔ | ✔ |
| 审核（通过/驳回/修改/合并） | ✖ | ✔ |
| 知识条目增删改 | ✖ | ✔ |
| 批量导入 / AI 智能入库 | ✖ | ✔ |
| 模型配置 / 用户角色管理 | ✖ | ✔ |
| 操作日志 / 用量报表 | 仅本人 | 全量 |

### B2.2 核心用例（时序文字化）

**UC-01 智能问答**
```
用户 → 前端：输入问题(≤100字)
前端 → BFF：GET /api/knowledge?status=已发布（带 ETag 缓存，仅取 id/title/content/tags）
前端：本地召回 Top10
前端 → BFF：POST /api/llm/score {question, candidates[10]}
BFF → 模型：chat/completions（system=打分引擎，stream）
BFF → 前端：SSE 流（逐块转发，不落库）
前端：按 0.85 过滤 → 渲染 Top5 → POST /api/knowledge/:id/cite
```

**UC-02 问题上报与审核**
```
用户 → BFF：POST /api/reports {title, content, tried}
BFF：调用 LLM 归类+脱敏（失败则用本地正则兜底）→ 落库 status=待审核
管理员 → BFF：GET /api/reports?status=待审核
管理员 → BFF：POST /api/reports/:id/audit {action:通过|驳回|修改, opinion}
BFF：事务内 更新条目状态 + 写 audit_logs + 写 operation_logs
```

**UC-03 模型配置**
```
管理员 → BFF：PUT /api/settings/llm {baseUrl, apiKey, model, temperature, timeoutMs}
BFF：AES-256-GCM 加密 apiKey（主密钥来自环境变量 LLM_ENC_KEY）→ 存 llm_settings
管理员 → BFF：POST /api/settings/llm/test → 发一次最小请求，返回 ok/耗时/错误
前端：Key 只回显掩码 sk-****ab12
```

### B2.3 功能需求（新增项）

| 需求 | 说明 |
|------|------|
| 模型配置中心 | Base URL / Key / 模型名 / 温度 / 超时 / 每接口最大 Token；支持多套配置并选默认 |
| 连通性测试 | 保存前一键测试，返回延迟与错误原因（DNS/401/429/超时） |
| 用量统计 | 按接口（/ask、/classify、/organize）累计 prompt/completion tokens、调用次数、平均延迟 |
| 备份恢复 | `pg_dump` 定时任务 + 页面「导出全库」 |
| 审计 | 全部写操作留痕（操作人、动作、目标、明细、IP、时间） |

### B2.4 非功能需求

| 维度 | 目标 |
|------|------|
| 并发 | 50 并发问答（模型侧为主要瓶颈，BFF 无状态可水平扩） |
| 响应 | 列表接口 P95 < 200ms；问答首 token < 3s（取决于模型） |
| 可用性 | 单机 99.5%；模型故障时自动降级关键词匹配，问答不中断 |
| 安全 | Key 加密存储、传输 HTTPS、登录失败限流（5 次/分/IP）、JWT 2h + 刷新、操作审计 |
| 合规 | 入库前脱敏（IP/账号/密钥）、日志留存 180 天、数据导出可控 |
| 可观测 | 结构化日志（JSON）、`/healthz`、慢请求告警（>10s） |

### B2.5 风险与对策

| 风险 | 对策 |
|------|------|
| 模型厂商限流/欠费 | 多配置切换 + 降级到本地关键词 + 用量告警阈值 |
| SSE 被反代缓冲导致"卡住不输出" | Nginx `proxy_buffering off`、`proxy_read_timeout 300s`、`X-Accel-Buffering: no` |
| Key 泄漏 | 加密存储 + 掩码回显 + 仅 admin 可改 + 审计留痕 + 支持轮换 |
| 数据丢失 | 每日 `pg_dump` + 异地保存 + 页面手动导出 |
| 单点故障 | Compose 加 `restart: always`；DB 数据卷独立；后续可加只读副本 |

---

## B3. 系统设计

### B3.1 总体架构

```
┌──────────┐   HTTPS    ┌───────────────┐   /api    ┌──────────────────────┐
│ 浏览器    │──────────►│ Nginx          │─────────►│ Node BFF (Express)   │
│ (前端SPA) │◄──SSE─────│ 静态 + 反代     │◄──SSE───│  auth / routes /     │
└──────────┘            └───────────────┘          │  services / llm-proxy│
                                                    └────┬────────────┬────┘
                                                         │ pg         │ HTTPS
                                                         ▼            ▼
                                                  ┌───────────┐  ┌────────────────┐
                                                  │PostgreSQL │  │ OpenAI 兼容 API │
                                                  │ 4+1 张表  │  │ (用户自定义)     │
                                                  └───────────┘  └────────────────┘
```

### B3.2 分层与目录

```
server/
├── index.js              # 启动、中间件装配、优雅退出
├── config.js             # 环境变量读取与校验（fail fast）
├── db.js                 # pg Pool、事务助手 withTx()
├── middleware/
│   ├── auth.js           # JWT 校验 → req.user；requireRole('admin')
│   ├── rate-limit.js     # 登录与模型接口限流
│   ├── error.js          # 统一错误码与响应格式
│   └── audit.js          # 写操作自动留痕
├── routes/
│   ├── auth.js           # login/logout/me/change-password
│   ├── knowledge.js      # 列表/详情/新增/更新/删除/引用计数/导入
│   ├── reports.js        # 上报/我的上报/待审核/审核
│   ├── settings.js       # LLM 配置读写、连通性测试、用户与角色
│   ├── llm.js            # /chat（SSE 代理）、/models
│   └── logs.js           # 操作日志、用量统计
├── services/
│   ├── llm.js            # 提示词、脱敏流水线、JSON 宽松解析、重试
│   ├── crypto.js         # AES-256-GCM 加解密、掩码
│   └── knowledge.js      # 状态机、查重、合并
└── sql/
    ├── schema.sql        # 表结构（沿用现有 + llm_settings + users）
    └── seed.sql
```

### B3.3 数据模型

```sql
-- 沿用现有 4 张表（knowledge_items / audit_logs / profiles→users / operation_logs）
-- 改动点：
-- 1) 去掉 RLS（权限收到 BFF 层），保留 owner_id 便于归属追踪
-- 2) users 增加 password_hash、status、last_login_at
-- 3) 新增 llm_settings

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,          -- bcrypt(cost=12)
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  dingtalk_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE llm_settings (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,                   -- 配置别名，如「DeepSeek-生产」
  base_url TEXT NOT NULL,               -- https://api.deepseek.com/v1
  api_key_enc BYTEA NOT NULL,           -- AES-256-GCM 密文
  api_key_iv BYTEA NOT NULL,
  api_key_tag BYTEA NOT NULL,
  api_key_mask TEXT NOT NULL,           -- sk-****ab12（仅回显）
  model TEXT NOT NULL,
  temperature NUMERIC(3,2) DEFAULT 0.2,
  max_tokens INTEGER DEFAULT 1500,
  timeout_ms INTEGER DEFAULT 120000,
  is_default BOOLEAN DEFAULT false,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE usage_stats (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,               -- /ask | /classify | /organize
  model TEXT,
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  latency_ms INT,
  ok BOOLEAN DEFAULT true,
  err_code TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_usage_time ON usage_stats(created_at);
CREATE INDEX idx_ki_status ON knowledge_items(status);
CREATE INDEX idx_ki_title_norm ON knowledge_items(normalize_title(title));
```

### B3.4 接口设计（REST）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | 匿名（限流） | 返回 JWT（httpOnly Cookie）+ 用户信息 |
| POST | `/api/auth/logout` | 登录 | 清除 Cookie |
| GET | `/api/auth/me` | 登录 | 当前用户与角色 |
| GET | `/api/knowledge` | 登录 | 支持 `q/product/module/category/status/kind/page`；user 仅见已发布+自己上报 |
| GET | `/api/knowledge/:id` | 登录 | 详情（user 无权查看非已发布且非本人） |
| POST | `/api/knowledge` | admin | 新增（自动归类+脱敏，status 可指定） |
| PUT | `/api/knowledge/:id` | admin | 编辑（写审计） |
| DELETE | `/api/knowledge/:id` | admin | 软删除（`已归档`）+ 审计 |
| POST | `/api/knowledge/:id/cite` | 登录 | 引用计数 +1 |
| POST | `/api/knowledge/import` | admin | 批量导入（逐行校验、查重、脱敏） |
| POST | `/api/reports` | 登录 | 上报（LLM 归类+脱敏，status=待审核） |
| GET | `/api/reports` | 登录 | `mine=1` 我的上报；admin 看全部 |
| POST | `/api/reports/:id/audit` | admin | `{action, opinion}` 事务处理 |
| GET/PUT | `/api/settings/llm` | admin | 模型配置（GET 返回掩码） |
| POST | `/api/settings/llm/test` | admin | 连通性测试 |
| GET | `/api/llm/models` | admin | 代理 `/models` |
| POST | `/api/llm/chat` | 登录（限流） | **SSE 流式代理**，按 `endpoint` 记用量 |
| GET | `/api/logs` | admin | 操作日志分页 |
| GET | `/api/logs/usage` | admin | 用量聚合（按接口/天） |
| GET | `/api/users` | admin | 用户列表 |
| PATCH | `/api/users/:id` | admin | 改角色/禁用 |

统一响应：`{ ok:true, data }` / `{ ok:false, code, message }`；错误码 `AUTH_401 / FORBID_403 / VALID_400 / LLM_TIMEOUT / LLM_UPSTREAM / DB_500`。

### B3.5 LLM 代理设计（关键）

```
POST /api/llm/chat
body: { endpoint:'/ask', system, user, modelId?, timeoutMs?, temperature? }
  ↓ 鉴权 + 限流（按用户 10 次/分）
  ↓ 取 llm_settings（解密 Key）
  ↓ fetch(baseUrl + '/chat/completions', { stream:true, signal })
  ↓ 逐块转发：res.write(`data: ${chunk}\n\n`)；响应头
      Content-Type: text/event-stream
      Cache-Control: no-cache, no-transform
      X-Accel-Buffering: no          ← 防 Nginx 缓冲
  ↓ 结束：写 usage_stats（含首 token 延迟、总耗时、错误码）
  ↓ 客户端断开：req.on('close') → controller.abort() → 中止上游请求，记账为 aborted
安全：system 提示词由服务端按 endpoint 白名单注入，前端不能任意覆盖（防提示词越权）
```

---

## B4. 模块划分

### B4.1 前端（复用现有 + 3 处适配）

| 模块 | 文件 | 改动 |
|------|------|------|
| 视图 | `app.js` | 仅改登录页表单与「系统设置」入口 | 
| 检索 | `similarity.js` | 无改动 |
| 数据端口 | `api.js` | 内部改 `fetch('/api/...')`，签名不变 |
| 模型端口 | `llm.js` | 改调 `POST /api/llm/chat`（SSE 解析逻辑复用） |
| 认证 | `auth.js`（新） | 登录/登出/`me()`，401 自动跳登录 |
| 设置页 | `settings-view.js`（新） | 模型配置、测试连接、用量看板 |
| 删除 | `cloud.js`、`js/vendor/*` | 移除 |

### B4.2 后端模块（职责单一，见 B3.2 目录）

| 模块 | 核心职责 | 对外契约 |
|------|----------|----------|
| auth | 登录、会话、角色判定 | `login/logout/me` |
| knowledge | 条目 CRUD、状态机、查重、合并 | REST |
| reports | 上报、审核事务 | REST |
| llm-proxy | 流式转发、超时、中断、计量 | `POST /api/llm/chat` |
| settings | 模型配置、加密、测试 | REST |
| audit | 写操作留痕（中间件） | 自动 |
| logs | 查询与聚合 | REST |
| crypto | AES-256-GCM、掩码 | 内部 |
| knowledge-svc | 提示词、脱敏、解析、重试 | 内部 |

---

## B5. 关键算法

### B5.1 混合检索（与 A 相同，差异在数据来源与缓存）

```
GET /api/knowledge?status=已发布&lite=1  → 返回 {id,title,content,tags,solution}（ETag + 304）
前端 localSearch(question, candidates, K=10)
  → POST /api/llm/chat {endpoint:'/ask'} 语义打分
  → 阈值 0.85 过滤 → Top5 → 渲染 + cite
降级：LLM 失败 → 本地 score ≥ 0.45 直接返回（标注「关键词匹配，未经语义校验」）
```

### B5.2 SSE 双看门狗 + 内容抢救（服务端与前端各一层）

```
服务端看门狗（保护上游）：
  首字节 20s 未到 → abort 上游，返回 {code:'LLM_TIMEOUT_FIRST'}（前端可重试）
  流空闲 30s → abort，若已转发内容则补发 done 事件（前端按完成处理）
前端看门狗（保护 UI）：
  同样的阈值，防止 BFF 自身卡死；收到 done 即解析缓冲区
重试：前端最多 3 次，共享总时限；服务端不重试（避免双倍计费）
```

### B5.3 Key 加密（AES-256-GCM）

```
加密：iv=random(12B)；{ct, tag} = AESGCM(key=LLM_ENC_KEY, iv, plaintext)
存储：api_key_enc / api_key_iv / api_key_tag 三列；mask = 首3 + '****' + 末4
解密：仅 llm-proxy 调用时内存解密，不写日志、不进错误栈（错误信息脱敏）
轮换：主密钥支持双版本（LLM_ENC_KEY + LLM_ENC_KEY_OLD），可灰度重加密
```

### B5.4 JWT 会话

```
access: HS256，2h，payload {uid, role, jti}；存 httpOnly+Secure+SameSite=Lax Cookie
刷新：滑动续期（剩余 < 30min 时下发新 token）
撤销：users.status=disabled 或 token_version 递增 → 中间件拒绝
CSRF：非 GET 请求校验 double-submit token（Header 与 Cookie 比对）
```

### B5.5 脱敏流水线（服务端执行，前端不再持有原文）

```
① 前端提交原文 → ② 服务端正则预掩码（IP/凭据/内网域名）
③ LLM 二次脱敏重写（语义不变） → ④ 正则兜底再扫
⑤ 敏感词命中检查（可选：内网域名清单）→ 命中则降级为「仅存掩码版 + 标记待人工复核」
⑥ 落库；原文不落库、不入日志
```

### B5.6 批量导入校验与查重

```
逐行：必填校验（标题/内容/故障案例需解决方案）→ 枚举归一（kind/category）
     → 脱敏 → normalize_title 计算
查重：① 与库内 normalize_title 相等 → 跳过（提示合并）
     ② 与同批次前面行相等 → 跳过（同批去重）
     ③ bigram ≥ 0.9 → 标记「疑似重复」待人工确认
入库：分批事务（每 50 行），失败回滚该批并返回失败行号与原因
```

### B5.7 用量与成本观测

```
每次模型调用落 usage_stats（endpoint/model/prompt/completion/latency/ok/err_code）
聚合视图：
  日趋势：date_trunc('day', created_at)
  接口占比：GROUP BY endpoint
  成本估算：tokens × 单价（配置在 llm_settings.unit_price，可选）
告警：日 tokens > 阈值 → 日志 warn + 页面红标（管理员可见）
```

---

## B6. 业务逻辑

### B6.1 问答主流程（含三级降级）

```
① 正常：本地召回 → 模型打分 → 0.85 过滤 → Top5 展示
② 一级降级：模型超时/失败 → 本地 score ≥ 0.45 结果 + 「未经语义校验」标注
③ 二级降级：本地也无候选 → 「未找到匹配」+ AI 排查思路（模型可用时）+ 上报入口
每次问答都写 operation_logs（问题摘要、命中条目、耗时、降级级别）
```

### B6.2 审核状态机（完整版）

```
        ┌──────── 驳回（附意见） ────────┐
        ▼                                │
   已驳回 ──修改后重提──► 待审核 ──通过──► 已发布 ──手动──► 已归档
                            │                              │
                            └──修改补充（不改变状态）        └──恢复──► 已发布

规则：
- 仅 admin 可迁移状态；每次迁移写 audit_logs + operation_logs（同一事务）
- 通过时：status=已发布、auditor/audit_time 落值、上报人可见结果与意见
- 疑似重复：提示「与 #id 相似度 0.92，是否合并」→ 合并 = 保留主条目、被并条目置已归档并附指针
```

### B6.3 权限校验逻辑（替代 RLS）

```
中间件顺序：auth（验证 JWT）→ requireRole（admin/user）→ resourceGuard（归属校验）→ handler
resourceGuard 规则：
  knowledge: user 仅可读 status=已发布 或 owner_id=self
  reports:   user 仅可读 mine=1，仅可改自己的待审核单（不可自审）
  settings/users/logs: admin only
禁止自审：audit 时校验 knowledge.reporter_uid ≠ req.user.uid（除 admin 双人复核开关关闭时）
```

### B6.4 知识闭环

```
提问 → 命中 → 采纳/引用计数 +1
未命中 → 上报 → 审核通过 → 自动发布入库 → 参与后续召回
统计：cite_count 用于热度排序；90 天零引用且状态=已发布的条目 → 列表标记「待复核」
```

---

## B7. 迁移与上线

1. **数据迁移**：现网导出 `knowledge_items` 的已发布条目 → 生成 Excel（复用批量导入模板）→ 新系统「批量导入」
2. **切换步骤**：部署 Compose → 建库执行 `schema.sql` → 建管理员账号 → 导入数据 → 内部试运行 3 天（双系统并行）→ 切换访问入口 → 保留旧站 1 周只读
3. **回滚**：旧站不立即下线；新站数据可从 `pg_dump` 恢复；入口域名切回即可
4. **运维手册**：备份策略、Key 轮换、模型切换、日志清理、扩容方式

---
---

# 方案 C：WorkBuddy 云服务托管版（当前在用 · 基线）

> 本方案即**线上正在运行的版本**，也是 A / B 的参照基线：功能范围、数据模型、算法与交互以此为准，A / B 只替换「底座」，不减少功能。

## C1. 系统规划

### C1.1 定位与边界

- **定位**：零服务器运维的团队知识库问答门户。静态站点托管 + 云端三件套（登录 / PostgreSQL / 大模型通道），开通即用，无构建、无后端进程。
- **在边界内**：知识库管理（双类型条目）、智能问答、上报审核闭环、批量导入、AI 智能入库、RBAC 与审计日志。
- **在边界外**（受静态架构限制）：钉钉机器人（需常驻 HTTPS Webhook 与 Client Secret，前端不可承载）、服务端定时任务（如条目失效巡检）、私有化/内网离线部署。

### C1.2 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 前端形态 | 原生 HTML + CSS + ES5/ES6，无构建工具 | 单页 SPA，哈希路由（`#/ask`、`#/kb`…），直接静态托管 |
| 云 SDK | `@tencent-ai/workbuddy-cloud-sdk`，**本地打包**（`js/vendor/`） | 曾用 jsdelivr CDN，国内不可达导致白屏，已本地化 |
| 登录 | `cloud.auth` + WorkBuddy 账号 OAuth 中继 | 免密一键授权，回调参数 `provider=workbuddy` |
| 数据库 | 云 PostgreSQL + **RLS 行级安全**（12 条策略） | 浏览器直连，权限由数据库强制，不依赖前端判断 |
| 数据库函数 | `is_admin()`、`register_profile()`、`increment_cite()` | `SECURITY DEFINER`，规避 RLS 递归与越权 |
| 大模型 | `cloud.llm` 免密钥通道，OpenAI 兼容 SSE 流式 | 无需自备 Key；模型列表由环境配置决定 |
| Excel | SheetJS（本地打包） | 模板生成、批量导入解析，纯浏览器端 |
| 发布 | 静态站点托管 + `sharecode` 访问 | `config.js` 三常量绑定云环境 |

### C1.3 工期与成本

- **首版交付**：约 1 人日（建表 + RLS + 7 个页面 + LLM 集成）；后续按需求增量迭代，每次改动均需「升资源版本号 + 重新发布」。
- **运维成本**：无服务器、无备份作业（云侧托管），日常只需发布与账号角色维护。
- **资金成本**：不按 Token 出账，但受**创作者额度与限流**约束；触顶时接口返回 `quota_rate_limited`（带 `retryAfterMs`），表现为问答/整理集体失败。

## C2. 系统分析

### C2.1 角色与权限落地方式

| 能力 | 使用人员 | 管理运维人员 | 强制位置 |
|------|----------|--------------|----------|
| 检索/问答、查看已发布条目 | ✔ | ✔ | RLS：`status='已发布'` |
| 查看本人上报与草稿 | ✔ | ✔ | RLS：`owner_id = auth.uid()` |
| 提交上报 | ✔ | ✔ | RLS：INSERT 校验 `owner_id` |
| 审核 / 编辑 / 删除任意条目 | ✖ | ✔ | RLS：`is_admin()` |
| 用户角色管理、操作日志、审计日志 | ✖ | ✔ | RLS：`is_admin()`（`profiles` 另有限制策略） |
| Token 用量查看 | ✖ | ✔ | 视图层隐藏 + 数据层策略 |

**首个登录者即管理员**：`register_profile(name)` 在 `profiles` 为空时写入 `role='admin'`，否则 `'user'`；避免冷启动无管理员。**普通用户不能自我提权**：`profiles_update_own` 策略要求 `WITH CHECK (role='user')`。

### C2.2 功能需求（已实现清单）

| 模块 | 功能点 |
|------|--------|
| 认证 | WorkBuddy 一键登录、会话恢复、登出、初始化错误兜底提示 |
| 智能问答 | 100 字上限（前端 maxlength + 实时计数 + 提交拦截 + 提交前二次校验）、Top-K 召回、0.85 阈值、命中卡片（来源/环境/更新时间/引用次数）、未命中 AI 排查思路、一键上报 |
| 知识库 | 关键字/产品/分类/类型/状态筛选、分页、详情、管理员新增/编辑/删除 |
| 批量导入 | Excel 模板下载（含示例与填写说明）、解析校验、脱敏、查重、预览确认、分批入库、结果计入日志 |
| AI 智能入库 | 粘贴资料（≤8000 字）→ 拆分为 ≤10 条结构化条目 → 可编辑/勾选 → 一键发布，支持整理模型选择 |
| 上报审核 | 上报（≤1000 字，无下限）、我的上报、审核中心（通过/驳回/修改补充/疑似重复合并） |
| 治理 | 操作日志、审核日志、Token 用量按接口统计、条目类型与状态标签 |

### C2.3 非功能需求与达成情况

| 指标 | 现状 |
|------|------|
| 首屏 | 全量 JS 一次加载（约 2.1k 行自研 + 71KB SDK + SheetJS），无按需分包 |
| 检索时延 | 本地召回毫秒级；命中判定依赖模型，正常 3–15 秒，异常有看门狗兜底 |
| 可用性 | 依赖云服务与模型通道；模型波动时降级为关键词匹配，不阻断问答 |
| 数据规模 | 单表万级无压力（RLS 索引 `status`/`category`）；未上向量库 |
| 安全 | Key 为 `wbpk_` 可公开密钥，权限完全由 RLS 约束；入库前脱敏 |

### C2.4 风险与已采取的对策

| 风险 | 表现 | 对策（已落地） |
|------|------|----------------|
| 海外 CDN 不可达 | 首屏白屏 | SDK / SheetJS 全部本地化 |
| 浏览器缓存旧 JS | 修复不生效、报错复现 | 所有资源带 `?v=` 版本戳，每次发版递增 |
| 模型请求挂起 | 检索/整理无限转圈 | 首结果 20s 看门狗 + 流空闲 30s + 整体超时 + 自动重试 |
| 模型输出截断/为空 | `Unexpected end of JSON input` | 精简请求参数（去 `response_format`/`stream_options`）+ 宽松解析 + 内容抢救 |
| 额度限流 | 集中报错 | 控费设计（本地召回、Top 3–5、输出限长）；提示换模型/重试 |
| 数据与账号绑定 | 换账号数据不跟随 | 部署包 + 建库 SQL + Excel 导出/导入迁移路径 |

## C3. 系统设计

### C3.1 总体架构

```
浏览器（SPA：index.html + css + js）
   │
   ├─ cloud.auth ──────► WorkBuddy OAuth 中继（www.workbuddy.cn/v2/as/genie-baas/oauth）
   │                       └─ 回调 ?code=&provider=workbuddy → handleWorkBuddyCallback()
   │
   ├─ cloud.database ──► 云 PostgreSQL
   │                       ├─ 4 张表（profiles / knowledge_items / audit_logs / operation_logs）
   │                       ├─ 12 条 RLS 策略（按角色 + 归属 + 状态判定）
   │                       └─ 3 个 SECURITY DEFINER 函数
   │
   └─ cloud.llm ───────► 免密钥模型通道（chat.completions，SSE 流式）
                           ├─ /ask      语义打分
                           ├─ /classify 自动归类 + 脱敏 + 资料整理
                           └─ /audit    审核辅助（按需）
```

**分层职责**：视图层 `app.js`（渲染与交互）→ 端口层 `api.js` / `llm.js`（业务语义，不关心存储实现）→ 传输层 `cloud.js` + SDK（协议细节）。这层划分正是 A / B 能低成本替换的原因。

### C3.2 数据模型（4 表 + 3 函数 + 12 策略）

| 表 | 关键字段 | 约束 / 说明 |
|----|----------|-------------|
| `profiles` | `owner_id`(UNIQUE, 默认 `auth.uid()`)、`name`、`role`、`dingtalk_id`、`created_at` | `role IN ('admin','user')`；`owner_id` 与登录身份一一对应 |
| `knowledge_items` | `title` `content` `solution` `product` `module` `category` `kind` `tags[]` `environment` `version` `source` `status` `similarity_ref` `reporter` `report_time` `auditor` `audit_time` `audit_opinion` `cite_count` `creator` `updated_at` | `category` 6 枚举；`kind IN ('故障案例','常识知识')`；`source` 3 枚举；`status` 6 枚举；`solution` 可空（常识知识不需要） |
| `audit_logs` | `knowledge_id`(FK)、`auditor`、`action`、`opinion`、`created_at` | `action IN ('通过','驳回','修改')` |
| `operation_logs` | `operator`、`action`、`target_id`、`detail`、`created_at` | 所有增删改查与审核留痕 |

| 函数 | 作用 | 为什么需要 |
|------|------|-----------|
| `is_admin()` | 判定当前用户是否管理员 | 策略中引用 `profiles` 会触发 RLS 递归，用 `SECURITY DEFINER` 打破 |
| `register_profile(name)` | 首次登录建档 + 首人提权 | 客户端无法安全地"数人数再定角色" |
| `increment_cite(id)` | 命中时引用计数 +1 | 普通用户对他人条目的写入需收敛到单字段 |

**索引**：`knowledge_items(status)`、`knowledge_items(category)`、`operation_logs(created_at)`。

### C3.3 条目状态机

```
草稿 ──(管理员发布)──► 已发布 ──(归档)──► 已归档
  │                        ▲
  └─(用户上报)──► 待审核 ──┼─(通过)──┘
                   │  │
                   │  └─(驳回)──► 已驳回 ──(修改后重提)──► 待审核
                   └─(重复)──► 合并入既有条目（不新增）
```

### C3.4 部署架构

```
源码目录 ──(静态发布)──► WorkBuddy 托管站点  https://<app>-<id>.app.workbuddy.host/?sharecode=***
                                    │
                                    └─ config.js：endpoint / oauthRelayBaseUrl / publishableKey
```

- **发布即生效**，无构建步骤；回滚＝重新发布上一版本文件
- **缓存治理**：`?v=YYYYMMDDx` 递增，必须与代码同步改，否则用户仍跑旧 JS
- **环境绑定**：`config.js` 三常量与该云环境一一对应，跨账号部署必须替换（见部署包指南）

## C4. 模块划分

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.html` | ～180 | 视图骨架（登录页 + 应用壳 + 各视图容器）、资源引用与版本戳、启动兜底 |
| `css/style.css` | 315 | 设计系统（侧栏布局、卡片、标签色、弹窗、表单、响应式） |
| `js/config.js` | 5 | 云环境三常量 |
| `js/cloud.js` | 6 | SDK 单例初始化（全站唯一实例） |
| `js/api.js` | 195 | 端口层：`DB.*` 全集（列表/详情/写入/审核/用户/日志/用量），统一错误解包 |
| `js/llm.js` | 221 | 模型能力层：模型列表、`chatJSON`（看门狗/重试/宽松解析）、归类脱敏、语义打分、排查思路、资料整理 |
| `js/similarity.js` | 51 | 本地字符 bigram 余弦相似度（纯函数，无依赖） |
| `js/app.js` | 1341 | 视图与交互：路由、七个页面、弹窗、导入导出、AI 入库、状态与格式化工具 |
| `js/vendor/` | — | 第三方运行时（云 SDK、SheetJS），**不入 Git** |

`app.js` 内部视图函数：`renderAsk` / `renderKB` / `renderReport` / `renderMyReports` / `renderAudit` / `renderUsers` / `renderLogs`，弹窗：`itemForm` / `itemDetail` / `importModal` / `aiIngestModal`。

## C5. 关键算法

### C5.1 混合检索（本地召回 + 模型重排）

1. 提问侧：截断至 100 字，去标点、统一小写
2. 候选池：已发布条目（限 500 条，避免全表扫描）
3. 粗排：字符 bigram 余弦相似度，取 Top 10 —— `sim = |A∩B| / sqrt(|A|·|B|)`
4. 精排：把「问题 + 10 条候选（标题/描述/分类）」交给模型，输出 `{id: score}`，强制 0–1
5. 过滤：`score ≥ 0.85` 取 Top 5；命中则展示并 `increment_cite`
6. **降级链**：模型失败/超时 → 直接用粗排 `≥0.45` 兜底；仍无 → 未命中卡片 + AI 排查思路

### C5.2 SSE 三重看门狗与内容抢救

| 看门狗 | 阈值 | 触发后 |
|--------|------|--------|
| 首结果 | 20 s | 判定挂起 → 自动重试（最多 3 次，共享总预算） |
| 流空闲 | 30 s | 判定中途挂死 → 若正文非空则**当完成返回**（抢救），否则重试 |
| 整体 | 问答 45 s / 整理 300 s | 硬失败，错误信息人性化 |

`parseLoose()` 容忍 ```json 围栏、前后杂文本、尾逗号缺失等常见畸形输出。

### C5.3 自动归类与脱敏

单次模型调用同时完成：产品 / 模块 / 分类（6 枚举内）/ 3–6 个标签 / 标题改写 / 正文脱敏。提示词强约束输出 JSON；失败时前端用正则兜底（IP 掩码、`password|secret|token|key` 值替换 `***`），保证入库不裸奔。

### C5.4 权限判定（RLS 表达式）

```sql
-- 读：已发布 OR 本人 OR 管理员
status = '已发布' OR owner_id = auth.uid() OR is_admin()
-- 写：本人 OR 管理员
owner_id = auth.uid() OR is_admin()
-- 提权防护：普通用户自更新时 role 必须仍为 'user'
WITH CHECK (owner_id = auth.uid() AND role = 'user')
```

### C5.5 批量导入解析与查重

1. SheetJS 读首个工作表 → 二维数组，首行为表头
2. **表头模糊匹配**：先精确匹配，失败再 `startsWith`（解决 `解决方案(故障案例必填)`、`标签(逗号分隔)` 匹配不到的历史 bug）
3. 逐行校验：标题/内容必填、类型枚举、故障案例必须有解决方案、分类枚举就近归「其他」
4. 脱敏 → 标题归一化（去空格标点、转小写）与库内 + 文件内双向查重
5. 分批（每批 10–20 行）`insert`，逐批汇总成功/跳过/失败原因

## C6. 业务逻辑

### C6.1 问答主流程

```
输入(≤100字) → 拦截校验 → 本地召回 Top10
   → 模型语义打分（0.85 阈值，Top3-5）
      ├─ 命中：展示方案 + 来源/环境/更新时间 + 引用计数 +1
      └─ 未命中：AI 通用排查思路（异步、可失败）
                  └─「上报该问题」→ 自动带入思路到表单「已尝试的处理方法」
```

### C6.2 上报与审核

- 提交：脱敏 + 自动归类（产品/模块/分类/标签）→ 写入 `status='待审核'`、`source='用户上报'` → 上报人可查
- 审核：通过（转 `已发布` + 审核日志 + 通知）/ 驳回（写意见）/ 修改补充（改后可发布）/ 疑似重复（提示合并，不新增）
- 全程写 `operation_logs`，审核另写 `audit_logs`

### C6.3 AI 智能入库

```
粘贴文本(≤8000字) + 产品名 + 模型选择
   → 模型拆分（≤10 条）：kind/标题/内容/解决方案/分类/模块/环境/版本/标签（已脱敏）
   → 卡片预览（可编辑、可取消勾选、切类型时解决方案栏显隐）
   → 标题查重 → 逐条 insert(source='管理员录入', status='已发布') → 写日志
```

### C6.4 用量观测

`App.logUsage(endpoint, model, usage)` 按 `/ask`、`/classify` 聚合写库，管理员日志页可视化。
**已知取舍**：为提升兼容性，请求已移除 `stream_options.include_usage`，多数通道不再回传 `usage`，用量统计因此常为空——这是"稳定优先"的主动选择，若日后换用稳定通道可恢复。

## C7. 现状评估与迁移边界

| 优势 | 短板 |
|------|------|
| 零服务器、零运维，发布即上线 | 无法接入钉钉（需服务端承载 Secret 与 Webhook） |
| 登录/数据库/模型三件套开箱可用，无 Key 管理负担 | 模型与额度受平台约束，无法自选/私有化模型 |
| RLS 在数据库层强制隔离，前端被绕过也不越权 | 数据按账号隔离，跨环境迁移需导出/导入 |
| 全部业务逻辑在浏览器，调试与迭代快 | 首屏加载全量 JS；无服务端定时任务与后台计算 |

**不必迁移的情形**：团队规模小、可接受平台额度、只需网页访问、无内网/私有化要求 —— 现状方案就是成本最优解。

**应迁移的触发条件**（任一成立）：① 要接钉钉/企微机器人；② 要求内网或私有化部署、数据不出域；③ 需要自备模型（私有 vLLM / 特定厂商）；④ 额度或限流成为瓶颈；⑤ 需要定时任务、报表、批量后台计算。

**迁移成本可控的关键**：`api.js` 端口契约不变 → 前端与界面资产全复用；存量数据走「导出 Excel → 新环境批量导入」，无需写迁移脚本。

---

# 三、三方案对比与选型

| 维度 | 方案 C 现状（WorkBuddy 托管） | 方案 A 纯前端本地版 | 方案 B 轻量后端版 |
|------|------------------------------|---------------------|-------------------|
| 部署复杂度 | 极简（静态发布，平台代管） | 极简（静态文件） | 中（Compose：app+db+nginx） |
| 上线速度 | 已在线 | 0.5–1 人日 | 2–2.5 人日 |
| 多人共享 | ✔（云端共享同一库） | ✖（各机独立） | ✔ |
| 登录方式 | WorkBuddy 账号免密 | 本机口令 | 账号密码 + JWT |
| 数据可靠性 | 强（云托管） | 弱（清缓存即丢） | 强（PG + 备份） |
| API Key 安全 | 无需 Key（平台通道） | 弱（浏览器可读） | 强（服务端加密） |
| 自定义模型 | ✖（用平台模型列表） | ✔（页面配置，直连） | ✔（页面配置，管理员统一下发） |
| 审计与权限 | 强（RLS 数据库层） | 弱（单用户） | 强（BFF + RBAC） |
| 钉钉/企微机器人 | ✖ | ✖ | ✔ |
| 内网/私有化 | ✖ | ✔（离线可用） | ✔ |
| 运维成本 | 近零 | 近零 | 一台常开服务器 + 备份 |
| 成本模型 | 平台额度（不按 Token 出账） | 自付模型 API 费用 | 自付模型 API 费用 + 服务器 |

**选型建议**

| 场景 | 选择 |
|------|------|
| 当前团队日常使用、只需网页访问 | **方案 C**（现状，无需改动） |
| 现场工程师随身手册、单机离线、演示 | **方案 A** |
| 团队共享 + 要接钉钉 + 要自备模型/私有化 | **方案 B** |
| 渐进路线 | C 先跑通业务 → 需求升级时按 B 重建底座（前端与页面资产全复用，数据 Excel 迁移） |

> 三方案并非互斥。推荐把 **C 作为生产主线**（零运维、稳），把 **A 作为离线备份形态**（同一份前端代码换存储实现即可打包给现场），**B 作为私有化交付形态**。三者共用同一套 `app.js` 与界面资产，差异只在 `api.js` / `llm.js` 的实现与部署方式。

---

# 四、文件级改造清单（A / B 相对现状 C 的差异）

> 方案 C 即当前仓库 `master` 分支实际状态，本节列出的"改造"仅针对 A / B。

| 文件 | 方案 C（现状） | 方案 A | 方案 B |
|------|----------------|--------|--------|
| `index.html` | 引用本地 SDK + 版本戳，OAuth 登录页 | 删 SDK 引用，登录改口令表单，加设置页入口 | 同 A（设置页仅 admin 可见） |
| `js/config.js` | `endpoint / oauthRelayBaseUrl / publishableKey` | 仅保留常量 | 仅保留 `API_BASE` |
| `js/cloud.js` | SDK 单例初始化 | 删除 | 删除 |
| `js/api.js` | SDK 查询构建器（`from/select/insert/rpc`） | 改调 `store.js`（IndexedDB） | 改调 `fetch('/api/...')` |
| `js/store.js` | 无 | 新增 | 不使用 |
| `js/llm.js` | `cloud.llm.chat.completions.create` + 三重看门狗 | 传输层改 `llm-client.js`（浏览器直连） | 传输层改 `POST /api/llm/chat` |
| `js/llm-client.js` | 无 | 新增（SSE 直连） | 不使用（前端只需解析 BFF 的 SSE） |
| `js/similarity.js` | 本地 bigram 余弦（51 行） | 不改 | 不改 |
| `js/app.js` | 视图 + 交互（1341 行） | 不改（仅登录页与设置页路由注册） | 同 A |
| `server/**` | 无 | 无 | 新增（约 600–800 行） |
| `database/init.sql` | 4 表 + 3 函数 + 12 条 RLS 策略 | 不使用（IndexedDB 建库在代码里） | 改写为 `schema.sql`（去 RLS，加 `llm_settings`/`usage_stats`） |
| `Dockerfile` / `docker-compose.yml` | 无 | 无（或只需 nginx.conf） | 新增 |
| `docs/部署手册.md` | 部署包内「部署指南」（六步） | 新增 | 新增 |

---

## 附：关键决策记录（ADR 摘要）

| 决策 | 选择 | 理由 |
|------|------|------|
| 是否改 UI 代码 | 不改 | `api.js` 端口抽象，UI 与存储解耦，降低回归风险 |
| 当前为何不换掉平台（方案 C 存续） | 保留 | 静态站无法安全承载 Secret 与常驻 Webhook；平台提供 RLS 强制隔离与免密钥模型，运维成本近零 |
| 是否前端直连模型 | C 走平台通道、A 直连、B 代理 | 浏览器直连必暴露 Key 且受 CORS 限制；团队场景必须代理 |
| 是否保留 RLS | A/B 不保留 | 自托管下 RLS 与 BFF 权限校验重复，统一在 BFF 层更易维护 |
| 是否引入 ORM | 不引入 | 表结构简单，原生 SQL 更透明、易审计 |
| 检索是否上向量库 | 暂不 | 现有「本地召回 + LLM 重排」在万级数据下足够；规模上来再加 pgvector |
| 是否强制 JSON 输出模式 | 关闭 | `response_format=json_object` 在部分通道返回空/截断，改为提示词约束 + 宽松解析 |
