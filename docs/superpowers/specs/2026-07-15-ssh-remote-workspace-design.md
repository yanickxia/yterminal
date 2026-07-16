# SSH 远程 Workspace Attach 设计

## 背景

yterminal 当前把 workspace/tab/pane 结构保存在 WebView `localStorage` 中，把
`portable-pty` session 保存在 Tauri 主进程内。tab 或 workspace 切换时所谓的
`attachSession` 只是把缓存的 xterm DOM 节点重新挂到页面；关闭应用后 Tauri
进程退出，另一台机器既看不到 workspace 结构，也无法取得原 PTY master。

目标场景是：办公室 Linux 和家中 macOS 都安装 yterminal。B 上启动的 shell、
tmux、vim、Claude/Codex 等程序继续运行在 B；用户回到 A 后，从 sidebar 看到 B
上的 workspace，并按 workspace attach，继续操作相同的进程。

本设计确定：**跨机器通信全部走标准 SSH，不开放 yterminal TCP 端口，不使用
WebSocket，不依赖云中转。** SSH 负责网络连接、用户认证、加密、主机密钥校验、
ProxyJump 和已有的 `~/.ssh/config`；yterminal 只在一个长生命周期 SSH exec
channel 的 stdin/stdout 上承载自己的应用层帧。

## 产品语义

1. 每个 workspace 归属于一台执行主机。workspace 内的所有 shell、cwd、文件、
   Git 仓库和 coding agent 都在该主机上运行。
2. 其他设备 attach 的是 workspace，不是迁移进程。Linux 进程不会被搬到 macOS，
   macOS 进程也不会被搬到 Linux。
3. 执行主机在线但 yterminal GUI 已关闭时，后台 agent 继续持有 PTY，远端仍可
   attach。
4. 执行主机睡眠或离线时，客户端显示 Offline 和最后一次缓存摘要，但不能继续
   输入。机器恢复联网后自动重连。
   锁屏不影响 session；注销用户或重启 OS 不承诺保留任意进程。
5. `Detach` 只断开当前客户端，不结束远端进程；`Terminate` 才杀死 pane 或整个
   workspace。远端 workspace 不能继续复用现在“关闭 UI 即 dispose/kill”的语义。
6. 一个 workspace 可以被多个客户端观看，但同一时刻只有一个 controller 可以
   输入和改变 PTY 尺寸。其他客户端为只读 watcher，可显式执行 Take Control。

## 目标

1. A 能列出 B 的全部 agent-owned workspaces，并还原 tab、split pane、名称、cwd、
   运行/等待/离线状态。
2. attach 后看到已有 scrollback 和当前 TUI 状态，继续输入同一个 PTY。
3. 关闭任意 GUI、SSH 断线、客户端崩溃都不结束执行主机上的工作。
4. 网络恢复后按输出序号补齐缺失数据，不重复、不乱序。
5. 保留 OpenSSH 的所有既有能力和安全语义，不自行实现密钥管理。
6. 本机 workspace 最终也由同一个 agent 管理，使“本机关闭 GUI后再打开”和“从
   另一台机器 attach”使用完全相同的 session 生命周期。

## 非目标

- 不迁移正在运行的 OS 进程、内存、文件系统或 UNIX socket。
- 不在第一阶段支持执行主机完全离线后的可写 continuation；这属于代码/数据同步
  加 agent resume 的另一类“handoff”功能。
- 不暴露公网 daemon 端口，不设计账号系统、云 relay 或 yterminal 自有证书体系。
- 不把 tmux 作为必需依赖。tmux 在远端 pane 内照常工作，但不是 yterminal
  persistence 的实现基础。
- 不通过 SSHFS 把整个远端文件系统挂到客户端。
- 第一版不支持多个客户端同时写入同一 workspace。

## 总体架构

