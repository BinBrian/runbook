# Runbook 本地存储模型

V0.1 持久化入口为 `native/runbook-store`，实际表结构以 [schema.sql](../../../../../native/runbook-store/src/schema.sql) 为准。Markdown 是内容权威，步骤是解析投影，结果独立存储。初始设计调整见 [ADR 0004](../../../../decisions/0004-store-and-nested-backup.md)。

## SQLite 实体与 payload

关系列承担身份、关联、排序和唯一性，每实体的 JSON payload 保存 Rust DTO 中的其他字段。父 payload 清空子集合，读取时按关系表重建完整 Workspace，不在父子表重复存储同一历史。

| 表 | 关系列与索引列 | payload 内容 |
| --- | --- | --- |
| templates | id、revision、created_at、updated_at | 完整 Template，含名称、说明、草稿、有效原文、applied_revision、source_hash、archived |
| runs | id、source_template_id、revision、created_at、updated_at、closed_at | Run，但 steps 为空；含来源快照、工作文档、parameters、draft_parameters、选中步骤、汇总和总结 |
| run_steps | run_id、step_id、position、content_version、present | RunStep，但 attempts 为空；含步骤定义与状态 |
| step_attempts | id、run_id、step_id、attempt_no、outcome、operation_id | Attempt，但 annotations 为空；含冻结步骤及 parameters、版本、回显、说明和时间 |
| attempt_annotations | id、attempt_id、sequence、operation_id | Annotation，含文字、原结果、新结果与时间 |
| operation_receipts | operation_id、request_hash、created_at | 独立 result_json，记录操作对象/提交版本或导入 ID 摘要 |

模板、实例、轮次和注释表另有可空 import_source_json，保存原包版本、原 ID 与导入时间。回执及内部来源元数据不属于用户备份字段。

身份使用标准小写 UUID，业务生成时间为 UTC RFC 3339；导入接受带时区的有效 RFC 3339 并检查相关先后顺序。revision、内容版本、轮次、位置和计数使用 u32。对象 revision 从 1 开始；尚无有效模板文档时 applied_revision 可为 0。

模板归档使用 archived 布尔值，没有 archived_at。实例是否留档由 closed_at 是否为空决定。模板保存 source_hash，步骤保存 content_hash；当前实例没有单独持久化 source_hash 或 parser_version。

initial_template_snapshot 保存来源 ID、名称、revision、完整 Markdown 和创建时 parameters。实例不依赖来源模板存在；导入时包外来源关联置空，原 ID 仍可留在快照或导入来源元数据。同包模板重分配 ID 时，实例关联与快照中的对应 ID 一起重写，快照原文和参数保持不变。

RunStep.definition 是当前或最后有效的步骤投影，Attempt.step_snapshot 是每轮开始时的冻结正文、标题与指令。移除步骤设置 present=false，保留历史对象。数据库没有完整模板编辑版本表或逐字事件流。

## 约束、事务与回执

启用外键与限制删除。步骤主键为 `(run_id, step_id)`；轮次 `(run_id, step_id, attempt_no)` 唯一；注释 `(attempt_id, sequence)` 唯一。partial unique index 保证每步至多一个 draft。表有模板更新时间及实例生命周期/更新时间索引；当前仓储按创建时间/ID 读取完整工作区，界面再筛选排序。

每个 perform 在 immediate 事务中完成读取、业务检查、保存和回执。应用流程同时更新原文、投影与内容版本；任意失败全部回滚。服务保护终态轮次，注释只追加。payload 的存储方式不表示允许外部直接改写历史。

调用方生成 operation_id 与新实体 ID。先查询回执，再检查 revision；请求摘要仅来自 action，不含 expected_revision。相同操作重试不重复实施，返回当前 Workspace；不同参数复用 ID 报错。回执持续保留，目前无清理策略。导入创建新实体 ID，共用本次导入操作 ID，不恢复源库回执。

每次写操作当前加载并 upsert 整个工作区，父 JSON 清空子数组，子表分层保存。此方式简化首版一致性，但读写成本随历史增加；尚无分页、变化集合保存或大量回显下的性能基准。容量达到实际瓶颈后再调整仓储，业务契约可以保持不变。

## 自动保存与恢复

前端使用全局串行写队列，编辑缓冲约 500 毫秒防抖。编辑器注册刷新函数，关键操作和正常退出先等待脏输入提交。原生事务确认后才清除脏状态；失败保留输入和错误，关闭保护会保留窗口。

模板无效原文仍保存为草稿，最近有效原文保留；有效时同步应用。实例文档和参数草稿一起持续保存，明确应用后才更新步骤。未应用状态同时比较 draft_markdown/applied_markdown 与 draft_parameters/parameters 的实际内容，不能通过两个 revision 是否相等判断，因为结果和注释也增加对象 revision。

