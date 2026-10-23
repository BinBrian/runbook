# 参数作用域与步骤块实施契约

当前收藏与多选合组规则以 [ADR 0014](decisions/0014-favorite-steps-and-selection-grouping.md) 为准：收藏页不独立编辑，支持单步与整组快照，参数只带原默认值，插入后身份独立；多选合组保留原步骤身份及历史。下文早期步骤块编辑入口仅保留形成时背景。

状态：2026-10-20 已实现并通过定向测试、真实桌面闭环和两次正常退出重启验收；复用工作区 Runbook 规划。证据与边界见 [testing.md](testing.md)。本文补充并取代旧契约的扁平公共参数部分，未涉及规则继续沿用。

## 数据与版本

- Template/Instance 新写入 `formatVersion: 2`；已有清单 v1 保持可读，缺省字段表示无组、参数全局，已有快照原样保留。未涉及旧 Markdown 库。
- Parameter 追加可选 `ownerId?: string`；无 ownerId 为全局，有则必须属于本文件的 step.id 或 group.id。参数 ID 在文档内唯一，名称可跨组相同。
- Step 追加可选 `groupId?: string`。
- Document 追加可选 `groups?: {id:string,name:string,description?:string,sourceBlockId?:string}[]`。组为单层；同组步骤必须连续，组至少包含一步，组/步骤身份不能碰撞。平铺 steps 数组继续定义执行顺序。
- 组是包含子步骤的步骤块，`name` 用作标题，允许为空但仍限制 1024 UTF-8 字节并拒绝 NUL；模板、实例、块名称和参数名称仍必填。`description?: string` 是普通多行描述，原生缺省空字符串且空值省略序列化，读取旧 v2 不改写库；非空描述随复制/复用/SQLite/JSON/ZIP 保留。描述按 UTF-8 字节最多 1 MiB，拒绝 NUL；不解释变量。已有子步骤推进后按组元数据整体冻结。新步骤标题为 `['']`，空名称和描述只在界面显示灰色占位，持久化不写占位文本。
- 引用可见性：步骤可引用全局、本步骤及所属组参数；组不嵌套，无跨组同名查找。变量始终按 parameterId 明确绑定。
- 现有 parameterValues 继续用文档内唯一参数 ID 为键；新增参数从原默认值填入。已推进单步骤拥有的局部值及全组已推进的局部值不允许再修改；部分组尚有当前/后续步骤时，应用仅影响未推进部分，旧结果保持快照。
- 已推进步骤正文/命令及引用过的参数定义保持冻结；所属组身份/名称和当前 groupId 稳定，并保证组成员连续，不能借移组绕过冻结。当前步骤身份及位置固定，部分组内尚未推进的成员和完整未来组可调整。

## 复用块

- Workspace 追加 `blocks?: BlockDefinition[]`，原生返回数组。缺失按空数组处理。
- BlockDefinition 与 Template 结构相同，`kind:'block'`，formatVersion 2，含 id/name/document/createdAt/updatedAt。
- 块定义必须自包含：恰有一组，全部步骤属于该组，全部参数为该组或组内步骤的局部参数，不依赖外部全局参数。
- 从步骤组保存为块时，收集所有引用的参数，将其捕获为块局部定义（保留原默认值），重绑身份；不携带执行填值、结果和材料。
- 插入块或复制组时重新分配 group/step/command/parameter 身份并重绑局部引用，保留原默认值；sourceBlockId 仅追溯来源。插入副本可独立编辑，定义改动不自动覆盖它。
- 暂无嵌套、循环/依赖图、自动批量展开或命令运行。块内每个具体步骤独立确认结果。

## IPC（新增部分）

沿用 checklist_load/apply/preview_import/commit_import/export_data；预览与导出 kind 扩为 template/instance/block。

| action.type | 字段 |
| --- | --- |
| create_block | id, name, document |
| save_block | id, name, document |
| delete_block | id |

插入/复制组在前端纯文档变换中完成，由 save_template/save_instance 统一持久化并由原生校验。所有保存模板/实例动作按 v2 写入；原生读取 v1 不自动改写既有结果。块导出为 `.runbook.json`；实例 ZIP 含使用副本的完整文档，恢复不依赖块库。

## 界面与填参

- 模板和实例共用单层组的编辑/复制/保存为块/插入块能力，库中可新建、编辑、导入导出块。不自动更新已有使用项。
- 变量定义与实例值统一在右侧按全局、当前组和当前步骤管理，不在正文重复提供表单。参数定义/值和作用范围须清楚标示；缺失项打开并聚焦右侧输入，保持正文阅读位置。
- TextField 传入可见参数和默认局部 ownerId；选区新建默认局部，可主动选择全局；复用仅列可见范围。
- 开始前汇总缺失项可定位，所有引用值完整才允许开始。运行中按所在范围显式应用，未提交输入与保存失败保护沿用。
- 运行中插入块后若存在多个范围的已保存缺失值，填写各范围后可显式“应用全部参数”，保持原生完整引用校验；不重新开始或推进流程。正常单范围应用只提交自身，保留其他范围草稿及冻结值。
- 完成/跳过只推进具体步骤；组不增加独立执行结果，聚合显示进度，切回实例展开当前所在组和步骤。

## 样例

更新重启服务块：局部环境，stopserver ENV all → publishgame ENV → syncgame ENV all → startserver ENV all。库中定义一次，可分别插入 sandboxa/sandboxb/sandboxc/sandboxd。玩家转区块：本组四个身份参数及局部环境；六命令与通知引用同组参数。正式服维护模板主环境 release 全局，已有玩家组可显式引用全局环境，sandboxa 更新块用自己的局部环境。维护预告两步为一组共享局部起止时间，来源分支是 copybranch 步骤的局部参数。
