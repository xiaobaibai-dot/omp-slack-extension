# OMP Slack Extension

[English](README.md) | 简体中文

为 [oh-my-pi](https://github.com/can1357/oh-my-pi) 18.10.4 提供默认关闭、按终端会话启用的 Slack Socket Mode 扩展。

> 当前为原型：现有云端验证记录为 TypeScript 类型检查和 27 项模拟测试通过。Windows、真实 Slack 收发、真实模型调用以及实际 SDK 运行时兼容性仍待验证。请先使用专用测试频道，按 [Windows 实机验收清单](docs/windows-acceptance.md) 验证后再使用。

## 功能与工作方式

- 在 OMP 终端输入 `/slack` 或 `/slack on` 才会连接 Slack。加载扩展本身不会开启连接。
- 只接受指定工作区、指定应用中，由用户白名单成员发来的请求。频道里每次请求都需要 @机器人；一对一私信可直接触发。
- 忽略未授权用户、其他机器人、消息编辑、群组私信及不支持的事件。
- 请求按先进先出顺序处理，最多等待 32 个请求，每个正在执行的请求限时 10 分钟。只有在 OMP 主会话空闲且没有待处理消息时才启动下一项任务。
- 每项请求创建独立的内存 SDK `AgentSession`，结束后释放。Slack 请求不会被注入主会话，也不会通过 steering 改写主会话输入。
- 同一路由保留有限上下文：频道按“工作区 + 频道 + 线程”区分，私信按“工作区 + 私信会话 + 用户”区分。每条路由最多保留最近 6 轮请求/回复，序列化后不超过 32,000 个字符，总共最多保存 32 条路由。
- 回复和文件上传固定发送到请求来源的会话与线程，不能指定另一个频道。远程会话列表工具只能返回当前来源会话；本地终端可列出机器人有权访问的更多会话。
- 模型和已认证的提供商配置沿用 OMP 主会话，不需要另配模型 API Key。启用后处理请求仍会正常消耗模型额度，并可能产生费用。
- `/slack off` 会断开连接、清空队列和路由历史，并取消正在执行的任务。重启或切换会话后需要重新启用。

这里的“独立会话”指上下文和工具配置隔离。可选本地工具共享宿主进程权限，详见下文的安全边界。

## 安装

先准备一个已经能够正常使用的 OMP 18.10.4，并满足该版本自身的运行时要求。

克隆或下载本仓库，在仓库目录安装依赖：

```powershell
git clone https://github.com/xiaobaibai-dot/omp-slack-extension.git
cd omp-slack-extension
npm ci
```

使用 OMP 的扩展参数加载入口文件：

```powershell
omp --extension "C:\path\to\omp-slack-extension\index.ts"
```

把示例路径替换为实际路径。如果 OMP 版本不同，先通过 `omp --help` 确认扩展参数，再验证 SDK 兼容性。

本项目测试脚本要求 Node.js >= 22.6，推荐使用 Node.js 24 运行测试。这只说明测试工具的要求，OMP 本身仍需使用其支持的运行时。开发依赖中的 `@oh-my-pi/pi-coding-agent` 固定为 18.10.4，升级前应重新验证。

## 配置 Slack 应用

1. 在 Slack 应用管理页面使用本仓库的 [slack-manifest.json](slack-manifest.json) 创建或配置应用。
2. 确认已开启 Socket Mode，并将应用安装到目标工作区。
3. 获取 Bot User OAuth Token（`xoxb-` 开头）。
4. 创建 App-Level Token（`xapp-` 开头），仅为其授予 `connections:write`。
5. 将机器人邀请到计划使用的频道，准备工作区 ID、应用 ID、允许触发任务的用户 ID，以及可选的频道/私信会话 ID。
6. 在本地安全输入 Token，然后启动 OMP 并输入 `/slack`。

仓库 manifest 提供最小回复/私信配置：

| 类型 | 内容 |
| --- | --- |
| Bot scopes | `app_mentions:read`、`chat:write`、`im:history` |
| Bot events | `app_mention`、`message.im` |
| 连接方式 | Socket Mode |
| App-Level Token scope | `connections:write`，需单独配置 |

无需在 Slack 注册 Slash Command。`/slack` 是在 OMP 本地终端使用的命令。

### 环境变量

在启动 OMP 的同一个终端中设置。用户、频道等列表以逗号分隔，填写 Slack ID，不要填写显示名称。

| 变量 | 是否必填 | 用途 |
| --- | --- | --- |
| `OMP_SLACK_TEAM_ID` | 是 | 目标工作区 ID，通常以 `T` 开头 |
| `OMP_SLACK_APP_ID` | 是 | Slack 应用 ID，以 `A` 开头 |
| `OMP_SLACK_OWNER_IDS` | 是 | 可信用户 ID 白名单，以 `U` 或 `W` 开头；空列表会在联网前拒绝启动 |
| `OMP_SLACK_BOT_TOKEN` | 是 | `xoxb-` 开头的 Bot Token |
| `OMP_SLACK_APP_TOKEN` | 是 | `xapp-` 开头的 App-Level Token |
| `OMP_SLACK_CHANNEL_IDS` | 否 | 允许的频道/私信会话 ID，通常以 `C`、`G` 或 `D` 开头 |
| `OMP_SLACK_UPLOAD_ROOT` | 否 | 专用文件输出目录；未设置时禁止上传文件 |
| `OMP_SLACK_LOCAL_TOOLS` | 否 | 可选本地工具名列表；默认不启用任何本地文件或 shell 工具 |

注意：

- `OMP_SLACK_CHANNEL_IDS` 留空时，白名单用户可在机器人能够收到事件的任意频道或一对一私信中触发任务。
- 设置频道白名单后，如需私信触发，也必须把对应的 `D...` 私信会话 ID 加进去。
- 首次测试建议同时设置用户和频道白名单，不启用本地工具或文件上传。
- 环境变量应在启动 OMP 前设置；修改配置后重新启动 OMP，再次启用扩展。

### Windows PowerShell 安全输入示例

以下 `YOUR_...` 和路径都是占位符。先替换 ID 与路径；Token 通过隐藏输入提供。不要把真实 Token 粘贴到聊天、源码或会写入历史记录的命令中。

```powershell
$env:OMP_SLACK_TEAM_ID = 'YOUR_WORKSPACE_ID'
$env:OMP_SLACK_APP_ID = 'YOUR_APP_ID'
$env:OMP_SLACK_OWNER_IDS = 'YOUR_SLACK_USER_ID'
$env:OMP_SLACK_CHANNEL_IDS = 'ALLOWED_CHANNEL_ID'

$secure = Read-Host 'Slack bot token' -AsSecureString
$env:OMP_SLACK_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
$secure = Read-Host 'Slack app token' -AsSecureString
$env:OMP_SLACK_APP_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
Remove-Variable secure

omp --extension "C:\path\to\omp-slack-extension\index.ts"
```

Token 最终仍存放在进程环境中；隐藏输入不是凭据保险库。测试结束并退出 OMP 后，关闭终端，或清除变量：

```powershell
Remove-Item Env:OMP_SLACK_BOT_TOKEN, Env:OMP_SLACK_APP_TOKEN -ErrorAction SilentlyContinue
```

如果启用本地 shell 工具，它可能读取这些环境变量以及同一进程可访问的其他凭据。请先评估风险。

## 使用命令

以下命令均在 OMP 终端内执行：

| 命令 | 行为 |
| --- | --- |
| `/slack` 或 `/slack on` | 启用当前终端会话的 Slack 连接 |
| `/slack off` | 停止接收请求，清空队列和历史，取消当前任务并断开连接 |
| `/slack status` | 查看连接状态、排队数量和任务是否正在运行等信息 |
| `/slack channels` | 在本地列出机器人可访问的会话；需要相应读取权限 |

典型流程：

1. 启动 OMP，选择可用模型。
2. 执行 `/slack status`，确认初始状态为 `off`。
3. 执行 `/slack`，等待终端提示已开启。
4. 在测试频道中 @机器人提出请求，或发送一对一私信。
5. 在同一频道线程继续提问时，仍需再次 @机器人。
6. 使用结束后执行 `/slack off`。

同一个 Slack 应用在所有终端、所有机器上只运行一个活跃 Socket Mode 监听器。Slack 可能把事件分发给不同连接，本扩展没有分布式锁。[Socket Mode 官方说明](https://docs.slack.dev/apis/events-api/using-socket-mode/)

## 可选工具与权限

远程请求默认获得以下来源绑定工具：

| 工具 | 作用与限制 |
| --- | --- |
| `slack_reply` | 向来源线程发送纯文本；最终回答也会自动发送 |
| `slack_read_thread` | 读取来源线程，每页最多 15 条消息、每条最多 2,000 个字符，每项请求最多读取 3 页；受 Slack 权限与限流约束 |
| `slack_upload_file` | 上传用户明确要求的产物；需额外 scope 和专用输出目录 |
| `slack_list_conversations` | 远程仅返回当前请求来源会话，不暴露其他私有频道名称 |

默认没有远程文件读写或 shell 能力。

### 文件上传

需要同时满足：

- Slack 应用已获得 `files:write`，并完成必要的重新授权。
- 设置 `OMP_SLACK_UPLOAD_ROOT`，指向专用产物目录。
- 用户明确要求发送该文件产物。

上传仅接受相对于输出目录的路径，每个文件最多 10 MiB，每项请求最多上传 3 个文件。实现会检查路径穿越、隐藏路径、符号链接解析后的目录边界及文件变化；这些检查不等于完整的文件内容机密扫描，也不能替代 Windows 实机验收。不要把凭据、无关文件或整个工作目录放入输出目录。

仅设置上传目录不会自动授予模型创建本地文件的能力。

### 会话枚举与历史读取

- 本地会话枚举按会话类型需要 `channels:read`、`groups:read` 或 `im:read`。仅添加实际需要的 scope，并重新授权应用。
- 最小 manifest 只包含 `im:history`，未包含公共/私有频道的历史读取权限，因此不能把频道线程历史读取当作开箱即用功能。
- Slack 当前 `conversations.replies` 文档列出了 Bot token 的 `channels:history`、`groups:history`、`im:history` 等 scope。实际读取还取决于应用权限、会话可见性和 API 限制；扩展尚未完成真实频道读取验证。需要扩展能力时先核对当前官方规则，按最小权限测试，不要自动换用权限更广的 User Token。[官方 API 文档](https://docs.slack.dev/reference/methods/conversations.replies/)
- 本扩展保存的同路由内存历史与 Slack 历史 API 独立，不会因此获得整个频道历史。关闭扩展或重启后，这份内存历史会清空。

### 本地工具：谨慎启用

`OMP_SLACK_LOCAL_TOOLS` 只接受下列名称的逗号分隔子集：

```text
read,grep,glob,write,edit,bash
```

开启后，白名单中的远程用户将能通过模型使用相应的宿主文件系统/进程权限。本地工具沿用宿主设置和策略，但远程会话没有交互式审批界面。启用写入或 shell 前，必须实际验证需要审批的操作会如何处理。

这不是操作系统沙箱。独立 SDK 会话、工具白名单和上传路径检查都不能把本地工具限制在一个安全目录内。默认配置保持本地工具关闭。

## 安全与运行限制

- 用户白名单是任务触发边界；不要把不可信用户加入列表。频道白名单还可以进一步缩小接收范围。
- 同一频道线程的路由历史可能包含不同白名单用户的请求与回复；频道线程历史并不按用户再次分隔。
- Slack 消息和读取到的线程内容应作为不可信外部输入处理，不能据此扩大工具权限或发送目的地。
- 事件会去重，队列满时会丢弃新请求并在本地提示。不要假设每条 Slack 消息都会收到回复。
- 失败和取消时只在本地显示受限错误信息，不向 Slack 转发原始 SDK 错误或未完成的模型文本；结果不确定的发送/上传不会自动重试。
- `/slack off` 会阻止后续操作，但已经提交给 Slack 的消息或上传请求可能仍然完成，无法通过取消实现服务端回滚。
- 启用本地工具前尤其要检查宿主目录、环境变量、模型账户额度和审批策略。不要在问题报告中附上 Token、环境变量完整转储或私密聊天记录。

## 验证与实机验收

在仓库目录执行：

```powershell
npm run check
```

也可以分别运行：

```powershell
npm run typecheck
npm test
```

现有 27 项模拟测试覆盖用户/工作区/应用过滤、队列、去重、路由历史隔离、关闭时的竞争条件、SDK 生命周期、最终文本提取和上传取消等。

测试不会发送真实 Slack 请求，也不会调用真实模型。模拟测试通过不能证明实际 SDK 运行时、Windows 路径处理或 Slack 互通已经可用。完整实机步骤见 [docs/windows-acceptance.md](docs/windows-acceptance.md)，其中包括：

- 默认关闭、加载和连接验证。
- 频道 @提及、私信及原线程回复。
- 主会话与不同路由的上下文隔离。
- 非白名单用户、机器人和主会话忙碌时的行为。
- 执行中关闭、重启/切换会话、重新启用及单监听器要求。
- 单独验收文件上传与本地工具审批边界。

## 常见问题

### 输入 `/slack` 后无法启动

先查看本地提示，确认已选模型、必填变量有效、用户白名单非空、两个 Token 类型正确，且 Bot Token 属于配置的工作区。不要把完整凭据或环境变量打印出来排查。

### 在 Slack 发消息后没有回复

依次检查：

1. 当前 OMP 会话是否已执行 `/slack`，状态是否为 `on`。
2. 消息发送者是否在 `OMP_SLACK_OWNER_IDS` 中。
3. 频道是否已邀请机器人；若设置频道白名单，当前频道或私信 ID 是否在其中。
4. 频道请求是否每次都 @机器人；是否误用了群组私信、编辑消息或不支持的事件。
5. OMP 主会话是否仍在忙碌，队列是否已满。
6. 是否有另一台机器或另一个终端运行同一应用的监听器。
7. 本地是否出现任务取消、超时、模型或 Slack API 错误提示。

### `/slack channels` 或线程读取失败

检查对应 scope、应用重新授权状态和 API 限制。最小 manifest 不包含会话枚举 scope，也不包含频道历史 scope；不要为排障一次性授予全部权限。

### 上传文件失败

确认已配置 `files:write` 和专用输出目录，路径为目录内的相对路径，文件存在且不超过 10 MiB。默认不启用本地工具时，模型无法直接创建本地文件。

## 参考与版本假设

- [oh-my-pi 仓库](https://github.com/can1357/oh-my-pi)：本项目基于 18.10.4 检查，原开发记录中的源码 revision 为 `c7b809a`。
- [OMP 扩展文档](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [OMP SDK 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md)
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)

SDK 调用对版本敏感，上游 `main` 文档也可能继续变化。升级 OMP 或扩大 Slack 权限前，请重新核对代码与官方文档，并完成对应实机验证。
