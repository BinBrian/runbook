# 补丁维护流程示例

这是一份用于验证转换方式的简化示例。命令和路径不来自真实维护环境。

<!-- runbook:document version="1" -->

<!-- runbook:step id="11111111-1111-4111-8111-111111111111" -->

## 检查维护窗口

先确认本次维护时间和负责人。

<!-- runbook:command id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" -->

```powershell
Write-Output '已确认维护窗口'
```

<!-- /runbook:step -->

<!-- runbook:step id="22222222-2222-4222-8222-222222222222" -->

## 核对补丁包

查看文件摘要，人工核对预期值。本示例不提供真实补丁或预期摘要。

<!-- runbook:command id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" -->

```powershell
Get-FileHash -LiteralPath 'C:\RunbookExample\patch.zip' -Algorithm SHA256
```

<!-- /runbook:step -->

<!-- runbook:step id="33333333-3333-4333-8333-333333333333" -->

## 记录人工确认

确认检查事项都已处理，写下本次结论。不需要指令也可以成为可跟踪步骤。

<!-- /runbook:step -->
