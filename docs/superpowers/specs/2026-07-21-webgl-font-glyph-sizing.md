# macOS WebGL 字体“忽大忽小”排查与修复

- 日期：2026-07-21
- 分支：`fix/webgl-cjk-glyph-sizing`
- 相关提交：`f504ca9`（中文主修复）
- 复现字体：本机安装的 Nerd/CJK 等宽字体（`Hack Nerd Font Mono`、`Maple Mono Normal NF CN`、`LXGW WenKai Mono` 等，均为 `~/Library/Fonts` 用户安装、非 `@font-face`）
- 环境：macOS WKWebView，DPR=2

## 背景

长期存在的问题：macOS 上终端文字尺寸忽大忽小，尤其 CJK。此前已修过多次（`073acc8` DPR 变化清 atlas、`91a5f38` 字体就绪后清 atlas、`723bc6a` 预加载 bold/italic 字面），且用户反馈“从某一次开始变得更糟”。工作区还压着一个未提交的 `terminal-manager.ts` 大改（异步 `applyAppearance` + 抽出 `terminal-font.ts`/`webgl-atlas.ts`）。

连续多个提交都在打同一类 bug（WebGL glyph corruption），且越修越糟——这是“修复方向错了”的信号。本次不再叠补丁，改为先加诊断、拿证据定根因。

## 诊断方法

在 `attachSession` 的各边界注入只读诊断探针（`terminal-font-diag.ts`，已随修复移除），把每个环节的数据打进日志（source `font`/`geom`），逐个证伪假设。所有探针纯只读，绝不改渲染状态。

关键探针与结论：

| 探针 | 数据 | 结论 |
|---|---|---|
| 字体就绪时间线（`open()`→`t+3000ms`） | 各时间点数值完全不变 | **证伪**异步字体加载竞态 |
| OffscreenCanvas vs 普通 canvas 量同一串 | `agree=1` 处处成立 | **证伪**测量器分裂（xterm 用 OffscreenCanvas 量、atlas 用普通 canvas 画） |
| 每字符推进宽度（10 个汉字） | `spread=0`，全 15px | **证伪**逐字回退致推进宽度不同 |
| 每字符视觉墨迹高度 | `hSpread=0.9`（正常字形差异） | **证伪**逐字回退致墨迹大小不同 |
| WebGL 开关 A/B（`yt.diag.disableWebgl`） | 关掉 WebGL → 完全正常 | **坐实**问题在 WebGL 渲染层，不在字体解析层 |
| Unicode 宽度表（直接读 xterm 源码 `UnicodeV6.wcwidth`） | 常见中文全部 width=2（正确）；`①②Ⅻ⏰✓★→` 等 width=1 | 中文本身宽度判定正确；歧义/符号字符在 V6/V11 不同 |
| 切 tab 复现（用户发现） | 新渲染的 tab 正常，切过去复发 | 指向 tab 重挂载 / 共享 atlas 路径 |
| 几何对比（`geom-diag`，切 tab 时） | `rdr-cell = atlas-cell = 18×34`，DPR 全 2，零漂移 | **证伪**几何/DPR/atlas 配置错位 |

## 根因（分两个独立问题）

排查中发现原以为的一个 bug 其实是**两个独立问题**，只是表现相似。

### 问题一：CJK 宽字形在 WebGL 固定网格下忽大忽小（已修复）

WebGL 渲染器把字形栅格化进共享 atlas 的固定单元格。本机这类 Nerd/CJK 字体 CJK:Latin ≈ **1.67:1**（Latin 来自 JetBrains Mono ≈0.6em，CJK 来自合并的中文字体 ≈1.0em），不是终端网格假设的 2:1。当某字形的自然推进超出其单元格时，WebGL 会**逐字形做包围盒裁剪**，逐个取整不一致 → 尺寸抖动。DOM 渲染器让字形自由流动，所以关掉 WebGL 即正常，也解释了为何 macOS 独有、为何选中“自愈”特征消失后仍不齐。

此前 4 次补丁都在赌 atlas 时序/字体加载，与真正的几何矛盾无关，所以越修越糟。

### 问题二：英文选中/非选中同一字母大小微变（已修复）

xterm 的 atlas 按 `(字符, 背景, 前景)` 缓存字形，选中单元格背景不同 → 是**独立的一次栅格化**。烘焙后由 `_findGlyphBoundingBox` 扫描非零 alpha 像素得出包围盒，而 `clearColor` 用“前景↔背景色差”算阈值清除抗锯齿边缘像素：

- 未选中：深色背景，色差大 → 阈值高 → 清得多 → 包围盒**紧**
- 选中：选区色（较浅），色差小 → 阈值低 → 清得少 → 包围盒**大**

包围盒差约 1 设备像素 → 同一字母选中/非选中视觉大小不同。这来自 xterm WebGL atlas 的背景相关烘焙方式（背景参与栅格化 + `clearColor` 阈值 + 逐字形包围盒），几何完全无关（`geom-diag` 已证明）。

VS Code 用同一份 atlas 代码，但：(1) 默认 `minimumContrastRatio: 4.5`，把前景重着色以保证对比，稳住了 `clearColor` 阈值；(2) 不像 yterminal 那样缓存并重新父接 xterm DOM 节点，所以从不触发“切 tab 复发”这一面。用同字体在 VS Code 集成终端里对比确认：VS Code 无此问题。

