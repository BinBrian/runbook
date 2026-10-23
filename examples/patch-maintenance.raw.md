# 补丁维护流程示例

这是一份用于验证转换方式的简化示例。命令和路径不来自真实维护环境。

## 检查维护窗口

先确认本次维护时间和负责人。

```powershell
Write-Output '已确认维护窗口'
```

## 核对补丁包

查看文件摘要，人工核对预期值。本示例不提供真实补丁或预期摘要。

```powershell
Get-FileHash -LiteralPath 'C:\RunbookExample\patch.zip' -Algorithm SHA256
```

## 记录人工确认

确认检查事项都已处理，写下本次结论。不需要指令也可以成为可跟踪步骤。