```text
A: Tauri/React GUI
  -> Tauri HostConnectionManager
  -> OpenSSH child process
  -> ssh -T <ssh-config-alias> ~/.local/bin/yterminal-agent connect
       ================================================================ SSH
  -> B: yterminal-agent stdio bridge
  -> B: per-user Unix domain socket
  -> B: yterminal-agent daemon
       -> Workspace repository (SQLite)
       -> PTY SessionManager
       -> output journal/checkpoint
       -> cwd/process/git/file/agent services

B: local Tauri/React GUI
  -> B: per-user Unix domain socket
  -> the same yterminal-agent daemon
```

跨机器路径只有 SSH。B 上 stdio bridge 与 daemon 之间的 Unix domain socket 是
同一用户会话内的本机 IPC，不监听网络；socket 目录权限为 `0700`，socket 仅允许
当前用户访问。

### 为什么调用系统 OpenSSH

客户端直接启动系统 `ssh`，不在 Rust 中重新实现 SSH 协议。这样天然支持：

- `~/.ssh/config` 中的 Host、User、Port、IdentityFile、ProxyJump；
- ssh-agent、硬件密钥和系统 keychain；
- `known_hosts` 与主机密钥变更检测；
- 企业已有的堡垒机、VPN 和 Tailscale 网络；
- macOS/Linux 已验证过的认证行为。

连接配置只保存一个 `sshTarget`（推荐使用 ssh config alias）和显示名称，不保存
密码或私钥，不允许 UI 注入任意 SSH 参数。高级配置统一写入 `~/.ssh/config`。

建议命令形态：

```text
ssh -T \
  -o BatchMode=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -- <sshTarget> \
  ~/.local/bin/yterminal-agent connect
```

远端 command 是固定字符串，不拼接 workspace id、路径或用户输入。`sshTarget` 作为
独立 argv 传给 OpenSSH，并拒绝以 `-` 开头的值。不得添加
`StrictHostKeyChecking=no`、`UserKnownHostsFile=/dev/null` 或自动 agent forwarding。

MVP 使用 `BatchMode=yes`，要求密钥、ssh-agent 或已有的非交互认证可用。首次主机
确认/密码交互失败时，UI 展示 stderr 和可复制的 `ssh <target>` 验证命令，不在
协议 stdout 中混入终端 prompt。

## 组件划分

### 1. yterminal-agent daemon

daemon 是每个 OS 用户一个的后台进程，职责包括：

- 持有所有 live PTY master、child、reader/writer；
- 保存 workspace 文档、pane 与 session 的映射；
- 给 PTY 输出分配单调递增序号并写 journal；
- 保存客户端上传的 xterm checkpoint；
- 管理 controller lease 和 subscriber；
- 在执行主机上完成 cwd、process tree、Git、文件读取和 agent resume；
- 增量旁路解析 OSC 7、OSC 0/2、OSC 777 等状态信号，不改写 journal 中的原始
  bytes；在无 GUI 连接时仍能更新 cwd、title 和 coding-agent status；
- 从 `Pane.Input` 维护当前 input line/最近提交命令，并在 daemon 内定时执行现有的
  process tree、agent session/env snapshot，避免这些能力继续依赖前端 15 秒 timer；
- 在没有 GUI、没有 SSH client 时继续运行。

Linux 通过 systemd user service 安装，macOS 通过 LaunchAgent 安装。服务在用户
登录会话内启动，`Restart=on-failure`；GUI 退出或 SSH channel 关闭不停止服务。
机器重启后不能恢复任意 OS 进程，只恢复 workspace 文档、scrollback checkpoint、
cwd 和可恢复的 coding-agent 信息，并把旧 session 标为 exited/lost。

### 2. yterminal-agent stdio bridge

SSH 固定命令启动短生命周期的 `connect`。它连接本机 daemon socket，把
SSH stdin/stdout 与 daemon client connection 双向转发。bridge 不拥有 PTY，SSH
断开后可以直接退出。

stdout 只能写协议帧；日志和诊断只能写 stderr。agent 未安装、daemon 不可用、
协议版本不兼容时，bridge 用非零退出码和单行 stderr 返回明确错误。

