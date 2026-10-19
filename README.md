# Codex Auto Resume

适用于 Windows Codex 桌面端的额度恢复监控脚本。当本地聊天最新一轮因使用额度耗尽而失败，且服务端确认额度恢复后，自动向原聊天发送一次续跑消息。

默认监控全部未归档的本地根聊天，保留原聊天、原模型和原思考配置。项目仅依赖 Node.js 内置模块，无需安装 npm 依赖或提供 API Key。

## 环境要求

- Windows，已安装并登录 Codex 桌面端。
- Node.js 24 或更新版本，`node` 命令可用。
- 监控期间保持 Codex 打开，电脑开机并联网。

脚本通过 Codex 桌面端的内部命名管道和本地 SQLite 索引工作。已验证的桌面端版本为 `26.1007.2314.0`，CLI 为 `0.162.0-alpha.17.2`；软件升级可能影响兼容性。启动前建议先执行只读检查。

## 快速开始

1. 克隆仓库，或下载并解压 ZIP。

   ```powershell
   git clone https://github.com/molbird/codex-auto-resume.git
   cd codex-auto-resume
   Copy-Item config.example.json config.json
   ```

2. 编辑 `config.json`，将 `controllerThreadId` 替换为自己 Codex 桌面端中一个本地聊天的实际 ID。该聊天用作桌面工具调用上下文，会自动从续跑目标中排除。可在对应聊天中请 Codex 查询聊天 ID。需要排除的其他聊天 ID 放入 `excludeThreadIds`。

3. 保持 Codex 打开并登录，先运行只读检查。该操作不会发送续跑消息。

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Monitor.ps1 -Check
   ```

4. 检查通过后，双击 `启动监控.cmd`。看到 `Monitor started` 后可以关闭启动窗口，监控会在后台继续。

5. 双击 `检查状态.cmd` 查看状态；双击 `停止监控.cmd` 结束监控。

`config.json`、运行记录和日志仅保存在本地，已通过 `.gitignore` 排除。仓库中的 `config.example.json` 不包含个人聊天 ID。

## 续跑规则

- 默认每 60 秒检查一次。读取额度和聊天状态不会发起模型推理。
- 根据服务端 `resetsAt` 等待，并留出 20 秒缓冲；时间到了仍须重新确认 `ordinaryUsageAllowed === true`。
- 每周额度耗尽时继续等待相应额度恢复。脚本不会使用重置券或购买额外额度。
- 只读取最新一轮的结构化失败状态，不把聊天正文中提到“额度”的内容当作错误。
- 已完成、手动中断、正在运行、等待审批或等待用户回答的聊天不会被续跑。归档聊天、子代理和远程聊天不在监控范围内。
- 续跑提示要求遵守原任务的目标、范围、审批要求和停止条件；需要用户作出的必需决定仍会等待用户。
- 启动时已经因额度停止的旧聊天也可能被续跑。需要排除的聊天应先归档，或加入 `excludeThreadIds`。
- 默认最多同时自动恢复两个聊天；同一项目目录已有聊天运行时暂缓，避免同时修改同一批文件。
- 每个失败轮次最多提交一次消息。发送前落盘记录；发送结果不明确时记录 `uncertain`，停止重复发送该轮次。新的额度失败轮次可在冷却 5 分钟后继续恢复。
- 完成正常轮次后不会无条件反复发送“继续”。长任务应在原聊天中明确目标和完成条件。

后台启动器默认阻止自动休眠，允许屏幕关闭和锁屏；停止后自动释放。电脑仍需接电并保持开机。手动休眠、关机或合盖导致的休眠会中断监控。Codex 关闭或连接中断时，脚本会等待并重连。

## 配置

修改 `config.json` 后，停止并重新启动监控即可生效。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `pollSeconds` | `60` | 检查间隔，单位为秒 |
| `resetGraceSeconds` | `20` | 额度重置后的等待缓冲，单位为秒 |
| `maxConcurrentResumes` | `2` | 自动恢复聊天的并发上限 |
| `retryCooldownSeconds` | `300` | 同一聊天不同失败轮次的续跑冷却时间，单位为秒 |
| `refreshUnchangedMinutes` | `15` | 索引未变化的聊天重新读取的间隔，单位为分钟 |
| `controllerThreadId` | 需填写 | 本地桌面工具调用上下文的聊天 ID，自动排除续跑 |
| `excludeThreadIds` | `[]` | 额外排除的聊天 ID 列表 |
| `resumePrompt` | 见示例配置 | 自动发送到原聊天的续跑提示词 |

`runtime/monitor.log` 保存运行日志，`runtime/status.json` 保存最近状态，`runtime/state.json` 保存防重复记录。请保留 `state.json`，重新启动时会继续使用它。发送结果不明确时，先核实对应聊天，不要通过删除记录盲目重发。

脚本不修改 Codex 的登录文件、配置文件或聊天数据库，不需要管理员权限。启动命令的 PowerShell 执行策略仅对该进程生效。

## 命令行

在项目目录运行：

```powershell
# 只读检查，不发送消息
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Monitor.ps1 -Check
# 前台运行，便于查看日志；Ctrl+C 停止
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Monitor.ps1 -Foreground
# 后台运行，但不阻止自动休眠
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Monitor.ps1 -NoKeepAwake
# 查看当前状态 / 请求停止
node .\codex-auto-resume.mjs --status
node .\codex-auto-resume.mjs --stop
# 运行模拟测试，不连接真实聊天
node --test
```

## 实现与验证

- `codex-auto-resume.mjs`：命令行入口、配置加载、监控循环和重连。
- `lib/desktop-client.mjs`：桌面端管道发现、分帧协议和工具调用。
- `lib/thread-index.mjs`：只读扫描本地 SQLite 聊天索引，覆盖超过最近 50 个聊天的范围。
- `lib/policy.mjs`、`lib/monitor.mjs`：额度恢复判断、失败轮次识别、并发控制和续跑。
- `lib/storage.mjs`：运行锁、原子落盘和日志。
- `test/`：模拟额度耗尽和恢复、每周限制、最新轮次识别、防重复、发送中断及本地协议测试。

测试覆盖了桌面端错误缺少 `codexErrorInfo`、`You’ve hit your usage limit` 含 Unicode 引号的情况，以及用户手动继续后跳过旧失败轮次的情况。

额度字段和会话生命周期可参考 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。本项目实际使用的桌面管道和本地索引属于内部接口；连接或格式不兼容时会记录错误并停止发送。模拟测试不代表已经在所有桌面端版本上完成真实额度重置验证。
