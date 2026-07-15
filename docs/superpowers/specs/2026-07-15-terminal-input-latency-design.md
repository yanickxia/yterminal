# Terminal 输入延迟优化设计

## 背景

yterminal 在普通 zsh、tmux、vim 和 coding-agent TUI 中都能正常输入，但按键回显比原生终端略慢。现有时间线曾把 `pty_spawn` 的前端耗时记录为 183ms；对齐 Rust 与前端日志后确认，Rust 在约 5ms 内已经创建 PTY，剩余时间来自 WebView 主线程的首帧工作。启动时的 `task queue exceeded allotted deadline` 警告由 xterm 内部 `TaskQueue` 发出，不代表 shell 本身启动缓慢。

热路径如下：

```text
DOM key event
  -> xterm onData
  -> Tauri invoke("pty_write")
  -> tokio spawn_blocking
  -> PTY writer.write_all
  -> shell/TUI echo
  -> parked invoke("pty_read") response
  -> xterm write/parse
  -> WebGL render
```

当前每次输入还会执行 TRACE 消息构造；每个 PTY 输出块会重建 activity idle timer，并在 xterm 解析后额外调用私有 `viewport.syncScrollArea()`。这些工作单项不大，但全部位于字符回显的关键路径。

## 目标

1. 降低普通交互输入的稳定延迟和抖动，不使用预测性本地回显。
2. 在 release 构建、Linux WebKitGTK、热启动终端中，使 `xterm onData -> first render` 的 p95 尽量稳定在一个 60Hz 帧预算（16.7ms）内。
3. 保持 shell、tmux/TUI、IME、粘贴、scrollback、tab re-parenting 和 PTY 生命周期语义不变。
4. 用低开销聚合指标证明各阶段变化，不用逐按键日志制造观察者开销。

## 非目标

- 不重写原生终端 renderer。
- 不在本阶段用 Tauri Channel 替换 `pty_read` 长轮询。
- 不做预测性本地回显或抑制 shell 回显；zle、密码输入和 TUI raw mode 下无法可靠保持一致。
- 不调整 15 秒 scrollback/cwd/agent 快照；它不在本次普通逐字输入的主路径内。

## 方案

### 1. 常驻 PTY writer 队列

每个 `Session` 在 `pty_spawn` 时创建一个有界 `tokio::sync::mpsc` 写队列和一条专用 writer OS 线程。writer 线程独占 `portable_pty` writer，循环 `blocking_recv()`，按入队顺序执行 `write_all()`。

`pty_write` 继续是 async Tauri command，但只完成 session 查找和 `Sender::send(data.into_bytes()).await`。这样不会在 async worker 上执行阻塞 syscall，也不再为每个按键创建 `spawn_blocking` job。队列有界，前端异常洪泛时通过 async send 自然背压，不无限增长内存。

writer 发生错误时退出并关闭 receiver；已排队数据的错误由后续 `send` 失败暴露。PTY kill/exit 删除 session 后 sender 被 drop，空闲 writer 线程自然退出；如果 writer 正阻塞在 OS write，child kill/PTY 关闭负责解除它。

### 2. 热路径日志降采样

移除逐按键、逐成功写入和逐 PTY read 的 TRACE 转发。保留：

- write RTT 超过既有 `SLOW_MS` 阈值时的 WARN；
- read 每 200 次一次的 heartbeat；
- spawn、resize、exit、error 等生命周期日志；
- 新增的延迟聚合摘要。

详细日志仍能定位慢操作，但开启 verbose 不再为每个字符触发 console 输出、Tauri `log_event` 和同步文件 flush。

### 3. Activity timer 单计时器化

`markActivity(paneId)` 只更新 `lastActivityAt`。每个 pane 同时最多存在一个 timer；timer 到期时比较最新时间，若尚未静默满 800ms，则按剩余时间重新调度，否则把 pane 标为 inactive。

这保持原有“最后一个输出块后 800ms 变为 idle”语义，同时消除持续输入/输出时每块一次 `clearTimeout + setTimeout`。

时间判断提取为纯函数，使用显式 `now` 和 `lastActivityAt`，便于单元测试边界值。

### 4. 输入延迟聚合器

新增纯 TypeScript 聚合器，记录固定容量样本的阶段耗时：

- `inputToOutput`: `term.onData` 到其后的第一个 PTY data chunk；
- `outputToParsed`: 该 chunk 到 `term.write` callback；
- `inputToRender`: `term.onData` 到该输入后第一次 `term.onRender`。