### 3. HostConnectionManager

Tauri backend 中每个在线 host 保持一个 SSH child process，而不是每个 pane 启动
一条 SSH。一个连接复用 workspace 控制消息、多个 pane 的输入/输出和 host service
RPC，减少握手开销并保持全局顺序。

Manager 负责：

- 启动、监控和停止 OpenSSH child；
- framed codec、request/response correlation、事件分发；
- stderr 分类和连接状态；
- keepalive、重连退避和协议握手；
- 通过 Tauri Channel 把 host/workspace/pane events 发送给前端。

本机连接使用相同应用协议和 request types，只把 transport 换成 Unix socket。不要
为 local/remote 各维护一套 PTY 语义。

### 4. 前端 host/workspace projection

Zustand 不再是远端 workspace 的权威存储，而是 agent snapshot/event 的本地
projection。共享文档的 mutation 通过 typed operation 发给 owner agent，成功后
由 agent event 推进 revision。

以下状态属于 agent、在所有客户端共享：

- workspace/tab/pane ID 和层级；
- workspace/tab 名称和图标；
- pane session、spawn cwd、最近 cwd、运行/退出状态；
- split 结构；
- coding-agent runtime status。

以下状态属于每个客户端，不相互覆盖：

- 当前选中的 host/workspace/tab/pane；
- sidebar、AI、Git panel 宽度和开关；
- terminal selection、搜索词、viewport/scrollTop；
- theme、字体、快捷键设置；
- workspace/tab pin 和 split size 的本机 override。

共享文档可保存 split 的 default sizes，客户端 resize 默认只更新本机 override，
避免 A 的窗口尺寸改变 B 的界面布局。PTY 的实际 cols/rows 只跟随 controller 当前
可见 pane。

## 标识与数据模型

agent 首次启动生成并持久化 `deviceId`。同一台机器即使通过两个 SSH alias 连接，
也以握手返回的 `deviceId` 去重。

```ts
interface HostProfile {
  id: string;          // client-local UUID
  name: string;
  sshTarget: string;   // ~/.ssh/config alias, host, or user@host
}

interface RemoteHostIdentity {
  deviceId: string;
  hostname: string;
  os: "linux" | "macos";
  arch: string;
  agentVersion: string;
  protocolMin: number;
  protocolMax: number;
}

interface WorkspaceDocument {
  id: string;
  revision: number;
  name: string;
  icon?: string;
  tabs: SharedTab[];
}

interface SharedPaneLeaf {
  type: "leaf";
  id: string;          // stable UI pane UUID
  sessionId: string;   // agent session UUID, never an OS pid
  cwd: string;
}

interface SessionRef {
  deviceId: string;
  sessionId: string;
}
```

OS pid 是执行主机的内部实现，不再作为前端 session handle。所有 cwd/process/agent
查询都以 `SessionRef` 路由到 owner agent，避免把 B 的 pid 误传给 A 的本机 API。

SQLite 初始可采用 workspace JSON + session tables，避免第一阶段把递归 pane tree
拆成大量关系表：

```text
meta(device_id, schema_version)
workspaces(id, revision, document_json, updated_at)
sessions(id, workspace_id, pane_id, state, cwd, exit_code, created_at, updated_at)
output_chunks(session_id, start_seq, end_seq, data_blob)
checkpoints(session_id, through_seq, ansi_blob, updated_at)
```

workspace mutation 和 revision 增加必须在同一事务中提交。session UUID 永不复用，
因此进程退出、daemon 重启和 pid reuse 都不会让客户端 attach 到错误进程。

## SSH 上的帧协议

协议使用 length-prefixed CBOR：

```text
u32 big-endian payload_length
CBOR payload
```

选择 CBOR 是因为终端输出、输入和 checkpoint 本身是 bytes；JSON/base64 会增加体积
和复制。每个普通 frame 最大 1 MiB，PTY output chunk 最大 64 KiB。大 checkpoint
必须用 begin/chunk/end 分帧发送，不能提高单 frame 上限。解析器在分配内存前检查
长度，未知 message type 按 negotiated capability 处理。

