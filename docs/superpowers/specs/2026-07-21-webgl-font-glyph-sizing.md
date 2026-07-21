# macOS WebGL 字体“忽大忽小”排查与修复

- 日期：2026-07-21
- 分支：`fix/webgl-cjk-glyph-sizing`、`fix/webgl-glyph-vertical-alignment`
- 相关提交：`f504ca9`（宽度分类）、`9dda54f`（选中态缓存）
- 复现字体：本机安装的 Nerd/CJK 等宽字体（`Hack Nerd Font Mono`、`Maple Mono Normal NF CN`、`LXGW WenKai Mono` 等，均为 `~/Library/Fonts` 用户安装、非 `@font-face`）
- 环境：macOS WKWebView，DPR=2

## 背景

长期存在的问题：macOS 上终端文字尺寸忽大忽小，尤其 CJK。此前已修过多次（`073acc8` DPR 变化清 atlas、`91a5f38` 字体就绪后清 atlas、`723bc6a` 预加载 bold/italic 字面），且用户反馈“从某一次开始变得更糟”。工作区还压着一个未提交的 `terminal-manager.ts` 大改（异步 `applyAppearance` + 抽出 `terminal-font.ts`/`webgl-atlas.ts`）。

连续多个提交都在打同一类 bug（WebGL glyph corruption），且越修越糟——这是“修复方向错了”的信号。本次不再叠补丁，改为先加诊断、拿证据定根因。

## 诊断方法

先在 `attachSession` 的各边界注入只读诊断探针，再把探针下沉到 addon-webgl 的 `_drawToCache`/`fillText` 边界，逐次记录真实 cache miss 的字体串、ink metrics、atlas size/offset 和属性 key。所有探针已随修复移除。

关键探针与结论：

| 探针 | 数据 | 结论 |
|---|---|---|
| 字体就绪时间线（`open()`→`t+3000ms`） | 各时间点数值完全不变 | **证伪**异步字体加载竞态 |
| OffscreenCanvas vs 普通 canvas 量同一串 | `agree=1` 处处成立 | **证伪**测量器分裂（xterm 用 OffscreenCanvas 量、atlas 用普通 canvas 画） |
| 每字符推进宽度（10 个汉字） | `spread=0`，全 15px | **证伪**逐字回退致推进宽度不同 |
| 每字符视觉墨迹高度 | `hSpread=0.9` | **证伪**逐字回退；后续确认该 outline spread 会在 atlas 中量化为 2 设备像素 |
| WebGL 开关 A/B（`yt.diag.disableWebgl`） | 关掉 WebGL → 完全正常 | **坐实**问题在 WebGL 渲染层，不在字体解析层 |
| Unicode 宽度表（直接读 xterm 源码 `UnicodeV6.wcwidth`） | 常见中文全部 width=2（正确）；`①②Ⅻ⏰✓★→` 等 width=1 | 中文本身宽度判定正确；歧义/符号字符在 V6/V11 不同 |
| 切 tab 复现（用户发现） | 新渲染的 tab 正常，切过去复发 | 指向 tab 重挂载 / 共享 atlas 路径 |
| 几何对比（`geom-diag`，切 tab 时） | `rdr-cell = atlas-cell = 18×34`，DPR 全 2，零漂移 | **证伪**几何/DPR/atlas 配置错位 |
| atlas cache miss（固定 ASCII） | 同为 `32px "Maple Mono Normal NF CN"`：detached 预热得到 `a/c/o` 高 17、offset.y=-12；挂入 terminal DOM 后得到高 20、offset.y=-7 | **坐实**同一 atlas 混入两套 CoreText 字形解析结果 |
| agent checkpoint 原始 ANSI | `command not found` 确为小写 ASCII，且前置 SGR 已 reset | **证伪**输出内容或粗体属性把 `o` 变成大写外观 |

## 根因（分四个独立问题）

排查中发现原以为的一个 bug 其实是**四个独立问题**，只是表现相似。

### 问题一：单 cell 非 ASCII 字形溢出（已修复）

WebGL 渲染器把字形栅格化进共享 atlas 的固定单元格。Unicode 宽度表仍把部分歧义符号判成单 cell，但字体给出的自然墨迹宽度会溢出该 cell，随后在 WebGL 路径逐字形裁剪。`rescaleOverlappingGlyphs` 正是为这类字符提供的修正。