## 修复

### 已提交（`f504ca9`，解决问题一）

与参考实现 VS Code 对齐，WebGL 保持开启：

- `rescaleOverlappingGlyphs: true`（xterm 默认 `false`）：把推进超出单元格的单格字形缩回单元格宽度。
- `@xterm/addon-unicode11` + `term.unicode.activeVersion = "11"`：替代 xterm 默认的 Unicode 6 宽度表，让歧义/宽字符拿到正确单元格数。

效果：中文忽大忽小消失（截图 1–2 的原始报告问题）。

### 问题二：透明栅格化 + 背景无关 glyph cache

三种手段均 A/B 实测（探针后已清理）：

| 手段 | 结果 |
|---|---|
| `minimumContrastRatio: 4.5`（VS Code 默认，我们原用 xterm 默认 1） | **显著缓解**：新 tab 完美，切 tab 后仅剩少数字母微变 |
| 重挂载后 `clearAllTextureAtlases()`（`reclearAtlas`） | 仅部分遮盖；几何已证明处处相等，无几何可修，且有全量重烘性能代价 → 放弃 |
| 全局 `allowTransparency: true`（透明背景烘焙 + 纯 alpha 量包围盒） | 仍按背景生成不同 cache entry，同一字符还是会独立栅格化两次，新 tab 也无效 → 放弃 |

这些构造选项都只能缓解，无法保证选中前后使用同一张位图。`minimumContrastRatio: 4.5` 还会**重着色低对比度文本**（暗淡文字、彩底 ANSI 色），改变主题观感，因此最终删除该未提交改动，保留 xterm 默认值 1。

最终在 `src/lib/webgl-glyph-cache.ts` 增加 addon-webgl 0.19 兼容层，同时改变栅格化输入和 cache identity：

1. **透明临时画布。** 把 atlas 私有 `_tmpCanvas` 替换为启用 alpha 的 2D canvas；包装同步 `_drawToCache()`，仅在该次绘制期间临时令 atlas config 的 `allowTransparency=true`。背景不再烘焙进 glyph，抗锯齿覆盖率直接保存在 alpha 通道；终端窗口本身仍是不透明的，主题颜色不变。
2. **背景无关 cache key。** 包装普通/combined 两个 `FourKeyMap` 的 `get`/`set`。非反色 glyph 删除背景 key 中的 RGB/索引及 color-mode 位，但保留 dim、italic、extended underline 等样式位；反色 glyph 的背景会成为前景，仍保留完整背景 key。这样选中只改变 RectangleRenderer 画出的背景，前景字符直接复用未选中状态的**同一张 atlas 位图**，不再进行第二次 CoreText 栅格化。
3. **覆盖 atlas 生命周期。** `installWebglGlyphCacheStabilizer()` 监听 `onChangeTextureAtlas`；字体、主题、几何或 DPR 变化换出新 atlas 后，在赋值完成的 microtask 中重新安装兼容层，并通过既有 `clearAllTextureAtlases()` 同步清理所有共享 renderer model。WebGL context loss 和 pane dispose 都会解除监听。
4. **防御性降级。** 兼容层只认 addon-webgl 0.19 当前私有结构；字段缺失时返回 `false`，不做半套修改。升级 `@xterm/addon-webgl` 时必须重新核对 `_charAtlas`、`_tmpCanvas`、`_drawToCache` 和两个 cache map 的结构及行为。

为什么“只开透明”无效、组合方案有效：透明画布解决了**背景参与边缘裁剪**，背景无关 key 进一步消除了**同一 glyph 重复栅格化**。两者缺一时，选中/未选中仍可能得到两个不同的 atlas entry。

效果：同一英文字符选中前后大小一致；切换 tab、重挂载缓存的 xterm DOM 后不复发；中文宽字形修复无回归。2026-07-21 由用户在 macOS WKWebView、DPR=2、`Hack Nerd Font Mono` 下人工确认。

## 验证

- `npx tsc --noEmit` 通过。
- `npm test`：39 文件、346 用例全绿。
- `npm run build` 通过。
- 新增 `src/lib/webgl-glyph-cache.test.ts`，覆盖背景 key 归一化、反色保留、alpha canvas/同步 config 恢复，以及 atlas 更换/cleanup 生命周期。
- 所有诊断脚手架（`terminal-font-diag.ts`/`.test.ts`、`logGeomDiag`、`yt.diag.*` 开关）已移除。

## 已证伪的假设（存档，避免重走）

- 异步字体加载竞态（`document.fonts.ready` 对本地字体假阳性）——时间线稳定，证伪。
- OffscreenCanvas 与普通 canvas 测量分裂——`agree=1`，证伪。
- 逐字回退致推进宽度/墨迹大小不同——`spread=0`、`hSpread=0.9`，证伪。
- 切 tab 后渲染器几何 ≠ atlas 几何——`geom-diag` 处处 18×34、DPR 一致，证伪。
- 缺 `addon-unicode11` 导致中文宽度误判——直接读 V6 源码算出常见中文均 width=2，证伪（unicode11 仍作为与 VS Code 对齐的正确性改动保留，但不是中文修复的关键）。
