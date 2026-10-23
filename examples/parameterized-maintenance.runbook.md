<!-- runbook:document version="1" -->

<!-- runbook:parameters {"ENV":"演示环境","HOST":"staging.example","VERSION":"v1.0"} -->

# {{rb:ENV}} · 补丁维护演示

这是体验变量和独立实例的示例。请根据实际维护手册修改流程；应用仅复制指令，不会执行。

<!-- runbook:step id="50abc7e1-6600-459d-9525-b7f6427c5bd1" -->
## 确认本次环境

检查目标为 **{{rb:HOST}}**，版本为 **{{rb:VERSION}}**。
此步骤没有指令，是一个需要人工记录结果的检查点。
<!-- /runbook:step -->

<!-- runbook:step id="602398ca-be76-48c3-bcd0-d3d80b64ea71" -->
## 查看本次信息

以下仅打印演示信息。复制后需要自行在外部 PowerShell 中执行。

<!-- runbook:command id="d7b57f87-17f6-4326-8e27-e7fdd89577e3" -->
```powershell
Write-Output "目标={{rb:HOST}} 版本={{rb:VERSION}}"
```
<!-- /runbook:step -->

<!-- runbook:step id="7b9fbf15-a8a3-420e-bb4a-8a866079a897" -->
## 留下本次结论

记录检查结果、异常和后续事项。可以在“编辑实例”中增删检查点或调整顺序；这些修改仅属于本次实例。
<!-- /runbook:step -->
