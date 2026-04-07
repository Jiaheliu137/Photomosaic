# Photomosaic 技术文档

## 整体架构

插件采用单页应用结构，无构建工具，7 个 JS 文件按依赖顺序通过 `<script>` 标签加载：

```
utils.js → color.js → cache.js → mosaic.js → viewer.js → ui.js → plugin.js
```

页面分为三个区域：

- **左侧栏**：选中图片缩略图列表，显示各图的处理状态（pending / processing / done / error）
- **参数面板**：左侧参数控件 + 右侧估算信息、操作按钮、进度条
- **画布预览区**：Canvas 元素 + 滚轮缩放/拖拽平移 viewer

窗口使用 Eagle 官方无框架规范（`frame: false, vibrancy: true`），自定义标题栏支持 6 种 Eagle 主题自动适配。

### 模块职责

| 文件 | 行数 | 职责 |
|------|------|------|
| `utils.js` | ~80 | 通用工具：loadImage、parseTileRatio、进度条、临时文件读写 |
| `color.js` | ~100 | RGB→Lab 转换、ΔE 距离、KD-Tree 构建与最近邻搜索 |
| `cache.js` | ~150 | 瓦片索引磁盘缓存、素材库 ID 同步、文件夹排除管理 |
| `mosaic.js` | ~350 | 两种瓦片数据库构建（palette/sampled）、逐行渲染、叠色合成 |
| `viewer.js` | ~100 | 缩放平移查看器、交互状态追踪 |
| `ui.js` | ~370 | 侧栏渲染、参数⇄设置同步、估算计算、弹窗 |
| `plugin.js` | ~720 | Eagle 生命周期、按钮事件、生成/保存流程、主题适配 |

模块间通过全局变量通信（与 MangaStream 插件相同的 no-build 模式）。

---

## 色彩科学

### RGB → CIELAB 转换

照片马赛克的核心问题是「用哪张图片替换目标图的某个区域」。直接比较 RGB 值不符合人眼感知——RGB 空间中欧氏距离相等的两对颜色，人眼看来可能差异很大。

CIELAB（CIE 1976 L\*a\*b\*）色彩空间是为感知均匀性设计的：

1. **RGB → XYZ**：通过 sRGB 线性化（gamma 校正逆变换）和 3x3 矩阵变换，转为 CIE XYZ 色彩空间
2. **XYZ → Lab**：以 D65 白点为参考，对 X/Y/Z 分别做立方根变换（低值段线性近似），得到 L\*（亮度 0-100）、a\*（绿-红轴）、b\*（蓝-黄轴）

### ΔE 距离

在 Lab 空间中，两色之间的欧氏距离 ΔE = √((L₁-L₂)² + (a₁-a₂)² + (b₁-b₂)²) 直接对应人眼感知差异：
- ΔE < 1：几乎无法察觉
- ΔE 1-2：需仔细观察
- ΔE 2-10：可察觉差异
- ΔE > 10：明显不同的颜色

---

## KD-Tree 空间索引

### 问题

图库可能有数千到数万张图片，每张瓦片位置都需要找到 Lab 颜色最接近的图片。暴力搜索 O(n) 对每个格子都扫描全部图库，乘以 gridCols × gridRows 个格子，计算量巨大。

### 解法

将所有图库图片的 Lab 平均色构建为 3D KD-Tree（K=3，对应 L/a/b 三个维度）。

**构建过程**：
- 将图库按当前维度的 Lab 值排序，取中位数作为分割点
- 左子树包含该维度值 < 中位数的图片，右子树包含 ≥ 中位数的
- 下一层切换到下一维度（L→a→b→L→...），递归至叶子

**查询过程（最近邻搜索）**：
- 沿着树向下搜索目标点应该落在的叶子
- 回溯时检查：如果目标点到分割平面的距离 < 当前最佳距离，另一侧子树可能有更近的点，也需要搜索
- 剪枝策略使平均复杂度从 O(n) 降到 O(log n)

### 多样性约束

搜索时传入 `excluded` 集合（附近已用过的图片 ID），跳过这些图片。查找的不是全局最近邻，而是排除约束后的最近邻。

---

## 逐行渲染管线

### 设计目标

用户点击生成后，应立即开始看到结果从第一行逐渐向下生成，而非「扫描半天 → 突然完成」。

### 管线结构

```
for each row:
    for each cell in row:
        1. match: KD-Tree 查找最佳瓦片 (CPU)
        2. load:  loadImage() 加载瓦片图片 (IO)
        3. render: drawImage() 绘制到 baseCanvas (CPU)
    
    4. onRowRendered 回调 → 复制该行到 outputCanvas + fidelity overlay
    5. yield: await setTimeout(0) → 让浏览器执行 IO 队列和画面渲染
```

### 关键设计决策

**逐行 yield 而非逐格 yield**：`setTimeout(0)` 每次调用有 ~4ms 调度开销。80列×60行=4800格，逐格 yield 会产生 4800×4ms = 19.2s 的纯调度开销。逐行 yield 只有 60×4ms = 0.24s，几乎可忽略。

**逐行 yield 而非一次性渲染**：虽然一次性渲染看起来没有 yield 开销，但浏览器的 `loadImage()` 是异步 IO。没有 yield 点，浏览器无法并行处理 IO 队列中的图片解码请求，实际上更慢。逐行 yield 让浏览器在 CPU 渲染当前行的同时，后台解码下一行需要的图片。

---

## 瓦片多样性约束

### 问题

纯粹按颜色匹配，相邻区域颜色相近时会选到同一张图片，造成大面积重复。

