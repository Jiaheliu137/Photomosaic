# Photomosaic 技术文档

## 整体架构

插件采用单页应用结构，分为三个区域：

- **左侧栏**：选中图片缩略图列表，显示各图的处理状态（pending / processing / done / error）
- **参数面板**：左侧参数控件 + 右侧估算信息、操作按钮、进度条
- **画布预览区**：Canvas 元素 + 滚轮缩放/拖拽平移 viewer

窗口使用 Eagle 官方无框架规范（`frame: false, vibrancy: true`），自定义标题栏支持 6 种 Eagle 主题自动适配。

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

## 内存管理

### 问题

批量生成多张图片时，每张图的 baseCanvas（可达 16000×12000px）不能全部驻留内存。

### 方案

生成完成后，将 baseCanvas 序列化为 temp PNG 写入磁盘（`temp/base_{itemId}_{timestamp}.png`），释放 Canvas 对象。查看时从磁盘加载回来。

写入操作使用 `setTimeout(300)` 延迟执行，避免 `canvas.toDataURL('image/png')` 阻塞主线程导致「最后一行渲染完还要等」的体验问题。

插件退出时自动清理所有 temp 文件。

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