统一 envelope：

```text
Request  { protocol, requestId, method, body }
Response { protocol, requestId, ok, body?, error? }
Event    { protocol, streamId?, event, body }
```

同一 SSH stdout 只有完整 frame。request/response 可并发；PTY output 使用 event，
不为每个输出块等待 response。输入同样使用有序的 one-way event，依赖 SSH channel
的可靠有序传输，避免逐按键 RTT。

### 握手

连接建立后第一组消息必须是：

```text
ClientHello {
  protocolMin, protocolMax, appVersion, clientId, clientName,
  supportedCapabilities
}

AgentHello {
  selectedProtocol, agentVersion, deviceId, hostname, os, arch,
  supportedCapabilities
}
```

协议范围无交集立即失败。小版本能力通过 capability negotiation 渐进启用；不能依赖
“客户端和 agent 版本字符串完全相等”。

### 核心 request

```text
Host.ListWorkspaces
Workspace.Get
Workspace.Subscribe
Workspace.ApplyOp { workspaceId, baseRevision, opId, operation }
Workspace.Create
Workspace.Detach
Workspace.Terminate

Control.Acquire { workspaceId, force }
Control.Release { workspaceId, leaseEpoch }
Control.Heartbeat { workspaceId, leaseEpoch }

Pane.Attach { sessionId, afterSeq?, cols, rows }
Pane.Detach { sessionId }
Pane.Kill { sessionId }
Pane.Input { sessionId, leaseEpoch, bytes }
Pane.Resize { sessionId, leaseEpoch, cols, rows }
Pane.CheckpointBegin/Chunk/End

Host.GetCwd
Host.ProcessTree
Host.GitStatus
Host.GitDiff
Host.PathIsFile
Host.ReadTextFile
```

`Workspace.ApplyOp` 使用 typed operations，例如 add/remove/reorder tab、split/remove
pane、rename 和 set icon；不接受客户端任意覆盖整份 JSON。agent 以
`baseRevision` 做 optimistic concurrency check，成功后 revision 加一并广播
`Workspace.Changed`。revision 冲突返回最新 snapshot，客户端重建 projection，不
静默 last-write-wins。

### 核心 event

```text
Workspace.Snapshot
Workspace.Changed
Workspace.Removed
Runtime.StatusChanged

Pane.ReplayBegin { sessionId, reset, baseSeq, headSeq }
Pane.CheckpointChunk
Pane.Output { sessionId, startSeq, bytes }
Pane.ReplayEnd { sessionId, nextSeq }
Pane.SizeChanged { sessionId, cols, rows }
Pane.Exited { sessionId, exitCode }
Pane.Lagged { sessionId, resumeFromSeq }

Control.Changed { workspaceId, controllerClientId?, leaseEpoch }
Host.ShuttingDown
```

## 输出、scrollback 与重连

只保存“当前屏幕文本”不足以恢复 vim/tmux/TUI，只无限重放原始 PTY bytes 又会让
attach 时间随 session 寿命无限增长。本设计复用现有 xterm SerializeAddon：

1. agent reader 为每个输出 chunk 分配连续 byte sequence：
   `[startSeq, endSeq)`。
2. 输出先落入 agent journal，再发给在线 subscriber。慢客户端不会阻塞 PTY reader。
3. controller 的 xterm 在确认已经 parse 到 `throughSeq` 后，每 15 秒、detach 和窗口
   关闭前上传 `serialize()` 结果作为 ANSI checkpoint。
4. agent 原子保存 checkpoint 后，可以删除 `endSeq <= throughSeq` 的旧 journal。
5. 新客户端 attach 时先收到 checkpoint，再收到 checkpoint 之后的 raw journal，
   最后切换到 live output。

