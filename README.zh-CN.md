# OMP Slack Extension

[English](README.md) | 简体中文

适用于 OMP 18.10.4。输入 `/slack`，手动把 Slack 绑定到当前打开的主会话。Slack 请求和回答直接出现在该会话中，共享已有上下文、模型、工具和审批规则。加载插件、重启或切换会话均默认关闭；关闭会话会断开连接。

本次原生通道改造仅完成云端测试，尚未部署 Windows，也没有真实 Slack/模型联调。以前的主会话探针及 Slack 结果不能替代本次验收。见 [原生通道说明](docs/native-channels.md) 和 [Windows 验收清单](docs/windows-acceptance.md)。

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
| `/slack off` | 停止接收和回复，精确移除仍可编辑的 Slack 排队项，不 abort 主会话 |
| `/slack status` | 查看连接、队列及运行状态 |
| `/slack channels` | 本地列出机器人可访问的会话；需要相应读取 scope |

### Slack 消息方式

| Slack 正文（频道中先 @bot） | 原生通道 |
| --- | --- |
| 普通正文，或 `!queue 内容` | 默认 `followUp` 队列 |
| `!insert 内容` 或 `!steer 内容` | 原生 `steer` 插入 |
| `!status` | 直接查询状态，不进入 LLM 工作队列 |

这些是普通消息前缀，不是 Slack Slash Command。沿用现有发送者/频道权限，包括获准频道的成员及 bot；插入不额外收紧成仅 owner。事件先鉴权、去重，再提交或回复控制命令；空插入/排队命令只返回用法。

插件调用 OMP `prompt` 并显式指定 `streamingBehavior`：空闲时正常唤醒，忙碌时立即交给 OMP 原生通道，不等待上一个 Slack 任务完成或宿主空闲。仅序列化 admission，保持提交顺序。原生逐条模式下 follow-up 按 FIFO 消费；原有批量/steering 设置保持不变，插入可以先于排队消息。插件不更改这些设置，也不调用主会话 `abort`。

原生 steer 能中断纯等待，并可让支持的 shell 工具协作转入后台；不保证任意工具都能立即让出，也不表示允许终止训练进程。自定义工具可能有自身的 steering 行为。切换、分支或会话树导航后都需重新绑定。

同一机器、同一系统用户下，同一工作区/App 仅保留一个绑定。另一 OMP 会话执行 `/slack` 会自动接管：旧绑定先停止收事件，撤回仍可编辑的原生队列项、撤销旧回复权限并关闭连接，新绑定才连接。已经 admitted 或领取的工作可能继续在旧会话运行；旧 OMP 进程及主会话保留。同一会话重复启用保持原连接。Windows 使用绑定期间的独占命名管道，没有常驻服务或持久锁文件；进程异常退出后，操作系统回收管道，重新执行 `/slack` 即可。旧进程卡死、无法确认连接已停止时不会强开第二个连接。

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

Slack 请求沿用绑定会话的全部现有工具和审批规则；不需要另外配置 `OMP_SLACK_LOCAL_TOOLS`。这是共享主会话，所有允许来源都会使用该会话上下文，不提供频道/线程上下文隔离或文件系统沙箱。只向可信任其访问宿主上下文和工具权限的人或代理开放。路由校验防止误投目的地，不能防止共享上下文中的语义泄漏。

每个请求带生成的 `request_id` 和不可变来源路由。admission 只是接收，必须观察到原生 `message_start` 确认消费后才允许使用对应 Slack 工具。所有 Slack 工具均接受可选 `request_id`；只有唯一、无混合输入的活动请求可省略。插入本地/另一 Slack 工作，或原生批量消费时，应使用各个已消费请求的显式 ID。排队中和已结束的 ID 无效；工具不能另指定频道或线程。

`slack_reply` 成功发送正文后，该请求不再自动发送最终说明。自动最终回复仅限唯一归属明确且成功的回答；混合、空白、模型截断、报错和 aborted 结果不广播。后续 follow-up 仍运行时，先前请求也可在原生轮次边界完成回复，无需等待全局空闲。发送文本支持真实的 `<@用户ID>` 提及。

附加工具包括 `slack_reply`、`slack_read_thread`、`slack_upload_file`、`slack_download_file`、`slack_list_conversations`。上传使用宿主模式，接受主会话工作目录中的相对路径或绝对路径，不要求专用输出目录；仍需该请求明确要求上传，并经过 OMP 原有 write 审批。上传普通文件目前最多 10 MiB、每项请求最多 3 个。不要上传凭据或无关文件。

