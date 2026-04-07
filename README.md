# Photomosaic — Eagle 插件

将选中的图片转换为照片马赛克（Photomosaic），使用 Eagle 图库中的所有图片作为瓦片素材。

## 功能

- 选中一张或多张图片，一键生成照片马赛克
- 自动从 Eagle 图库索引所有可用图片作为瓦片
- 可调参数：输出宽度、精细度（每行瓦片数）、瓦片比例、多样性、色彩还原度
- 逐行渲染实时预览生成过程
- 生成后实时调节色彩还原度，无需重新生成
- 批量生成多张图片，生成过程中可自由切换查看
- 画布支持滚轮缩放和拖拽平移
- 一键保存到 Eagle 图库「马赛克图片」文件夹

## 使用方式

1. 在 Eagle 中选中一张或多张图片
2. 打开 Photomosaic 插件
3. 调整参数后点击「生成当前」或「全部生成」
4. 生成完成后点击「保存到 Eagle」

## 目录结构

```
Photomosaic/          ← Eagle 插件目录
├── manifest.json
├── index.html
├── logo.png
├── css/style.css
└── js/photomosaic.js
```

## 技术详解

详见 [development.md](development.md)。