attach 必须在 agent session lock 下确定 `headSeq` 并注册 subscriber，确保 replay
期间产生的新 output 不会落在空档中。`Pane.Attach` 携带客户端已经完整 parse 的
`afterSeq`：如果 agent 仍保存从该点开始的 journal，保留客户端现有 xterm，只增量
补齐；如果该点早于 GC 边界或客户端没有本地状态，则要求客户端 reset，并从最新
checkpoint 恢复：

```text
Pane.Attach
  -> ReplayBegin(reset, baseSeq, headSeq)
  -> [reset=true 时发送 checkpoint chunks]
  -> Output(baseSeq ... headSeq)
  -> ReplayEnd(nextSeq = headSeq)
  -> live Output(headSeq ...)
```

`reset=true` 时前端先清空 xterm，再写 checkpoint 和后续 journal；`reset=false` 时
`baseSeq` 必须等于客户端 `afterSeq`，不能重复写 checkpoint。客户端用于 attach 的
是最后一个 `term.write` callback 已确认的 `parsedSeq`，不是最后收到网络 frame 的
序号。

客户端维护 `nextSeq`：

- `startSeq == nextSeq`：写入 xterm 并推进；
- `startSeq < nextSeq`：丢弃已经处理的重复前缀；
- `startSeq > nextSeq`：发现 gap，停止输入并重新 `Pane.Attach(afterSeq=nextSeq)`。

checkpoint 只能由当前 controller 上传，并携带 `leaseEpoch`；agent 只接受
`throughSeq` 不大于当前 head、且大于旧 checkpoint 的快照。xterm 必须等
`term.write(..., callback)` 表明对应输出已 parse 后才能推进可 checkpoint 的 seq，
不能把“消息已收到”当成“快照已包含”。

MVP 在尚无 checkpoint 时从 seq 0 保存并重放完整 journal，以正确性优先。后续可以
按 chunk 压缩。不能从原始 ANSI 流中间任意截断，否则会丢失颜色、光标和 alternate
screen 状态；磁盘水位保护必须先触发一次有效 checkpoint，或明确把 session 标为
history truncated 并强制 TUI resize/redraw。

每个 subscriber 有有界 outbound queue。queue 满时丢弃该 subscriber 的 live
delivery 并发送 `Pane.Lagged`/断开 client；数据已经在 journal 中，重连后补齐。绝不
因为家庭网络慢而阻塞 B 上的 PTY reader 或子进程。

## Controller lease 与 resize

workspace controller lease 包含 `clientId`、`leaseEpoch` 和 heartbeat deadline。

- 第一个申请者取得 lease；
- controller 每 5 秒 heartbeat，15 秒无 heartbeat 自动释放；
- watcher 输入控件只读；
- Take Control 默认需要本地确认，`force=true` 后旧 controller 收到 revoked event；
- 每次 controller 变化都增加 `leaseEpoch`；延迟到达的旧 `Pane.Input` 和
  `Pane.Resize` 因 epoch 不匹配被拒绝，防止断线前缓存的按键写入新会话；
- 只有 controller 的当前可见 pane 可以改变 PTY cols/rows。agent 把 canonical
  cols/rows 通过 `Pane.SizeChanged` 广播给所有 watcher；所有 xterm 必须用这组字符
  尺寸解析相同输出，watcher 不能按自己的容器重新 `fit`，否则 wrapping 和 TUI
  光标位置会分叉。watcher 容器较小时使用裁剪/滚动，较大时留空白；
- controller detach 后 PTY 保持最后尺寸。新 controller attach/resize 时产生一次
  SIGWINCH，让 vim/tmux/TUI 完整重绘。

第一版 lease 以 workspace 为粒度，语义最清晰。未来若真实需求要求两人同时操作
不同 pane，再扩展为 pane lease，不在 MVP 混入。

## 连接生命周期与错误处理

HostConnection 状态：

```text
disconnected -> connecting -> handshaking -> online
                    |              |          |
                    +---- auth/error ----------+
online -> reconnecting -> online
online -> incompatible
```