### usageGrid + Manhattan 距离排除

- `usageGrid[row][col]` 记录每个位置使用的图片 ID
- 对当前位置 (row, col)，计算 Manhattan 距离 ≤ repeatDistance 范围内的所有已用图片 ID，加入 excluded 集合
- KD-Tree 搜索时跳过 excluded 中的图片

`repeatDistance` 即「多样性」参数，值越大，排除范围越大，局部需要的不同图片越多。当图库太小不足以满足排除约束时，自动允许重复。

---

## 色彩还原度叠色

### 原理

纯瓦片马赛克远看会偏色（瓦片的平均色无法完美匹配目标色）。叠色在每个瓦片上覆盖一层半透明的目标颜色，提升远看时的色彩还原度。

### 实现

```
fidelityAlpha = settings.fidelity / 100  (0~0.5)

for each cell:
    ctx.fillStyle = rgba(targetR, targetG, targetB, fidelityAlpha)
    ctx.fillRect(cellX, cellY, tileW, tileH)
```

叠色在逐行渲染回调中 per-row 应用，避免渲染完成后的二次处理和色彩突变。生成完成后调节 fidelity 值，直接用 `compositeToOutput` 重新合成，无需重新生成。

---

## 内存管理与异步序列化

### 问题

批量生成多张图片时，每张图的 baseCanvas（可达 16000×12000px）不能全部驻留内存。

### 方案

生成完成后，将 baseCanvas 序列化为 temp PNG 写入磁盘（`temp/base_{itemId}_{timestamp}.png`），释放 Canvas 对象。查看时从磁盘加载回来。

### 异步写入

使用 `canvas.toBlob()` + `FileReader.readAsArrayBuffer()` + `fs.writeFile()` 异步管线代替同步的 `canvas.toDataURL()` + `fs.writeFileSync()`。避免大尺寸 Canvas 序列化阻塞主线程导致 UI 冻结（16000px 画布的同步序列化会阻塞 ~1 秒）。

插件退出时自动清理所有 temp 文件。

---

## 缩放平移查看器（Viewer）

### 交互状态追踪

查看器维护 `userInteracted` 标志位，追踪用户是否手动缩放或平移过：

- **wheel / drag**：设置 `userInteracted = true`
- **fitToContainer()**：强制适配容器并重置 `userInteracted = false`
- **softFit()**：仅在 `!userInteracted` 时执行 fitToContainer，否则只更新 `minScale`
- **resetInteraction()**：重置 `userInteracted = false`，下次 softFit 时执行 fit

### 视觉稳定性原则

所有操作（参数调整、生成开始/进行/完成、色彩还原度滑块、窗口 resize）调用 `softFit()` 而非 `fitToContainer()`，确保用户手动调整过的缩放/平移状态不被打断。

唯一触发 `resetInteraction()` 的场景：在侧栏切换到不同图片时。相同图片的点击不重置。

### minScale 动态更新

`softFit()` 每次调用都会重新计算 `minScale`（基于当前 canvas 尺寸和容器尺寸），确保切换不同输出宽度后缩放下限始终正确。

---

## 瓦片索引缓存

### 缓存策略

按「素材库名称 + 瓦片形状」为 key 缓存到磁盘：

```
插件目录/cache/{libraryName}/{shape}.json   (如 cache/我的素材库/1x1.json)
```

- 内存中使用 `tileIndexCache` Map 按 shape 键缓存 `{ tiles, kdRoot }`
- 首次构建时同时写入磁盘 JSON
- 后续启动时从磁盘加载，跳过完整构建
- 切换素材库时清除全部缓存

### 颜色匹配模式

- **palette 模式**：使用 Eagle 内置调色板颜色（`item.palettes`），无需加载图片，构建极快
- **sampled 模式**：实际加载每张缩略图提取平均色，更精确但首次构建慢

### 文件夹排除

用户可通过「重建索引」按钮触发文件夹选择弹窗，排除不想参与马赛克的文件夹。排除配置持久化到 `cache/{libraryName}/excluded_folders.json`。

---

## Per-Image 独立参数

每张图片有自己的 settings 对象（outputWidth, density, tileShape, diversity, fidelity）。切换图片时：
- `loadSettingsToUI()` 将该图参数同步到 UI 控件
- `saveUIToSettings()` 在参数变化时保存到当前图的 settings

批量生成时，每张图按自己的参数独立生成。

---

## 批量生成与自由切换

批量生成过程中，用户可以自由点击侧栏切换查看任意图片：

- `generatingIndex`：追踪当前正在生成的图片 index
- `activeIndex`：追踪用户正在查看的图片 index
- 视觉更新回调仅在 `activeIndex === generatingIndex` 时更新 outputCanvas
- 切换到 processing 状态的图片时，blit 当前 `liveBaseCanvas` 的渲染进度
- 切换到 done 状态的图片时，从 temp 文件加载并合成
- 切换到 pending 状态的图片时，显示像素化 placeholder

---

## Eagle API 集成

- `eagle.item.getSelected()`：获取用户选中的图片列表
- `eagle.item.getAll()`：获取图库所有图片，用于构建瓦片索引
- `eagle.item.addFromPath(filePath, options)`：将生成的马赛克图保存到 Eagle
- `eagle.folder.getAll()` / `eagle.folder.create()`：查找或创建「马赛克图片」文件夹
- `eagle.window.hide()` / `eagle.window.close()` / `eagle.window.setAlwaysOnTop()`：窗口控制
- `eagle.app.theme` / `eagle.onThemeChanged()`：主题适配
- `eagle.library.info()`：获取当前素材库信息用于缓存分区
