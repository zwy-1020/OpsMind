-- =====================================================================
-- 运维知识库智能问答系统 · 数据库初始化脚本（PostgreSQL）
-- =====================================================================
-- 用法：在目标设备的 WorkBuddy 云服务环境中，让 WorkBuddy 将下面每一条
-- 语句逐条执行（该环境要求单语句执行，不能整脚本一次跑）。
-- 顺序：建表 → 函数 → 启用 RLS → 授权 → 策略 → 索引 → （可选）示例数据。
-- 对应文件：seed-sample.sql 为 8 条可选示例数据。
-- =====================================================================

-- ---------- 1. 建表（4 张） ----------

-- 1.1 用户与角色
CREATE TABLE profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid() UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  dingtalk_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.2 知识条目主表
CREATE TABLE knowledge_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  product TEXT NOT NULL DEFAULT '未分类',
  module TEXT,
  category TEXT NOT NULL DEFAULT '其他' CHECK (category IN ('数据库','网络','系统','应用','中间件','其他')),
  solution TEXT,
  environment TEXT,
  version TEXT,
  tags TEXT[] DEFAULT '{}',
  vector_id TEXT,
  similarity_ref REAL,
  source TEXT NOT NULL DEFAULT '用户上报' CHECK (source IN ('自动生成','用户上报','管理员录入')),
  status TEXT NOT NULL DEFAULT '待审核' CHECK (status IN ('草稿','待审核','已通过','已驳回','已发布','已归档')),
  reporter TEXT,
  report_time TIMESTAMPTZ,
  auditor TEXT,
  audit_time TIMESTAMPTZ,
  audit_opinion TEXT,
  cite_count INTEGER NOT NULL DEFAULT 0,
  creator TEXT,
  kind TEXT NOT NULL DEFAULT '故障案例' CHECK (kind IN ('故障案例','常识知识','产品漏洞')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.3 审核记录
CREATE TABLE audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  knowledge_id BIGINT NOT NULL REFERENCES knowledge_items(id),
  auditor TEXT,
  action TEXT NOT NULL CHECK (action IN ('通过','驳回','修改')),
  opinion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.4 操作审计日志
CREATE TABLE operation_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  operator TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 2. 函数（3 个） ----------

-- 2.1 判断当前用户是否管理员（RLS 策略使用）
CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE owner_id = auth.uid() AND role = 'admin'
  )
$$;

-- 2.2 登录后注册个人档案：首个注册用户自动成为 admin（bootstrap）
CREATE OR REPLACE FUNCTION register_profile(p_name TEXT) RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid TEXT := auth.uid();
  v_role TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  INSERT INTO profiles (owner_id, name, role)
  VALUES (v_uid, NULLIF(p_name, ''), CASE WHEN NOT EXISTS (SELECT 1 FROM profiles) THEN 'admin' ELSE 'user' END)
  ON CONFLICT (owner_id) DO NOTHING;
  SELECT role INTO v_role FROM profiles WHERE owner_id = v_uid;
  RETURN v_role;
END;
$$;

-- 2.3 知识引用计数 +1
CREATE OR REPLACE FUNCTION increment_cite(k_id BIGINT) RETURNS VOID
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
  UPDATE knowledge_items SET cite_count = cite_count + 1 WHERE id = k_id
$$;

-- ---------- 3. 启用行级安全 ----------

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_logs ENABLE ROW LEVEL SECURITY;

-- ---------- 4. 授权 ----------

GRANT SELECT, INSERT, UPDATE ON TABLE profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE knowledge_items TO authenticated;
GRANT SELECT, INSERT ON TABLE audit_logs TO authenticated;
GRANT SELECT, INSERT ON TABLE operation_logs TO authenticated;

-- ---------- 5. RLS 策略（12 条） ----------

-- 5.1 profiles：本人可读写自己档案；管理员可读全部、改角色（本人角色不可自改）
CREATE POLICY profiles_select ON profiles FOR SELECT TO authenticated USING (owner_id = auth.uid() OR is_admin());
CREATE POLICY profiles_insert ON profiles FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY profiles_update_own ON profiles FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid() AND role = 'user');
CREATE POLICY profiles_update_admin ON profiles FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- 5.2 knowledge_items：已发布全员可见；本人与管理员可增删改
CREATE POLICY ki_select ON knowledge_items FOR SELECT TO authenticated USING (status = '已发布' OR owner_id = auth.uid() OR is_admin());
CREATE POLICY ki_insert ON knowledge_items FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY ki_update ON knowledge_items FOR UPDATE TO authenticated USING (owner_id = auth.uid() OR is_admin()) WITH CHECK (owner_id = auth.uid() OR is_admin());
CREATE POLICY ki_delete ON knowledge_items FOR DELETE TO authenticated USING (owner_id = auth.uid() OR is_admin());

-- 5.3 audit_logs：管理员专用
CREATE POLICY al_select ON audit_logs FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY al_insert ON audit_logs FOR INSERT TO authenticated WITH CHECK (is_admin());

-- 5.4 operation_logs：所有人可写自己的日志，管理员可读
CREATE POLICY ol_select ON operation_logs FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY ol_insert ON operation_logs FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());

-- ---------- 6. 索引 ----------

CREATE INDEX idx_ki_status ON knowledge_items(status);
CREATE INDEX idx_ki_category ON knowledge_items(category);
CREATE INDEX idx_ol_created ON operation_logs(created_at);

-- ---------- 7. 函数权限 ----------

REVOKE EXECUTE ON FUNCTION register_profile(TEXT), increment_cite(BIGINT), is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_profile(TEXT), increment_cite(BIGINT), is_admin() TO authenticated;

-- ---------- 8. 表注释（可选，便于管理界面识别） ----------

COMMENT ON TABLE profiles IS '用户与角色（RBAC）：admin=管理运维人员 / user=使用人员';
COMMENT ON TABLE knowledge_items IS '知识条目主表：故障案例 + 常识知识 + 产品漏洞';
COMMENT ON TABLE audit_logs IS '审核记录（通过/驳回/修改）';
COMMENT ON TABLE operation_logs IS '操作审计日志与大模型 Token 用量记录';