- 网络错误：保留前端 xterm 和最后 `nextSeq`，按 1s、2s、5s、10s、30s 上限退避；
  重连后重新握手、订阅 workspace，并从每个 pane 的 `nextSeq` 补数据。
- 主机密钥变化、认证失败、agent missing、协议不兼容：停止盲目重试，展示 OpenSSH
  stderr 和修复动作。
- 客户端退出：尽力上传 checkpoint、释放 lease、detach；即使来不及发送，lease
  也会超时，PTY 不受影响。
- agent 正常升级/关闭：先发 `Host.ShuttingDown`。存在 live sessions 时默认拒绝自动
  重启升级，避免为了升级杀掉工作；允许用户显式 Drain/Restart。
- agent 异常崩溃：OS 子进程通常随 PTY master 关闭而退出。重启后 session 标为
  lost，展示最后 checkpoint，并提供 Restart shell / Resume agent，不伪装成仍存活。
- 执行主机重启：与 agent crash 同样处理；任意进程级透明恢复不在能力范围内。

## 远端能力路由

只把 PTY 变成 remote 还不够。当前多个功能隐含“路径和 pid 属于 GUI 所在机器”，
必须根据 `SessionRef.deviceId` 路由：

| 功能 | 执行位置 |
|---|---|
| PTY spawn/read/write/resize/kill | owner agent |
| cwd、process tree、agent session/env | owner agent |
| Git status/diff | owner agent |
| path exists、file read | owner agent，经 SSH 返回内容 |
| web URL 打开 | 当前客户端 |
| 远端非文本文件 OS open | MVP 禁用，不能误开客户端同名路径 |
| clipboard | 当前客户端 |
| xterm、font、theme、selection/search | 当前客户端 |
| AI HTTP provider/key | 当前客户端 |
| AI agent `run_command` | 通过目标 pane 写入 owner agent PTY |

`PaneAgent.env` 可能包含 token。远端 agent 在 B 上完成检测和 resume，只向 A 返回脱敏
的 kind/session/status，不把 env secret 写进 workspace document 或发送给 watcher。

文件链接必须把 token 和 B 的 cwd 交给 B 做 resolve/stat/read。不能在 A 调用现有
`path_is_file`，否则 `/home/user/project` 会被错误解释为 A 的路径。

## 安全边界

1. SSH 登录本身已经等价于该 OS 用户的 shell 权限；yterminal-agent 不试图构造比
   SSH 更细的跨主机账号系统，但仍限制 parser 和本机 socket 攻击面。
2. 不监听 TCP/UDP；Unix socket 和数据目录只允许 owner。
3. 保留 OpenSSH 默认 host-key verification；禁止自动接受变更后的主机密钥。
4. 不保存私钥、密码或 passphrase；不默认启用 `ForwardAgent`。
5. remote command 固定，所有 workspace/session/path 使用 CBOR 字段传输，不拼进
   shell command。
6. frame 有严格大小限制、协议版本检查和 enum validation；未知 session 必须返回
   typed error。
7. 日志只记录 host/session id、字节数、seq、耗时和错误，不记录用户输入、终端
   输出、checkpoint、环境变量或文件内容。
8. checkpoint 和 output journal 可能包含 secret，按用户私有数据存储，SQLite/目录
   权限设为 `0600/0700`，并提供按 workspace 删除。

## Agent 安装与版本

yterminal 安装包同时携带同平台的 `yterminal-agent`。第一次启用 Remote Workspaces
时执行用户级安装：

- binary：`~/.local/bin/yterminal-agent`；
- Linux：systemd user unit；
- macOS：LaunchAgent plist；
- data：遵循 XDG/macOS application support 目录；
- runtime socket：使用短、用户私有的 runtime 目录，避免 macOS Unix socket 路径
  长度限制。

因为 A 和 B 都安装 yterminal，MVP 要求先在 B 打开设置并执行“Enable Remote
Workspaces”，不从 A 静默上传可执行文件。后续可增加“Install/Upgrade Agent over
SSH”，其探测、校验和文件传输仍走 SSH/SFTP，并校验随 release 发布的签名。

