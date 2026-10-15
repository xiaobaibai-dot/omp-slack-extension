# OMP Slack Extension

[English](README.md) | 简体中文

适用于 OMP 18.10.4。输入 `/slack`，手动把 Slack 绑定到当前打开的主会话。Slack 请求和回答直接出现在该会话中，共享已有上下文、模型、工具和审批规则。加载插件、重启或切换会话均默认关闭；关闭会话会断开连接。

当前仍待完成新版的真实 Slack 联调。Windows 实际 SDK 已验证同一主会话及上下文共享；旧版的 Slack 私聊成功不能替代新版验收。见 [Windows 验收记录](docs/windows-acceptance.md)。

## 安装与使用

```powershell
git clone https://github.com/xiaobaibai-dot/omp-slack-extension.git
cd omp-slack-extension
npm ci
omp --extension "C:\path\to\omp-slack-extension\index.ts"
```

长期安装可将入口及 `src`、运行依赖放入 `~/.omp/agent/extensions/omp-slack/`，由现有 OMP 自动发现。Windows 持久配置入口为 `windows.ts`；安装时以它作为扩展入口，并保留主实现 `index.ts` 的导入路径。插件不另装 OMP，不更改宿主模型或审批策略。

| 本地命令 | 行为 |
| --- | --- |
| `/slack`、`/slack on` | 绑定当前主会话并连接 |
| `/slack off` | 断开，取消排队和当前 Slack 请求；保留主会话内容 |
| `/slack status` | 查看连接、队列及运行状态 |
| `/slack channels` | 本地列出机器人可访问的会话；需要相应读取 scope |

主会话忙碌时按 FIFO 排队，不使用 steering。重复事件只执行一次。每次切换、分支或会话树导航后都需重新绑定。

同一机器、同一系统用户下，同一工作区/App 仅保留一个绑定。另一 OMP 会话执行 `/slack` 会自动接管：旧绑定先停止收事件、取消自己的 Slack 任务并关闭连接，新绑定才连接；旧 OMP 进程及主会话保留。同一会话重复启用保持原连接。Windows 使用绑定期间的独占命名管道，没有常驻服务或持久锁文件；进程异常退出后，操作系统回收管道，重新执行 `/slack` 即可。旧进程卡死、无法确认连接已停止时不会强开第二个连接。

首次升级需要旧监听先执行 `/slack off`，再让使用中的 OMP 进程加载新版。没有接管协议的旧版本无法自动移交。跨机器不提供互斥，仍需确保同一 App 没有其他机器的活跃监听。

## Slack 配置

使用已有 Slack App，开启 Socket Mode、Messages tab，并安装到工作区。无需创建 Slack Slash Command；`/slack` 是 OMP 本地命令。

- Bot Token：`xoxb-`，scope 为 `app_mentions:read`、`chat:write`、`im:history`；上传另需 `files:write` 并重新授权。
- App-Level Token：`xapp-`，scope 为 `connections:write`。
- Bot events：`app_mention`、`message.im`。
- 把 bot 邀请到使用的频道。频道请求每次 @bot；一对一私聊可直接请求。

普通入口从 OMP 启动时的环境读取配置：

| 环境变量 | 内容 |
| --- | --- |
| `OMP_SLACK_TEAM_ID`、`OMP_SLACK_APP_ID` | 工作区及 App 的 Slack ID |
| `OMP_SLACK_BOT_TOKEN`、`OMP_SLACK_APP_TOKEN` | 两种令牌 |
| `OMP_SLACK_OWNER_IDS` | 私聊允许的用户 ID，逗号分隔 |
| `OMP_SLACK_CHANNEL_IDS` | 接收频道和私聊 ID；设置后需包括对应 `D...` 私聊 |
| `OMP_SLACK_CHANNEL_ALL_USERS` | 允许所有成员及 bot @请求的频道 ID，必须同时在频道列表中 |

未列在 `CHANNEL_ALL_USERS` 的来源仍只接受 owner。开放频道接受成员和 bot 的 @请求，不额外过滤 bot 或自身身份。普通频道消息、消息编辑、群组私聊和其他工作区/App 事件忽略。

Windows 可由用户运行一次 `scripts/Configure-Slack.ps1`，传入上述非秘密 ID；它隐藏输入两个令牌，以 Windows 用户加密方式保存到 `~/.omp/agent/slack-credentials.json`。`windows.ts` 仅在手动启用时读取这份配置，不设置全局环境变量。不要把令牌发送到聊天、Git 或日志。