需要纠正旧结论：xterm 的 `allowRescaling` 明确要求 `width === 1`，普通 Han 字符在 Unicode 6/11 下均为 width 2，**不会**进入该缩放路径。因此这项设置解决的是单 cell 非 ASCII/歧义字符，不是普通中文的纵向或双 cell 字形问题。

此前几次补丁只处理字体就绪、DPR 和 atlas 清理，没有约束每次 cache miss 时 `_tmpCanvas` 的 DOM 归属；对单 cell 溢出也不是同一类修复。

### 问题二：英文选中/非选中同一字母大小微变（已修复）

xterm 的 atlas 按 `(字符, 背景, 前景)` 缓存字形，选中单元格背景不同 → 是**独立的一次栅格化**。烘焙后由 `_findGlyphBoundingBox` 扫描非零 alpha 像素得出包围盒，而 `clearColor` 用“前景↔背景色差”算阈值清除抗锯齿边缘像素：

- 未选中：深色背景，色差大 → 阈值高 → 清得多 → 包围盒**紧**
- 选中：选区色（较浅），色差小 → 阈值低 → 清得少 → 包围盒**大**

包围盒差约 1 设备像素 → 同一字母选中/非选中视觉大小不同。这来自 xterm WebGL atlas 的背景相关烘焙方式（背景参与栅格化 + `clearColor` 阈值 + 逐字形包围盒），几何完全无关（`geom-diag` 已证明）。

VS Code 用同一份 atlas 代码，但：(1) 默认 `minimumContrastRatio: 4.5`，把前景重着色以保证对比，稳住了 `clearColor` 阈值；(2) 不像 yterminal 那样缓存并重新父接 xterm DOM 节点，所以从不触发“切 tab 复发”这一面。用同字体在 VS Code 集成终端里对比确认：VS Code 无此问题。

### 问题三：Han 字形纵向墨迹框相差两个设备像素（已修复）

`Maple Mono Normal NF CN` 的确是终端意义上的 2:1 等宽字体：本机字体数据中英文 advance 为 600，中文 advance 为 1200。但 advance 只约束横向前进距离，不约束每个字的纵向 outline extents。以截图标出的 `不涉及` 为例，字体原始 ink height 分别约为 852/921/862 units；15px、DPR=2 栅格化后，stock addon-webgl 得到：

| 字符 | atlas size | atlas offset |
|---|---:|---:|
| `不` / `及` / `面` | 28×27 | (-4, -7) |
| `涉` / `永` | 28×29 | (-4, -5) |
| `一` | 28×4 | (-4, -17) |

这不是 fallback、advance 失效或基线随机漂移，而是字体 outline 差异经 CoreText 栅格化和 atlas 紧包围盒后，量化成整整两个设备像素的 texture quad 高度与 y-offset 差。相邻全字面汉字因而明显“高高低低”。

### 问题四：共享临时 canvas 在 tab DOM 间移动（已修复）

addon-webgl 的 atlas 会异步预热 ASCII；预热时 `_tmpCanvas` 尚未进入 DOM。真实 cell 首次 miss 时，`_drawToCache(..., domContainer)` 又会把同一个共享 canvas 移入发起请求的 `terminal.element`，目的是继承 `font-feature-settings`。yterminal 缓存并重新父接 xterm DOM，后台 tab 的 element 还可能脱离 document，因此这个 canvas 会在 detached/connected、不同 tab 子树之间反复移动。

WKWebView 下，DOM 归属会影响本地字体的 CoreText 解析。诊断抓到同一个 atlas、同一个 `context.font`、同一个 16px/DPR=2 配置产生两组结果：

| 状态 | `a/c/o` ascent | atlas height | offset.y |
|---|---:|---:|---:|
| detached 预热 | 约 22.8 | 17 | -12 |
| 挂入 terminal DOM 的 live miss | 约 27.9 | 20 | -7 |