agent 与 GUI 通过 protocol range/capabilities 兼容。更新 GUI 不能未经确认重启仍
持有 live PTY 的 agent。

## 现有数据迁移

现有 live PTY master 在 Tauri 进程内，无法安全转交给新 daemon。升级边界如下：

1. 首次运行新版本时，前端读取 `yterminal-workspaces` localStorage，把完整 workspace
   文档提交给本机 agent 的一次性 Import API；保留原 UUID。
2. agent 持久化后，前端把旧数据标记为 migrated，并保留一个只读备份版本用于失败
   回滚。
3. 迁移发生在应用重新启动时；旧版 Tauri 持有的进程本来已经退出。pane 按既有 cwd
   重新 spawn，可恢复的 Claude/Codex/OpenCode session 继续沿用当前 resume 逻辑。
4. 从这一版本开始，所有新 PTY 由 agent 创建。GUI localStorage 只保存 host profiles、
   本机 view state 和最后一次只读 cache，不再是 workspace 真源。
5. 不支持在旧版 GUI 仍运行时“无损接管”其 live panes。Linux `reptyr` 不跨 macOS，
   也不能作为可靠产品方案。

## 代码改造边界

### Rust

把当前 package 调整为共享 library + 两个 binary：

```text
src-tauri/src/lib.rs
src-tauri/src/main.rs                    # thin Tauri entry
src-tauri/src/bin/yterminal-agent.rs
src-tauri/src/agent/session_manager.rs
src-tauri/src/agent/workspace_repo.rs
src-tauri/src/agent/server.rs
src-tauri/src/protocol/{frame,message}.rs
src-tauri/src/host_connection.rs          # OpenSSH + local socket clients
```

`pty.rs` 中 portable-pty 的 reader/writer/session 逻辑移入 agent SessionManager。Tauri
不再直接拥有 `PtyState`，而是代理 local/remote agent request。阻塞 reader、writer、
child wait 仍遵守当前专用线程/`spawn_blocking` 约束，不能因 daemon 化退回 async worker
阻塞。

### TypeScript

```text
src/lib/host-transport.ts
src/lib/remote-pty.ts
src/stores/host-store.ts
src/stores/remote-workspace-store.ts
src/components/HostSection.tsx
src/components/ConnectionStatus.tsx
```

现有 `IPty.pid: number` 改为不暴露 OS pid 的 session endpoint。建议接口：

```ts
interface PtyEndpoint {
  ref: SessionRef;
  cols: number;
  rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
  kill(): Promise<void>;
  onData(cb: (chunk: { startSeq: number; data: Uint8Array }) => void): Disposable;
  onExit(cb: (event: { exitCode: number | null }) => void): Disposable;
}
```

`terminal-manager` 继续负责 xterm、DOM caching、WebGL、IME、clipboard、link 和 UI
行为，但不再默认 `getOrCreateSession` 等于 spawn local shell。它需要显式处理
connecting/replaying/attached/offline/exited 状态，并区分 xterm detach、transport
detach 和 remote kill。

## 分阶段实施

### Phase 1：协议和本机 daemon 基座

1. 建立 Rust library、protocol codec、agent binary 和 Unix socket server。
2. 把 `PtyState`/portable-pty 生命周期移动到 agent，Tauri 本机连接走相同协议。
3. 先保持现有前端 API 的薄兼容层，验证关闭/重开 GUI 后 shell 仍在。
4. 实现 session UUID、output seq/journal、attach/detach/kill。
5. 加入 checkpoint 上传和 replay，替代当前仅属于单个 GUI 的 scrollback DB 真源。

验收：本机启动 shell，完全退出 GUI，重新打开后 attach 到同一 pid/process/TUI，
scrollback 和输入都连续；显式关闭 pane 才结束进程。

### Phase 2：Workspace authority