已有对象写入带 expected_revision，新建与导入不需要旧版本。冲突不会自动覆盖。草稿轮次可修改，终态只能追加，作废轮次只读。留档前要求无 draft 轮次、无未应用源码，并重新计算结论。

异常退出仅能恢复最后已确认事务，不能保证未确认输入不丢失。当前没有独立定时恢复文件或自动数据库备份；手工 JSON 备份和未保存输入救出用途不同。

## 数据库版本与升级边界

使用 rusqlite bundled SQLite，单连接，外键开启、busy_timeout 为 5 秒、WAL、synchronous=FULL。配置本身不等于断电零丢失保证，实际退出与故障恢复以测试为准。

参数化迭代使用 schema 2。空库直接初始化；已有 schema 1 文件升级前先保存 SQLite 一致性备份，再在事务中完成版本升级。旧 payload 缺少参数字段时读取为空集合，不重建或清空旧记录。备份或升级失败时停止，不能伪装成空工作区。高于 2 的版本拒绝写入。升级策略与限制见 [ADR 0006](../../../../decisions/0006-parameters-and-independent-instances.md)。

数据库默认位于应用本地数据目录，测试使用内存或临时文件。启动时允许 RUNBOOK_DATA_DIR 或 EXE 同目录 runbook.local.json 显式指定绝对目录，配置错误不静默回退。当前开发副本使用工程根 .local-data，独立于 target 构建目录；详见 [ADR 0005](../../../../decisions/0005-explicit-data-directory.md)。运行中不要直接复制主 sqlite3 文件作为完整备份，因为 WAL 可能包含尚未合并的数据。

## JSON 数据包

schema 2 延续嵌套结构，顶层没有 run_steps、step_attempts 或 attempt_annotations 数组；导入继续支持旧 schema 1：

```text
Backup
├─ format: "runbook-backup"
├─ schema_version: 2
├─ exported_at: RFC 3339
├─ templates: Template[]
└─ runs: Run[]
   └─ steps: RunStep[]
      └─ attempts: Attempt[]
         └─ annotations: Annotation[]
```

精确字段以 [model.rs](../../../../../native/runbook-core/src/model.rs) 及生成契约为准。备份包含归档模板、已留档实例、草稿、有效原文、来源快照、已移除步骤、全部轮次及更正。父子关系由嵌套位置表达，原 ID 保留供校验和映射。

当前完整 JSON 导出包含整个工作区，没有按对象勾选导出的入口。普通 Markdown、Runbook Markdown 和报告可针对当前对象导出，但不能恢复执行历史。早期提出的扁平 schema 1 从未作为已发布格式实现，本版没有自动兼容适配。

导出前刷新输入，从一致性读事务获取 DTO，再经原生对话框写临时文件并替换目标；失败不显示成功。导入和文件读取上限为 32 MiB，当前导出未统一此上限；超过上限的备份无法由本版直接导回，应在扩大规模前统一容量策略并验证。

## 导入校验与重映射

1. 检查 32 MiB 上限、format、schema_version、字段类型和未知字段，支持 schema 1 与 2，拒绝更高版本。
2. 重新解析已应用原文，核对模板源摘要、步骤身份、位置、范围、正文与指令投影；暂时无效的编辑草稿可以保留。
3. 验证来源快照、历史步骤、轮次编号、内容版本、单步 draft、终态时间、失败/跳过说明、更正链和汇总；另查 UUID、实体唯一性、时间格式与顺序。
4. 为模板、实例、轮次和注释生成新 ID，重写同包关联；步骤和指令 ID 保留在新文档范围内。包外模板关联断开，不能误接本地同 ID 对象。
5. 一次事务写入整个导入包与本次回执，任意失败整包回滚。

同一 `(run_id, step_id, content_version)` 的轮次须具有一致的规范正文和指令快照。历史范围可因移动而不同，但同一内容版本不能代表不同命令。当前版本快照还须对应当前步骤，draft 只能属于仍在流程中的当前版本。

已留档实例不得含 draft 或未应用源码，汇总须与重新计算结果一致。移除步骤仍需完整历史对象。更正记录的 previous_outcome 必须与上一有效结果相符，不能伪造更正链。

仓储支持来源模板未包含在包内的独立实例树；预检与提交共用 validate_backup，先断开包外模板关联再执行完整验证，已通过一致性测试。当前 UI 的导出路径为完整工作区，尚未开放独立对象选择导出。

Markdown 导入建立新模板，普通围栏不推断为指令；交互标记由相同解析器恢复定义。报告作为普通文档导入，不还原历史。普通 Markdown 导出只去合法标记，Runbook Markdown 保留标记；模板恢复只清除 archived 布尔值。