相差 3 个设备像素的高度和 5 个设备像素的定位会被永久写入同一 cache；之后即使 `context.font` 字符串看起来完全相同，也已经混入两代字形。这解释了为什么小写 `o` 看起来像大写 `O`、为什么英文和中文都可能忽大忽小，以及为什么切 tab 后容易复发。它不是 `document.fonts.ready` 的异步竞态，也不是 WebGL cell 几何漂移。

## 修复

### 已提交（`f504ca9`，解决问题一）

与参考实现 VS Code 对齐，WebGL 保持开启：

- `rescaleOverlappingGlyphs: true`（xterm 默认 `false`）：把推进超出单元格的单格字形缩回单元格宽度。
- `@xterm/addon-unicode11` + `term.unicode.activeVersion = "11"`：替代 xterm 默认的 Unicode 6 宽度表，让歧义/宽字符拿到正确单元格数。

效果：单 cell 非 ASCII/歧义字符不再横向溢出；现代宽度分类与 VS Code 一致。

### 问题二：透明栅格化 + 背景无关 glyph cache

三种手段均 A/B 实测（探针后已清理）：

| 手段 | 结果 |
|---|---|
| `minimumContrastRatio: 4.5`（VS Code 默认，我们原用 xterm 默认 1） | **显著缓解**：新 tab 完美，切 tab 后仅剩少数字母微变 |
| 重挂载后 `clearAllTextureAtlases()`（`reclearAtlas`） | 仅部分遮盖；几何已证明处处相等，无几何可修，且有全量重烘性能代价 → 放弃 |
| 全局 `allowTransparency: true`（透明背景烘焙 + 纯 alpha 量包围盒） | 仍按背景生成不同 cache entry，同一字符还是会独立栅格化两次，新 tab 也无效 → 放弃 |

这些构造选项都只能缓解，无法保证选中前后使用同一张位图。`minimumContrastRatio: 4.5` 还会**重着色低对比度文本**（暗淡文字、彩底 ANSI 色），改变主题观感，因此最终删除该未提交改动，保留 xterm 默认值 1。

最终在 `src/lib/webgl-glyph-atlas.ts` 集中 addon-webgl 0.19 兼容层，同时改变栅格化输入和 cache identity：

1. **透明临时画布。** 把 atlas 私有 `_tmpCanvas` 替换为启用 alpha 的 2D canvas；包装同步 `_drawToCache()`，仅在该次绘制期间临时令 atlas config 的 `allowTransparency=true`。背景不再烘焙进 glyph，抗锯齿覆盖率直接保存在 alpha 通道；终端窗口本身仍是不透明的，主题颜色不变。
2. **背景无关 cache key。** 包装普通/combined 两个 `FourKeyMap` 的 `get`/`set`。非反色 glyph 删除背景 key 中的 RGB/索引及 color-mode 位，但保留 dim、italic、extended underline 等样式位；反色 glyph 的背景会成为前景，仍保留完整背景 key。这样选中只改变 RectangleRenderer 画出的背景，前景字符直接复用未选中状态的**同一张 atlas 位图**，不再进行第二次 CoreText 栅格化。
3. **覆盖 atlas 生命周期。** `installWebglGlyphAtlas()` 监听 `onChangeTextureAtlas`；字体、主题、几何或 DPR 变化换出新 atlas 后，在赋值完成的 microtask 中重新安装兼容层，并通过既有 `clearAllTextureAtlases()` 同步清理所有共享 renderer model。WebGL context loss、pane dispose 和 remote unload 都会解除监听。
4. **防御性降级。** 兼容层只认 addon-webgl 0.19 当前私有结构；字段缺失时返回 `false`，不做半套修改。升级 `@xterm/addon-webgl` 时必须重新核对 `_charAtlas`、`_tmpCanvas`、`_drawToCache` 和两个 cache map 的结构及行为。

为什么“只开透明”无效、组合方案有效：透明画布解决了**背景参与边缘裁剪**，背景无关 key 进一步消除了**同一 glyph 重复栅格化**。两者缺一时，选中/未选中仍可能得到两个不同的 atlas entry。

效果：同一英文字符选中前后大小一致；切换 tab、重挂载缓存的 xterm DOM 后不复发；既有宽度分类无回归。2026-07-21 由用户在 macOS WKWebView、DPR=2、`Hack Nerd Font Mono` 下人工确认。