1. agent SQLite 保存 WorkspaceDocument 和 revision。
2. 实现 typed workspace ops、subscription 和 localStorage 一次性迁移。
3. 拆分 shared document 与 client view state。
4. 本机 sidebar 完全由 agent snapshot/event 驱动。

验收：两个本机 client 连接同一 agent 时看到一致结构；revision conflict 不覆盖数据；
关闭 GUI 不丢 tab/split/runtime。

### Phase 3：SSH host 与远程 attach MVP

1. Settings 增加 SSH host profiles、Test Connection、在线状态。
2. HostConnectionManager 启动单条持久 OpenSSH channel并完成握手/重连。
3. Sidebar 按 device 分组列出 workspace。
4. 实现 workspace attach、lazy pane replay、输入、resize、controller lease。
5. 完成 macOS -> Linux、Linux -> macOS 双向验证。

验收：B GUI 关闭后，A 仍能看到 B 的全部 workspaces 并继续同一 vim/tmux/agent；
拔网线再恢复后输出无重复无缺口；watcher 不能误输入。

### Phase 4：远端功能补齐与运维

1. cwd/process/agent、Git、file viewer 全部按 owner host 路由。
2. 远端 agent 安装/升级检查、Drain/Restart UI。
3. journal 压缩、磁盘水位、cache/诊断和性能指标。
4. offline read-only snapshot 和更完整的故障恢复体验。

## 测试与验收

### Rust 自动测试

- frame 分包/粘包、非法长度、未知 type、协议协商；
- output seq 单调、attach replay 与 live output 之间无 race；
- 重复 chunk、gap、断线重连；
- slow subscriber 不阻塞 PTY reader；
- controller lease 取得、超时、force takeover、旧 epoch 输入拒绝；
- workspace revision conflict 和 typed op 原子性；
- checkpoint 接受条件、journal GC 边界；
- daemon socket 权限、未知 session、agent crash 后 lost 标记。

### TypeScript 自动测试

- host/workspace projection 应用 snapshot 和增量 event；
- `PtyEndpoint` local/remote 行为一致；
- nextSeq 去重、gap resync、replay state；
- shared document 与 client view state 不串写；
- remote path/Git/process 请求不会落到 local invoke；
- Detach 与 Terminate UI 不混淆。

### 端到端验证

1. macOS client -> Linux host、Linux client -> macOS host。
2. 普通 zsh、vim、tmux mouse mode、一个持续输出任务和 coding-agent TUI。
3. 中文 IME、粘贴、Ctrl control chars、modified Enter。
4. workspace 多 tab、多 split、后台 pane 大量输出。
5. GUI 正常退出、GUI crash、SSH process kill、网络断开/恢复、主机睡眠/唤醒。
6. 100ms RTT 下输入可用，慢 client 不影响 host command 执行。
7. `ProxyJump`、ssh-agent、known_hosts 首次失败和主机密钥变化。
8. watcher/Take Control/resize 竞争。

## 已锁定的设计决策

- 产品入口是 workspace attach，底层传输以 pane/session 为单位。
- 跨机器只走系统 OpenSSH 的单条长连接；无 TCP daemon、WebSocket、云 relay。
- B 的 agent 是 B workspace 的唯一真源；客户端不做双向 localStorage 文件同步。
- PTY 由独立 per-user agent 持有，而不是由 GUI 或 SSH bridge 持有。
- session 使用 UUID，不把远端 OS pid 暴露成通用句柄。
- 使用 length-prefixed CBOR 和 output byte sequence。
- 使用 xterm ANSI checkpoint + agent raw journal 恢复 scrollback/TUI。
- 第一版一个 workspace 一个 controller，其他连接只读。
- SSH host/profile/keys 全部复用 `~/.ssh/config` 和 OpenSSH，不自建凭据系统。
- 先完成本机 daemon 化，再接 SSH；否则 B GUI 退出时远端 attach 仍会失去 PTY，无法
  满足核心目标。