仅跟踪当前没有未完成样本时的单个输入，避免持续 TUI 输出造成错误配对。超时样本丢弃。聚合器只保存数字，不记录输入内容；达到固定样本数后计算 count、p50、p95、max，并通过 DEBUG 写一条摘要。

生产环境默认关闭 verbose 时，聚合器不创建样本。验证时打开 verbose 只产生聚合摘要，不产生逐字符日志，因此测量不会显著改变被测路径。

### 5. Viewport 同步验证

现有 `term.onWriteParsed(() => syncXtermViewport(s))` 使用 xterm 私有 API。xterm 自己会在 buffer/scroll 事件上同步滚动区；额外的逐解析调用可能重复工作。

先用延迟聚合器采集基线，再删除这个 listener，保留 attach、fit、wheel 和 scroll-state restore 中的显式同步。验证以下行为后才保留删除：

- 普通提示符输入时 viewport 保持在底部；
- 输出超过一屏时滚动条高度和位置更新；
- 向上查看 scrollback 时新输出不会把用户强制拉回底部；
- tab/workspace 切换和 cached DOM re-parent 后第一次滚轮不会跳顶；
- tmux/vim alternate screen 进入退出正常。

若任一回归出现，则恢复逐解析同步，本阶段仍交付 writer、日志和 timer 优化。

## 数据流与错误处理

```text
JS pty.write(data)
  -> invoke pty_write
  -> session.writer_tx.send(bytes).await
  -> dedicated writer thread
  -> writer.write_all(bytes)

reader thread
  -> bounded read channel (unchanged)
  -> parked pty_read command (unchanged)
  -> PTY data listeners
  -> activity stamp + latency output mark + xterm.write(callback)
  -> xterm parse mark
  -> xterm onRender mark + aggregate summary
```

- writer queue closed：`pty_write` 返回明确错误，前端沿现有 error logger 记录。
- writer syscall error：线程记录一次 ERROR 并退出，receiver drop 让后续写入失败。
- session dispose：删除 session、drop sender、kill child，writer 和 reader 最终退出。
- latency sample timeout：静默丢弃，不影响输入和渲染。
- WebGL context loss：沿用现有 DOM renderer fallback。

## 测试与验收

### 自动测试

- Rust writer loop：保持消息顺序；channel close 后退出；writer error 后退出。
- activity deadline 纯函数：静默已满、尚未满、边界 800ms。
- latency aggregator：阶段配对、超时丢弃、固定容量、p50/p95/max。
- 现有 `npm test`、`npm run build`、Rust `cargo test`、`cargo check` 全部通过。

### 运行时验证

在 Linux WebKitGTK 的 Tauri release/dev GUI 中分别验证：

1. 普通 zsh 提示符连续输入、退格、Ctrl 组合键。
2. `cat` 回显基准，采集至少 100 个样本的 p50/p95/max。
3. tmux、vim 和一个 coding-agent TUI。
4. 中文 IME、粘贴和 bracketed paste。
5. 大量输出与 scrollback 滚动。
6. tab/workspace 切换后继续输入和滚动。

验收以“功能无回归，热终端 `inputToRender` p95 尽量不超过 16.7ms，且相对修改前基线有可重复下降”为准。如果硬件/WebKit 帧调度使绝对阈值不可达，必须报告修改前后同环境样本，不以代码推断替代测量。

## 后续升级条件

只有在 writer 优化和 viewport 验证后，`inputToOutput` 仍占主要延迟，才进入下一阶段：评估用 Tauri binary Channel 替换 `pty_read` 长轮询并设计显式流控。该重构不与本阶段混合。

## 2026-07-15 实施结果

- `pty_write` 已改为有界队列入队，专用 writer OS 线程按序执行阻塞写入；不再为每个按键创建 `spawn_blocking` job。
- activity 状态改为每 pane 单计时器和滑动 deadline，持续输出只更新时间戳。
- 移除了逐输入、逐 read 和成功 write 的 TRACE 热路径日志，保留慢请求、错误及周期 heartbeat。
- 增加了无内容、纯耗时的输入延迟聚合器；verbose 模式每 100 个完整样本输出一次 p50/p95/max。
- 保留 `term.onWriteParsed -> syncXtermViewport`。本轮没有得到足以证明其可安全删除的 A/B 数据，保留比冒险破坏 scrollback/re-parent 滚动更稳妥。
- 用户在 Linux WebKitGTK GUI 中完成当前版本的交互自测并确认可用，随后要求停止进一步自动化 GUI/性能测试。