```powershell
.\scripts\Configure-Slack.ps1 -TeamId 'T...' -AppId 'A...' -OwnerIds 'U...' -ChannelIds 'D...,C...' -ChannelAllUsers 'C...'
```

## 工具与回复

Slack 请求沿用绑定会话的全部现有工具和审批规则；不需要另外配置 `OMP_SLACK_LOCAL_TOOLS`。这是共享主会话，所有允许来源都会使用该会话上下文。回复仅返回当前请求的来源线程；本地其他输入产生的回答不会自动广播到 Slack。

使用 `slack_reply` 成功发送正文后，桥接器不会再发送最终说明；未使用显式回复时，最终回答自动发送。发送文本支持真实的 `<@用户ID>` 提及。

附加工具包括 `slack_reply`、`slack_read_thread`、`slack_upload_file`、`slack_download_file`、`slack_list_conversations`。上传使用宿主模式，接受主会话工作目录中的相对路径或绝对路径，不要求专用输出目录；仍需该请求明确要求上传，并经过 OMP 原有 write 审批。上传普通文件目前最多 10 MiB、每项请求最多 3 个。不要上传凭据或无关文件。

下载需 `files:read` 并重新授权。`slack_download_file` 使用明确的 Slack 文件 ID，将来源会话中分享的文件保存到新的本机路径；需要的新子目录会自动创建。它沿用 write 审批，不覆盖已有文件，并返回字节数和 SHA-256。目前每文件最多 10 MiB。

线程读取受已授权 Slack scope 约束；最小配置不能读取完整频道历史。读取工具每项请求最多 3 页、每页 15 条。远程会话枚举只返回来源会话；本地 `/slack channels` 可枚举更多会话，但需额外读取 scope。

队列最多 32 项。主会话桥接不附加任务墙钟时限或空闲超时；手动取消、会话关闭/切换和绑定接管仍取消对应 Slack 请求。执行中插入本地用户输入时，为避免把混合回答发往错误来源，该 Slack 请求不再转发最终文本。关闭不会回滚已提交的 Slack 消息或上传。

网络层独立保留时限：Web API 单次尝试 10 秒，文件 HTTP 单次尝试 30 秒。读取请求遇到瞬时网络错误或可重试 5xx 使用指数退避和 jitter，最多 4 次尝试、总计不超过 2 分钟；明确拒绝的 429 至少等待 [Slack 的 Retry-After](https://docs.slack.dev/apis/web-api/rate-limits)。SDK 内部 HTTP 重试保持关闭，避免重试叠加。认证、权限和参数错误不重试；Socket Mode 保留现有连接等待及重连行为。

消息发送和文件上传各阶段只重试明确拒绝的 429。丢失响应、网络超时或不确定的 5xx 报告 `network_outcome_uncertain` 并停止该来源请求，不盲目重发，也不再自动发送另一份最终回答。[上传完成方法只能调用一次](https://docs.slack.dev/reference/methods/files.completeUploadExternal)。不增加 scope，也不假设未支持的幂等保证。`No automatic retry` 指不会重跑整个 agent 任务，网络重试只发生在单个 HTTP 请求内。

绑定的 OMP 会话保存 `omp_slack_request` 自定义日志项，包含 event ID、生成的 request ID、来源线程/消息 ID、开始结束时间和固定原因分类；不保存请求正文、回复、token、原始错误或工具内容。`/slack status` 直接读取 OMP 的 idle、待处理消息和 streaming 状态，并显示最近观察到的 agent/turn/message/tool 事件及工具数。该快照仅供诊断，长时间思考或执行工具不会触发空闲取消或自动恢复。

## 验证

```powershell
npm run check
```

检查包含类型、事件路由/成员权限、FIFO、去重、连接/重连/取消、共享主会话归属与上传。仓库保留旧独立 SDK 模块及其历史回归测试；运行入口已使用共享 runner。

实际 Windows 18.10.4 SDK 的离线夹具验证了主会话实例、原上下文传入模型及同一 transcript 的请求/回答；没有网络或真实模型费用。真实 Slack、频道成员、文件上传及宿主审批的结果需单独记录，不能用 mock 通过代替。详见 [验收清单](docs/windows-acceptance.md)。
