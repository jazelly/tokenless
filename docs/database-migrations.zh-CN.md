# 数据库迁移

Tokenless API 与 Tokenless Harness 共用 `$TOKENLESS_HOME/tokenless.sqlite3`。
Schema migration 随 `tokenless` npm 安装包发布，在数据库入口打开该文件时本地执行；发布或推送代码不会直接修改用户的数据库。

## 初始 migration

`packages/shared/src/database/migrations/0001-initial.ts` 定义当前九张表。
Daemon job store、provider profile registry 和 Harness context store 共用迁移入口，以 SQLite `PRAGMA user_version` 记录版本。

- 空数据库创建初始 schema，版本设为 `1`。
- 接管 commit `8b215fd` 的当前无版本 schema 时，不替换已有表或改写已有记录；无关历史表保持不动。
- 无版本数据库的已有表缺少必要字段时明确失败，不静默修复，也不标记为已升级。
- 数据库版本高于安装包支持的版本时拒绝打开，不自动降级。

引入本机制之前的版本不会检查 schema 版本；不要用这些旧版本打开已经升级的数据库。

Schema 修改与版本更新在同一个 SQLite 事务内提交；迁移失败时一起回滚，该数据库入口不会继续打开。
这个事务用于数据库写入一致性，不是 chat 独占锁。

Migration 不改变 daemon 原有启动行为：未完成的 job 会标记为失败，缺失的 Dashboard 汇总由 job store 初始化。
它不迁移 `config.json`、浏览器 profile、凭据或 provider 侧会话。

## 后续 schema 修改

1. 保持已发布的 migration 不变，新增下一个编号的 migration 模块。
2. 在 `packages/shared/src/database/migrate.ts` 中按顺序注册。
3. 通过真实 SQLite 边界验证涉及的旧 schema 与数据升级，再运行安装包验证。
4. 随正常 changeset 和 npm release 发布；用户升级后，下次打开数据库时执行。

Migration 模块随 shared package 编译，复制进 CLI distribution，并打包进 Harness distribution。
没有独立 SQL 下载、migration service、重试循环或自动数据删除。

## 验证

```bash
npm run build
node --test --test-concurrency=1 test/database-migrations.integration.test.mjs
node --test --test-name-pattern='pure JS CLI packs' test/package-contract.test.mjs
```

无版本测试 schema 从 `8b215fd` 的真实 store 生成，不包含用户或 provider 数据。
安装包验证会安装本地 npm tarball，使用临时 home 启动其中的 daemon，并检查 authenticated HTTP 与 schema version `1`。