下载需 `files:read` 并重新授权。`slack_download_file` 使用明确的 Slack 文件 ID，将来源会话中分享的文件保存到新的本机路径；需要的新子目录会自动创建。它沿用 write 审批，不覆盖已有文件，并返回字节数和 SHA-256。目前每文件最多 10 MiB。

线程读取受已授权 Slack scope 约束；最小配置不能读取完整频道历史。读取工具每项请求最多 3 页、每页 15 条。远程会话枚举只返回来源会话；本地 `/slack channels` 可枚举更多会话，但需额外读取 scope。

最多记录 32 个未完成请求，这是接收上限，不是插件私有执行队列。没有任务墙钟或空闲超时。本地输入会撤销先前远程请求的工具/回复关联，不会为了插件而 abort 本地工作。

**off、断连、接管均不是执行终止开关。** 立即停止接收并撤销回复权限；只按完整文本精确移除两个原生通道中仍可编辑的本插件消息，包括在 TUI 中提升为 steer 的 follow-up。已进入 idle preflight、已经领取/live-steered 或已经消费的工作可能继续。不会 abort 主会话，也不清除无关原生队列项。切换会话时旧路由失效，原生 generation 校验与 admission 守卫阻止旧提交进入新会话。已提交给 Slack 的写入不能回滚，重新启用也不重放已撤销请求。

网络层独立保留时限：Web API 单次尝试 10 秒，文件 HTTP 单次尝试 30 秒。读取请求遇到瞬时网络错误或可重试 5xx 使用指数退避和 jitter，最多 4 次尝试、总计不超过 2 分钟；明确拒绝的 429 至少等待 [Slack 的 Retry-After](https://docs.slack.dev/apis/web-api/rate-limits)。SDK 内部 HTTP 重试保持关闭，避免重试叠加。认证、权限和参数错误不重试；Socket Mode 保留现有连接等待及重连行为。

消息发送和文件上传各阶段只重试明确拒绝的 429。丢失响应、网络超时或不确定的 5xx 报告 `network_outcome_uncertain` 并撤销该来源请求的回复权限，不盲目重发，也不再自动发送另一份最终回答。[上传完成方法只能调用一次](https://docs.slack.dev/reference/methods/files.completeUploadExternal)。不增加 scope，也不假设未支持的幂等保证。`No automatic retry` 指不会重跑整个 agent 任务，网络重试只发生在单个 HTTP 请求内。

绑定的 OMP 会话保存 `omp_slack_request` 自定义日志项，包含 event ID、生成的 request ID、来源线程/消息 ID、开始结束时间和固定原因分类；不保存请求正文、回复、token、原始错误或工具内容。`/slack status` 直接读取 OMP 的 idle、待处理消息和 streaming 状态，并显示最近观察到的 agent/turn/message/tool 事件及工具数。Slack `!status` 只返回当前发送者/来源线程的计数，以及全局 streaming、最近观察到的活动计数和时间，不暴露其他来源 ID、正文或工具参数。即使达到未完成请求上限，也可直接查询；仍受 Slack 连通性/限流和最多 4 个并行控制回复约束。`claimed` 表示 admitted 但未出现在可编辑队列中、且尚未观察到消费，可能包括 preflight 或已移除待结算项。工具计数仅覆盖启用后的观察，不证明真实训练进程状态。快照仅供诊断，长时间思考或执行工具不会触发空闲取消或自动恢复。

## 验证

```powershell
npm run check
```

检查包含类型、原生 admission/消费关联、队列/插入模式、多来源路由、状态直达、既有成员/bot 权限、去重、迟到 admission/会话切换竞态、零主会话 abort 的 off、网络和文件回归。仓库保留旧独立 SDK 模块及其历史测试；运行入口使用 `NativeSession`。

本次原生通道测试使用公开 API 协议夹具及固定 SDK 的类型/源码校验，没有运行真实 OMP 模型循环。真实 Slack、wait/后台工具行为、Windows、获准非 owner/代理、文件和宿主审批都需单独验收，不能用 mock 通过代替。详见 [验收清单](docs/windows-acceptance.md)。

### 云端真实运行时验证

[可复现的 OMP 18.10.4 测试](validation/runtime/README.md) 在 Linux 上运行，不需要 Slack 或模型凭据。10 项测试执行真实调度、wait、子进程、路由、关闭/接管和会话切换；模型内容及 Slack 网络边界使用模拟。

### 模型额度和限流提醒

已消费的 Slack 请求遇到模型额度/429 错误时，会在原线程发送固定、脱敏提醒；同一故障不反复刷屏。同模型确实再次成功返回后才通知恢复，不探测、不重跑任务。拿不到可靠且对应本次失败的服务端时间时明确写“未知”，不把 OMP 退避时间冒充恢复时间。详见 [接口与边界](docs/provider-notices.md)。
