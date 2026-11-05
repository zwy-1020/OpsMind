-- =====================================================================
-- 可选：8 条运维示例知识条目（种子数据）
-- 执行完 init.sql 后，将下面每条 INSERT 逐条（或整条）在目标环境执行。
-- 不需要示例数据可跳过本文件。
-- =====================================================================

INSERT INTO knowledge_items (owner_id, title, content, product, module, category, solution, environment, version, tags, source, status, cite_count, creator) VALUES
('system', '产品A 启动失败 - connection refused', '产品A 服务启动时报错 connection refused，无法连接依赖的数据库端口，服务反复重启。', '产品A', '服务启动', '网络', '① 检查目标端口是否监听（netstat -tlnp）；② 查看服务日志确认依赖的数据库/中间件是否就绪；③ 确认防火墙与安全组放行对应端口；④ 重启服务并观察日志。', '生产环境 / Linux', 'v2.x', ARRAY['connection refused','端口','启动失败'], '管理员录入', '已发布', 12, 'admin'),
('system', 'MySQL 数据库连接失败 - too many connections', '应用报错 MySQL connection: too many connections，数据库连接数达到上限，新请求被拒绝。', 'MySQL', '连接管理', '数据库', '① 登录 MySQL 执行 show processlist 排查连接来源；② 检查应用连接池配置是否有泄漏（未释放连接）；③ 临时调大 max_connections 并重启业务低峰期生效；④ 修复代码中未关闭的连接后恢复原值。', '生产环境', 'MySQL 5.7/8.0', ARRAY['too many connections','连接池','MySQL'], '管理员录入', '已发布', 8, 'admin'),
('system', '服务部署后接口 502 Bad Gateway', '服务发布后所有接口返回 502，网关健康检查失败。', '网关', '接入层', '应用', '① 检查后端服务进程是否存在（ps -ef）；② 查看服务日志确认是否启动报错；③ 核对网关 upstream 配置的端口与实际监听端口是否一致；④ 检查健康检查路径是否正确返回 200。', '生产/测试环境', NULL, ARRAY['502','网关','健康检查'], '管理员录入', '已发布', 15, 'admin'),
('system', 'Redis 缓存连接超时 timeout', '应用报错 Redis connection timeout，接口响应变慢，部分缓存读取失败。', 'Redis', '缓存', '中间件', '① 检查 Redis 服务状态与内存占用（info memory）；② 确认网络链路是否稳定（telnet 6379 端口）；③ 检查是否存在大 key 或慢查询阻塞（slowlog get）；④ 必要时扩容或清理过期数据。', '生产环境', 'Redis 6.x', ARRAY['Redis','timeout','缓存'], '管理员录入', '已发布', 6, 'admin'),
('system', '磁盘空间不足导致日志写入失败', '服务器磁盘使用率超过 95%，应用日志无法写入，服务出现 No space left on device 报错。', '操作系统', '磁盘', '系统', '① df -h 定位占用最大的分区；② du -sh /* 逐层排查大文件；③ 清理或压缩历史日志（find /var/log -mtime +7 -delete）；④ 配置 logrotate 防止复发。', 'Linux 服务器', NULL, ARRAY['磁盘','No space left','日志'], '管理员录入', '已发布', 9, 'admin'),
('system', 'Nginx 配置更新后未生效', '修改 Nginx 配置后 reload 未生效，流量仍走旧配置。', 'Nginx', '接入层', '中间件', '① nginx -t 校验配置语法；② 确认修改的是实际加载的配置文件（nginx -V 查看 conf path）；③ nginx -s reload 平滑重载；④ 检查是否有多台实例未同步配置。', '生产环境', 'Nginx 1.2x', ARRAY['Nginx','配置','reload'], '管理员录入', '已发布', 5, 'admin'),
('system', '定时任务未按预期执行', 'crontab 配置的定时任务没有执行，人工手动运行脚本正常。', '操作系统', '定时任务', '系统', '① 检查 crontab -l 确认任务存在；② 查看 /var/log/cron 确认是否被调度；③ 注意环境变量差异（PATH 不完整），脚本内使用绝对路径；④ 检查脚本执行权限与输出重定向。', 'Linux 服务器', NULL, ARRAY['crontab','定时任务','环境变量'], '管理员录入', '已发布', 4, 'admin'),
('system', '数据库慢查询导致接口超时', '核心接口偶发超时，数据库出现大量慢查询，CPU 升高。', 'MySQL', '查询优化', '数据库', '① 慢查询日志定位耗时 SQL（explain 分析执行计划）；② 检查是否缺少索引或索引失效；③ 对大表查询增加分页与 limit 限制；④ 必要时加缓存降低数据库压力。', '生产环境', 'MySQL 8.0', ARRAY['慢查询','索引','超时'], '管理员录入', '已发布', 7, 'admin');

-- 常识知识示例（可选）
INSERT INTO knowledge_items (owner_id, title, content, product, module, category, solution, environment, tags, source, status, creator, kind) VALUES
('system', '什么是 inode', 'inode 是 Linux 文件系统的索引节点，存储文件的元数据（权限、大小、时间戳、数据块位置）。每个文件占用一个 inode，inode 耗尽后即使磁盘有空间也无法创建新文件，可用 df -i 查看。', 'Linux', '文件系统', '系统', NULL, '通用', ARRAY['inode','linux','文件系统'], '管理员录入', '已发布', 'admin', '常识知识');