### 问题三：独立的 Han 纵向光学校正层

`src/lib/han-glyph-normalization.ts` 在 alpha atlas context 的 `fillText` 边界做校正，保持 xterm 的 cell width、Unicode width 与公共 baseline 不变：

1. 仅匹配单个 `Script=Han` codepoint；ASCII、标点、emoji、组合串不进入。
2. 用排版常用参考字 `永` 的 `actualBoundingBoxAscent/Descent` 作为当前 font/style 的目标 ink box；regular/bold/italic 分开缓存。
3. 只有当前 ink height 达参考高度 90% 的“全字面”字符才校正；`一/二`等有意较矮的字保持原样。
4. 只放大比参考字矮的 outline，纵向倍率最多 1.08，并把缩放后的 ink center 对齐参考 center；不改变横向 advance。
5. xterm 使用 `textBaseline="ideographic"`，此时浏览器返回的 `actualBoundingBoxDescent` 通常为负数，表示字形底部仍在 ideographic baseline 上方；它是合法的有符号坐标，不能按非负值校验。
6. 包装只在 atlas cache miss 的 `_drawToCache` 内触发；屏幕逐帧渲染没有额外测量成本。

真实浏览器中的 addon-webgl 0.19 atlas 验证：修复后 `不/涉/及/面/永` 全部为 28×29、offset (-4, -5)，`一`仍为 28×4、offset (-4, -17)。

### 问题四：固定 detached rasterization context

`webgl-glyph-atlas.ts` 仍接收 addon-webgl 的完整 `_drawToCache` 参数，但调用原实现时强制把第六个 `domContainer` 参数改为 `undefined`。替换出的 alpha `_tmpCanvas` 因此从创建到销毁始终脱离所有 tab DOM，ASCII 预热、普通输出、后台输出和 tab 重挂载都使用同一套 CoreText 解析结果。

这是有意放弃 addon-webgl 的“从 terminal DOM 继承 CSS `font-feature-settings`”路径。当前 yterminal 没有设置任何 terminal 级 `font-feature-settings`，所以没有功能损失；未来若增加该能力，必须设计稳定的单一 rasterization host 或显式 shaping 配置，不能恢复为把共享 canvas 移入请求 tab。

效果：英文与中文均使用稳定的同代 glyph metrics；冷启动恢复既有输出正常，切换到其他 tab 再返回也不复发。2026-07-21 由用户在 macOS WKWebView、DPR=2、`Maple Mono Normal NF CN` 下人工确认。

## 验证

- `npx tsc --noEmit` 通过。
- `npm test`：40 文件、359 用例全绿。
- `npm run build` 通过。
- 人工验证：冷启动恢复、普通输入输出、中文/英文混排及 tab 往返均正常。
- 新增 `src/lib/han-glyph-normalization.test.ts`，覆盖 Han 检测、有符号 ink metrics、90% 门槛、1.08 上限、短字排除和 canvas 包装缓存。
- `src/lib/webgl-glyph-atlas.test.ts` 覆盖背景 key 归一化、反色保留、detached alpha canvas、同步 config 恢复、Han reference metadata，以及 atlas 更换/cleanup 生命周期。
- 所有诊断脚手架（`terminal-font-diag.ts`/`.test.ts`、`logGeomDiag`、`glyph-diag`、`glyph-model-diag`、`yt.diag.*` 开关）已移除。

## 已证伪的假设（存档，避免重走）

- 异步字体加载竞态（`document.fonts.ready` 对本地字体假阳性）——时间线稳定，证伪。
- OffscreenCanvas 与普通 canvas 测量分裂——`agree=1`，证伪。
- 固定 canvas context 内按 codepoint 逐字 fallback——advance `spread=0`，证伪；但这不能外推到 atlas canvas 的 DOM 生命周期，后者确实会改变 WKWebView 的字体解析结果。
- 切 tab 后渲染器几何 ≠ atlas 几何——`geom-diag` 处处 18×34、DPR 一致，证伪。
- 缺 `addon-unicode11` 导致中文宽度误判——直接读 V6 源码算出常见中文均 width=2，证伪（unicode11 仍作为与 VS Code 对齐的正确性改动保留，但不是中文修复的关键）。
