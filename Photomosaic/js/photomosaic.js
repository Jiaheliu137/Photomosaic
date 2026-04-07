const path = require('path');
const fs = require('fs');

const MAX_CANVAS_DIM = 16384; // Browser canvas hard limit

// ============================================================
// Color Science: RGB <-> Lab conversion for perceptual matching
// ============================================================

function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToXyz(r, g, b) {
    const lr = srgbToLinear(r);
    const lg = srgbToLinear(g);
    const lb = srgbToLinear(b);
    return [
        0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb,
        0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb,
        0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb
    ];
}

function xyzToLab(x, y, z) {
    const xn = 0.95047, yn = 1.00000, zn = 1.08883;
    const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const fx = f(x / xn);
    const fy = f(y / yn);
    const fz = f(z / zn);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function rgbToLab(r, g, b) {
    const [x, y, z] = rgbToXyz(r, g, b);
    return xyzToLab(x, y, z);
}

function deltaESq(lab1, lab2) {
    const dL = lab1[0] - lab2[0];
    const da = lab1[1] - lab2[1];
    const db = lab1[2] - lab2[2];
    return dL * dL + da * da + db * db;
}

// ============================================================
// KD-Tree for fast nearest-neighbor search in Lab space
// ============================================================

class KDNode {
    constructor(tileIdx, axis, left, right) {
        this.tileIdx = tileIdx;
        this.axis = axis;
        this.left = left;
        this.right = right;
    }
}

function buildKDTree(indices, tiles, depth) {
    if (indices.length === 0) return null;
    if (indices.length === 1) return new KDNode(indices[0], 0, null, null);

    const axis = depth % 3;
    indices.sort((a, b) => tiles[a].lab[axis] - tiles[b].lab[axis]);
    const mid = indices.length >> 1;

    return new KDNode(
        indices[mid],
        axis,
        buildKDTree(indices.slice(0, mid), tiles, depth + 1),
        buildKDTree(indices.slice(mid + 1), tiles, depth + 1)
    );
}

function kdSearch(node, target, tiles, excluded, best) {
    if (!node) return best;

    const tileLab = tiles[node.tileIdx].lab;
    const d = deltaESq(target, tileLab);

    if (!excluded.has(tiles[node.tileIdx].id) && d < best.dist) {
        best.dist = d;
        best.idx = node.tileIdx;
    }

    const axis = node.axis;
    const diff = target[axis] - tileLab[axis];
    const near = diff <= 0 ? node.left : node.right;
    const far = diff <= 0 ? node.right : node.left;

    best = kdSearch(near, target, tiles, excluded, best);

    // Only search far branch if it could contain a closer point
    if (diff * diff < best.dist) {
        best = kdSearch(far, target, tiles, excluded, best);
    }

    return best;
}

const EMPTY_SET = new Set();

function findBestTileKD(root, targetLab, tiles, excluded) {
    // First pass: try to find a match that respects diversity exclusion
    const result = kdSearch(root, targetLab, tiles, excluded, { dist: Infinity, idx: -1 });
    if (result.idx >= 0) return result.idx;

    // Fallback: all candidates were excluded — drop diversity constraint, allow repeats
    const fallback = kdSearch(root, targetLab, tiles, EMPTY_SET, { dist: Infinity, idx: -1 });
    return fallback.idx;
}

// ============================================================
// Image loading utility
// ============================================================

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load: ${src}`));
        img.src = src;
    });
}

// ============================================================
// Tile database: use Eagle's built-in palettes (no image loading)
// ============================================================

// Palette mode: use Eagle's pre-computed color palettes (fast, no I/O)
function buildTileDatabasePalette(items, onProgress) {
    const tiles = [];
    const imageExts = new Set(['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif']);

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!imageExts.has((item.ext || '').toLowerCase())) continue;

        const palettes = item.palettes;
        if (!palettes || palettes.length === 0) continue;

        const imgPath = item.thumbnailPath || item.filePath;
        if (!imgPath) continue;

        let r = 0, g = 0, b = 0, totalRatio = 0;
        for (const p of palettes) {
            const ratio = p.ratio || 0;
            r += p.color[0] * ratio;
            g += p.color[1] * ratio;
            b += p.color[2] * ratio;
            totalRatio += ratio;
        }
        if (totalRatio === 0) continue;

        r = Math.round(r / totalRatio);
        g = Math.round(g / totalRatio);
        b = Math.round(b / totalRatio);

        tiles.push({
            id: item.id,
            imgPath: 'file:///' + imgPath.replace(/\\/g, '/'),
            rgb: [r, g, b],
            lab: rgbToLab(r, g, b)
        });

        if (i % 500 === 0 && onProgress) {
            onProgress(i, items.length, `读取调色板: ${i}/${items.length}`);
        }
    }

    if (onProgress) {
        onProgress(items.length, items.length, `调色板索引完成: ${tiles.length} 张有效瓦片`);
    }
    return tiles;
}

// Sampled mode: load thumbnails, center-crop to tileAspect, sample average color (accurate)
async function buildTileDatabaseSampled(items, tileAspect, onProgress, shouldCancel) {
    const candidates = [];
    const imageExts = new Set(['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif']);

    for (const item of items) {
        if (!imageExts.has((item.ext || '').toLowerCase())) continue;
        const imgPath = item.thumbnailPath || item.filePath;
        if (!imgPath) continue;
        candidates.push({ id: item.id, imgPath: 'file:///' + imgPath.replace(/\\/g, '/') });
    }

    const sampleCanvas = document.createElement('canvas');
    const sampleCtx = sampleCanvas.getContext('2d');
    const tiles = [];

    for (let i = 0; i < candidates.length; i++) {
        if (shouldCancel && shouldCancel()) {
            throw new Error('CANCELLED');
        }
        if (i % 100 === 0 && onProgress) {
            onProgress(i, candidates.length, `采样缩略图: ${i}/${candidates.length}`);
            await new Promise(r => setTimeout(r, 0));
        }

        let img;
        try { img = await loadImage(candidates[i].imgPath); } catch { continue; }

        const imgAspect = img.width / img.height;
        let sx, sy, sw, sh;
        if (imgAspect > tileAspect) {
            sh = img.height; sw = Math.round(sh * tileAspect);
            sx = Math.round((img.width - sw) / 2); sy = 0;
        } else {
            sw = img.width; sh = Math.round(sw / tileAspect);
            sx = 0; sy = Math.round((img.height - sh) / 2);
        }

        sampleCanvas.width = sw;
        sampleCanvas.height = sh;
        sampleCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        const data = sampleCtx.getImageData(0, 0, sw, sh).data;

        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        const stride = Math.max(1, Math.floor(data.length / 4 / 2000)) * 4;
        for (let j = 0; j < data.length; j += stride) {
            rSum += data[j]; gSum += data[j + 1]; bSum += data[j + 2];
            count++;
        }

        const avgR = Math.round(rSum / count);
        const avgG = Math.round(gSum / count);
        const avgB = Math.round(bSum / count);

        tiles.push({
            id: candidates[i].id,
            imgPath: candidates[i].imgPath,
            rgb: [avgR, avgG, avgB],
            lab: rgbToLab(avgR, avgG, avgB)
        });
    }

    if (onProgress) {
        onProgress(candidates.length, candidates.length, `索引完成: ${tiles.length} 张有效瓦片`);
    }
    return tiles;
}

// ============================================================
// Main generation pipeline (accepts external kdRoot)
// ============================================================

async function generateMosaic(targetImg, tiles, kdRoot, gridCols, tileW, tileH, repeatDistance, onProgress, onVisualUpdate, shouldCancel) {
    const tileRatio = tileH / tileW;
    const aspect = targetImg.height / targetImg.width;
    const gridRows = Math.max(1, Math.round((gridCols * aspect) / tileRatio));

    let finalTileW = tileW;
    let finalTileH = tileH;
    while (gridCols * finalTileW > MAX_CANVAS_DIM || gridRows * finalTileH > MAX_CANVAS_DIM) {
        finalTileW = Math.max(1, finalTileW - 1);
        finalTileH = Math.max(1, Math.round(finalTileW * tileRatio));
    }
    if (finalTileW !== tileW) {
        onProgress(0, 1, `瓦片尺寸自动调整: ${tileW}x${tileH} → ${finalTileW}x${finalTileH}`);
        await new Promise(r => setTimeout(r, 500));
    }

    const outputWidth = gridCols * finalTileW;
    const outputHeight = gridRows * finalTileH;
    const totalCells = gridRows * gridCols;

    onProgress(0, 1, `网格 ${gridCols}x${gridRows} = ${totalCells} 格, 输出 ${outputWidth}x${outputHeight}px`);
    await new Promise(r => setTimeout(r, 200));

    // Step 1: Sample target image grid cells
    const sampleCanvas = document.createElement('canvas');
    const sampleCtx = sampleCanvas.getContext('2d');
    sampleCanvas.width = targetImg.width;
    sampleCanvas.height = targetImg.height;
    sampleCtx.drawImage(targetImg, 0, 0);

    const cellW = targetImg.width / gridCols;
    const cellH = targetImg.height / gridRows;
    const gridLabs = new Array(totalCells);
    const gridRgbs = new Array(totalCells);

    const imgData = sampleCtx.getImageData(0, 0, targetImg.width, targetImg.height).data;
    const imgW = targetImg.width;

    for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
            const x0 = Math.floor(col * cellW);
            const y0 = Math.floor(row * cellH);
            const x1 = Math.min(Math.ceil((col + 1) * cellW), imgW);
            const y1 = Math.min(Math.ceil((row + 1) * cellH), targetImg.height);

            let r = 0, g = 0, b = 0, count = 0;
            for (let py = y0; py < y1; py++) {
                const rowOffset = py * imgW;
                for (let px = x0; px < x1; px++) {
                    const i = (rowOffset + px) * 4;
                    r += imgData[i];
                    g += imgData[i + 1];
                    b += imgData[i + 2];
                    count++;
                }
            }
            if (count === 0) count = 1;
            const idx = row * gridCols + col;
            const rgb = [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
            gridRgbs[idx] = rgb;
            gridLabs[idx] = rgbToLab(rgb[0], rgb[1], rgb[2]);
        }
    }

    // Visual update: show pixelated placeholder
    if (onVisualUpdate && onVisualUpdate.onPlaceholderReady) {
        onVisualUpdate.onPlaceholderReady(gridRgbs, gridCols, gridRows, finalTileW, finalTileH);
        await new Promise(r => setTimeout(r, 50));
    }

    // Step 2: Match + load + render
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = outputWidth;
    baseCanvas.height = outputHeight;
    const baseCtx = baseCanvas.getContext('2d');

    const matchIndices = new Int32Array(totalCells);
    matchIndices.fill(-1);
    const usageGrid = new Array(gridRows);
    for (let r = 0; r < gridRows; r++) usageGrid[r] = new Array(gridCols).fill(null);

    const tileImages = new Map();
    const tileAspect = finalTileW / finalTileH;

    let cellsDone = 0;

    for (let row = 0; row < gridRows; row++) {
        if (shouldCancel && shouldCancel()) {
            throw new Error('CANCELLED');
        }
        for (let col = 0; col < gridCols; col++) {
            const idx = row * gridCols + col;

            const excluded = new Set();
            if (repeatDistance > 0) {
                const rMin = Math.max(0, row - repeatDistance);
                const rMax = Math.min(gridRows - 1, row + repeatDistance);
                const cMin = Math.max(0, col - repeatDistance);
                const cMax = Math.min(gridCols - 1, col + repeatDistance);
                for (let rr = rMin; rr <= rMax; rr++) {
                    for (let cc = cMin; cc <= cMax; cc++) {
                        if (rr === row && cc === col) continue;
                        const dist = Math.abs(row - rr) + Math.abs(col - cc);
                        if (dist <= repeatDistance && usageGrid[rr][cc] !== null) {
                            excluded.add(usageGrid[rr][cc]);
                        }
                    }
                }
            }
            const bestIdx = findBestTileKD(kdRoot, gridLabs[idx], tiles, excluded);
            matchIndices[idx] = bestIdx;
            if (bestIdx >= 0) usageGrid[row][col] = tiles[bestIdx].id;

            if (bestIdx >= 0 && !tileImages.has(bestIdx)) {
                try { tileImages.set(bestIdx, await loadImage(tiles[bestIdx].imgPath)); } catch {}
            }

            const dx = col * finalTileW;
            const dy = row * finalTileH;
            if (bestIdx >= 0 && tileImages.has(bestIdx)) {
                const img = tileImages.get(bestIdx);
                const imgAspect = img.width / img.height;
                let sx, sy, sw, sh;
                if (imgAspect > tileAspect) {
                    sh = img.height; sw = sh * tileAspect; sx = (img.width - sw) / 2; sy = 0;
                } else {
                    sw = img.width; sh = sw / tileAspect; sx = 0; sy = (img.height - sh) / 2;
                }
                baseCtx.drawImage(img, sx, sy, sw, sh, dx, dy, finalTileW, finalTileH);
            } else {
                const rgb = gridRgbs[idx];
                baseCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                baseCtx.fillRect(dx, dy, finalTileW, finalTileH);
            }

            cellsDone++;
        }

        if (onVisualUpdate && onVisualUpdate.onRowRendered) {
            onVisualUpdate.onRowRendered(baseCanvas, row, gridCols, finalTileW, finalTileH);
        }
        onProgress(cellsDone, totalCells, `渲染: 行 ${row + 1}/${gridRows}`);
        await new Promise(r => setTimeout(r, 0));
    }

    onProgress(gridRows, gridRows, '完成');
    return { width: outputWidth, height: outputHeight, gridCols, gridRows, tileW: finalTileW, tileH: finalTileH, baseCanvas, gridRgbs };
}

// ============================================================
// Composite: apply color overlay → output canvas
// Accepts Canvas or Image as baseSource (ctx.drawImage handles both)
// ============================================================

function compositeToOutput(baseSource, meta, blendAlpha) {
    const outputCanvas = document.getElementById('outputCanvas');
    outputCanvas.width = meta.width;
    outputCanvas.height = meta.height;
    const ctx = outputCanvas.getContext('2d');
    ctx.drawImage(baseSource, 0, 0);

    if (blendAlpha > 0) {
        for (let row = 0; row < meta.gridRows; row++) {
            for (let col = 0; col < meta.gridCols; col++) {
                const idx = row * meta.gridCols + col;
                const rgb = meta.gridRgbs[idx];
                ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${blendAlpha})`;
                ctx.fillRect(col * meta.tileW, row * meta.tileH, meta.tileW, meta.tileH);
            }
        }
    }
}

// ============================================================
// Temp file management for batch memory control
// ============================================================

function ensureTempDir(pluginPath) {
    const tempDir = path.join(pluginPath, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

function saveCanvasToTemp(canvas, itemId, pluginPath) {
    const tempDir = ensureTempDir(pluginPath);
    const filePath = path.join(tempDir, `base_${itemId}_${Date.now()}.png`);
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return filePath;
}

function cleanupTempFiles(queue, pluginPath) {
    for (const item of queue) {
        if (item.tempBasePath) {
            try { fs.unlinkSync(item.tempBasePath); } catch {}
            item.tempBasePath = null;
        }
    }
}

// ============================================================
// Pan & Zoom viewer
// ============================================================

function initViewer() {
    const container = document.getElementById('preview');
    const canvas = document.getElementById('outputCanvas');
    const PADDING = 20;

    let scale = 1, minScale = 0.1, panX = 0, panY = 0;
    let isPanning = false, startX, startY, startPanX, startPanY;

    function fitToContainer() {
        if (!canvas.width || !canvas.height) return;
        const cw = container.clientWidth - PADDING * 2;
        const ch = container.clientHeight - PADDING * 2;
        if (cw <= 0 || ch <= 0) return;
        const scaleW = cw / canvas.width;
        const scaleH = ch / canvas.height;
        scale = Math.min(scaleW, scaleH);
        minScale = scale * 0.5;
        const displayW = canvas.width * scale;
        const displayH = canvas.height * scale;
        panX = (container.clientWidth - displayW) / 2;
        panY = (container.clientHeight - displayH) / 2;
        applyTransform();
    }

    function applyTransform() {
        canvas.style.transformOrigin = '0 0';
        canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    container.addEventListener('wheel', (e) => {
        if (!canvas.width) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const prevScale = scale;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        scale = Math.max(minScale, Math.min(scale * factor, 20));
        panX = mouseX - (mouseX - panX) * (scale / prevScale);
        panY = mouseY - (mouseY - panY) * (scale / prevScale);
        applyTransform();
    }, { passive: false });

    container.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isPanning = true;
        startX = e.clientX; startY = e.clientY;
        startPanX = panX; startPanY = panY;
        container.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        panX = startPanX + (e.clientX - startX);
        panY = startPanY + (e.clientY - startY);
        applyTransform();
    });

    window.addEventListener('mouseup', () => {
        isPanning = false;
        container.style.cursor = 'grab';
    });

    container.style.cursor = 'grab';

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(fitToContainer, 60);
    });

    return { fitToContainer };
}

// ============================================================
// Plugin state
// ============================================================

let targetImgAspect = 1.33;
let libraryTileCount = 0;
let viewer = null;

// Queue
let batchQueue = [];
let activeIndex = 0;
let isBatchRunning = false;
let isBatchCancelled = false;
let generatingIndex = -1;
let liveBaseCanvas = null;

// Folder & save tracking
let mosaicFolderId = null;
let pluginPath = null;
let currentLibraryName = null; // readable library name for cache folder
let currentLibraryId = null;   // hash for internal comparison

// Caches
let cachedBase = null;
let cachedBaseIndex = -1;
let cachedTargetImg = null;
let cachedTargetIndex = -1;
// Per-aspect tile index cache: Map<aspectKey, {tiles, kdRoot}>
const tileIndexCache = new Map();
let cachedTiles = null;
let cachedKdRoot = null;

function getDefaultSettings() {
    return { outputWidth: 4000, density: 80, tileShape: '1:1', diversity: 3, fidelity: 20 };
}

async function ensureMosaicFolder() {
    if (mosaicFolderId) return mosaicFolderId;
    const folders = await eagle.folder.getAll();
    const existing = folders.find(f => f.name === '马赛克图片');
    if (existing) {
        mosaicFolderId = existing.id;
    } else {
        const newFolder = await eagle.folder.create({ name: '马赛克图片', description: 'Photomosaic 插件生成的图片' });
        mosaicFolderId = newFolder.id;
    }
    return mosaicFolderId;
}

function setProgress(current, total, text) {
    const el = document.getElementById('progress');
    const fill = document.getElementById('progressFill');
    const textEl = document.getElementById('progressText');
    el.style.display = 'block';
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    fill.style.width = pct + '%';
    textEl.textContent = text || `${pct}%`;
}

function parseTileRatio(shapeStr) {
    const [w, h] = shapeStr.split(':').map(Number);
    return { w, h, ratio: h / w };
}

// ============================================================
// Per-image settings <-> UI sync
// ============================================================

function loadSettingsToUI(settings) {
    document.getElementById('outputWidth').value = settings.outputWidth;
    document.getElementById('density').value = settings.density;
    document.getElementById('densityValue').textContent = settings.density;
    document.getElementById('tileShape').value = settings.tileShape;
    document.getElementById('diversity').value = settings.diversity;
    document.getElementById('diversityValue').textContent = settings.diversity;
    document.getElementById('colorFidelity').value = settings.fidelity;
    document.getElementById('colorFidelityValue').textContent = settings.fidelity;
}

function saveUIToSettings() {
    if (activeIndex < 0 || !batchQueue[activeIndex]) return;
    const s = batchQueue[activeIndex].settings;
    s.outputWidth = parseInt(document.getElementById('outputWidth').value);
    s.density = parseInt(document.getElementById('density').value);
    s.tileShape = document.getElementById('tileShape').value;
    s.diversity = parseInt(document.getElementById('diversity').value);
    s.fidelity = parseInt(document.getElementById('colorFidelity').value);
}

function getSettingsForItem(index) {
    const s = batchQueue[index].settings;
    const outW = s.outputWidth;
    const gridCols = s.density;
    const shape = parseTileRatio(s.tileShape);
    return {
        outW, gridCols,
        tileW: Math.max(1, Math.floor(outW / gridCols)),
        tileH: Math.max(1, Math.round(Math.max(1, Math.floor(outW / gridCols)) * shape.ratio)),
        repeatDistance: s.diversity,
        fidelity: s.fidelity
    };
}

// ============================================================
// Estimate panel
// ============================================================

function getCacheStatusLine(shapeStr) {
    const mode = getIndexMode();
    if (mode === 'palette') {
        return '<span style="color:var(--text-muted)">颜色匹配：粗略模式，使用 Eagle 内置颜色数据，速度快但精度有限</span>';
    }
    const libName = currentLibraryName || '未知';
    let exists = false;
    try { exists = hasDiskCache(shapeStr); } catch {}
    if (exists) {
        return `<span style="color:var(--text-muted)">颜色匹配：精确模式，逐张采样裁剪区域平均色</span> · <span style="color:var(--success)">&#10003; 素材库「${libName}」瓦片 ${shapeStr} 索引已就绪</span>`;
    }
    return `<span style="color:var(--text-muted)">颜色匹配：精确模式，逐张采样裁剪区域平均色</span> · <span style="color:var(--accent)">&#9679; 素材库「${libName}」瓦片 ${shapeStr} 尚无索引，首次生成时自动构建</span>`;
}

function updateEstimate() {
    const outW = parseInt(document.getElementById('outputWidth').value);
    const gridCols = parseInt(document.getElementById('density').value);
    const shape = parseTileRatio(document.getElementById('tileShape').value);
    const fidelity = parseInt(document.getElementById('colorFidelity').value);
    const diversity = parseInt(document.getElementById('diversity').value);

    const tileW = Math.max(1, Math.floor(outW / gridCols));
    const tileH = Math.max(1, Math.round(tileW * shape.ratio));
    const gridRows = Math.max(1, Math.round((gridCols * targetImgAspect) / shape.ratio));

    const actualW = gridCols * tileW;
    const actualH = gridRows * tileH;
    const totalTiles = gridCols * gridRows;
    const megapixels = (actualW * actualH / 1e6).toFixed(1);

    const lines = [];
    lines.push(
        `<b>${gridCols}</b> 列 x <b>${gridRows}</b> 行 = 共 <b>${totalTiles.toLocaleString()}</b> 张小图，` +
        `每张 <b>${tileW}x${tileH}</b>px（${shape.w}:${shape.h}），` +
        `输出 <b>${actualW}x${actualH}</b>px（${megapixels}MP）`
    );

    if (gridCols <= 40) lines.push('精细度较低：远看能辨认原图轮廓，近看每张小图很大很清晰');
    else if (gridCols <= 100) lines.push('精细度适中：远看接近原图，近看小图仍能辨认内容');
    else if (gridCols <= 200) lines.push('精细度较高：远看几乎等同原图，近看小图较小但仍可辨');
    else lines.push('精细度极高：远看与原图无异，近看需要放大才能看清小图');

    if (fidelity === 0) lines.push('色彩还原度 0%：完全不叠色，小图保持原样，远看可能偏色');
    else if (fidelity <= 15) lines.push(`色彩还原度 ${fidelity}%：轻微叠色，小图几乎原样，远看略有色差`);
    else if (fidelity <= 30) lines.push(`色彩还原度 ${fidelity}%：适度叠色，远看色彩准确，近看小图略带色罩`);
    else lines.push(`色彩还原度 ${fidelity}%：强叠色，远看非常像原图，近看小图内容被压淡`);

    const regionSize = (2 * diversity + 1) * (2 * diversity + 1);
    if (diversity === 0) lines.push('多样性关闭：允许相邻位置使用同一张图，可能出现大片重复');
    else if (diversity <= 3) lines.push(`多样性 ${diversity}：相邻 ${diversity} 格内不重复，局部约需 ${regionSize} 张不同图`);
    else if (diversity <= 6) lines.push(`多样性 ${diversity}：相邻 ${diversity} 格内不重复，局部约需 ${regionSize} 张不同图`);
    else lines.push(`多样性 ${diversity}：强制高度多样化，局部约需 ${regionSize} 张不同图`);

    if (diversity > 0 && libraryTileCount > 0) {
        if (libraryTileCount < regionSize) {
            lines.push(`<span style="color:#e94560">&#9888; 图库仅 ${libraryTileCount} 张有效图片，不足 ${regionSize} 张，部分区域会自动允许重复</span>`);
        } else if (libraryTileCount < regionSize * 3) {
            lines.push(`<span style="color:#f0ad4e">&#9888; 图库 ${libraryTileCount} 张，颜色选择空间有限</span>`);
        }
    }

    lines.push(getCacheStatusLine(document.getElementById('tileShape').value));

    document.getElementById('estimate').innerHTML = lines.map(l => `<div class="estimate-line">${l}</div>`).join('');
}

// ============================================================
// U5: Done image parameter summary
// ============================================================

function showDoneEstimate(item) {
    const el = document.getElementById('estimate');
    const s = item.settings;
    const shape = parseTileRatio(s.tileShape);
    const totalTiles = item.gridCols * item.gridRows;
    const megapixels = (item.width * item.height / 1e6).toFixed(1);
    const fidelity = s.fidelity;
    const diversity = s.diversity;

    const lines = [];
    lines.push(
        `<b>${item.gridCols}</b> 列 x <b>${item.gridRows}</b> 行 = 共 <b>${totalTiles.toLocaleString()}</b> 张小图，` +
        `每张 <b>${item.tileW}x${item.tileH}</b>px（${shape.w}:${shape.h}），` +
        `输出 <b>${item.width}x${item.height}</b>px（${megapixels}MP）`
    );

    if (item.gridCols <= 40) lines.push('精细度较低：远看能辨认原图轮廓，近看每张小图很大很清晰');
    else if (item.gridCols <= 100) lines.push('精细度适中：远看接近原图，近看小图仍能辨认内容');
    else if (item.gridCols <= 200) lines.push('精细度较高：远看几乎等同原图，近看小图较小但仍可辨');
    else lines.push('精细度极高：远看与原图无异，近看需要放大才能看清小图');

    if (fidelity === 0) lines.push('色彩还原度 0%：完全不叠色，小图保持原样，远看可能偏色');
    else if (fidelity <= 15) lines.push(`色彩还原度 ${fidelity}%：轻微叠色，小图几乎原样，远看略有色差`);
    else if (fidelity <= 30) lines.push(`色彩还原度 ${fidelity}%：适度叠色，远看色彩准确，近看小图略带色罩`);
    else lines.push(`色彩还原度 ${fidelity}%：强叠色，远看非常像原图，近看小图内容被压淡`);

    const regionSize = (2 * diversity + 1) * (2 * diversity + 1);
    if (diversity === 0) lines.push('多样性关闭：允许相邻位置使用同一张图，可能出现大片重复');
    else lines.push(`多样性 ${diversity}：相邻 ${diversity} 格内不重复，局部约需 ${regionSize} 张不同图`);

    if (item.elapsed) lines.push(`生成耗时 <b>${item.elapsed}s</b>`);
    if (item.saved) lines.push(`<span style="color:var(--success)">已保存到 Eagle</span>`);

    lines.push(getCacheStatusLine(s.tileShape));

    el.innerHTML = lines.map(l => `<div class="estimate-line">${l}</div>`).join('');
}

// ============================================================
// U3: Generate button text
// ============================================================

function updateGenerateButtonText() {
    const btn = document.getElementById('btnGenerate');
    if (!btn) return;
    const item = batchQueue[activeIndex];
    if (item && item.status === 'done') {
        btn.textContent = '重新生成';
    } else {
        btn.textContent = '生成当前';
    }
}

// ============================================================
// Pixelated placeholder rendering
// ============================================================

function renderPlaceholder(targetImg, settings) {
    const shape = parseTileRatio(settings.tileShape);
    const gridCols = settings.density;
    const tileW = Math.max(1, Math.floor(settings.outputWidth / gridCols));
    const tileH = Math.max(1, Math.round(tileW * shape.ratio));
    const tileRatio = tileH / tileW;
    const aspect = targetImg.height / targetImg.width;
    const gridRows = Math.max(1, Math.round((gridCols * aspect) / tileRatio));

    // Auto-shrink tile size if needed
    let finalTileW = tileW, finalTileH = tileH;
    while (gridCols * finalTileW > MAX_CANVAS_DIM || gridRows * finalTileH > MAX_CANVAS_DIM) {
        finalTileW = Math.max(1, finalTileW - 1);
        finalTileH = Math.max(1, Math.round(finalTileW * tileRatio));
    }

    const outputW = gridCols * finalTileW;
    const outputH = gridRows * finalTileH;

    // Sample target image
    const sampleCanvas = document.createElement('canvas');
    const sampleCtx = sampleCanvas.getContext('2d');
    sampleCanvas.width = targetImg.width;
    sampleCanvas.height = targetImg.height;
    sampleCtx.drawImage(targetImg, 0, 0);
    const imgData = sampleCtx.getImageData(0, 0, targetImg.width, targetImg.height).data;
    const imgW = targetImg.width;
    const cellW = targetImg.width / gridCols;
    const cellH = targetImg.height / gridRows;

    // Draw color blocks to outputCanvas
    const outputCanvas = document.getElementById('outputCanvas');
    outputCanvas.width = outputW;
    outputCanvas.height = outputH;
    const ctx = outputCanvas.getContext('2d');

    for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
            const x0 = Math.floor(col * cellW);
            const y0 = Math.floor(row * cellH);
            const x1 = Math.min(Math.ceil((col + 1) * cellW), imgW);
            const y1 = Math.min(Math.ceil((row + 1) * cellH), targetImg.height);

            let r = 0, g = 0, b = 0, count = 0;
            for (let py = y0; py < y1; py++) {
                const rowOff = py * imgW;
                for (let px = x0; px < x1; px++) {
                    const i = (rowOff + px) * 4;
                    r += imgData[i]; g += imgData[i + 1]; b += imgData[i + 2];
                    count++;
                }
            }
            if (count === 0) count = 1;
            ctx.fillStyle = `rgb(${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)})`;
            ctx.fillRect(col * finalTileW, row * finalTileH, finalTileW, finalTileH);
        }
    }

    if (viewer) viewer.fitToContainer();
}

// ============================================================
// Sidebar UI
// ============================================================

function renderSidebarUI() {
    // U2: sidebar count
    document.querySelector('.sidebar-header').textContent = `图片列表 (${batchQueue.length})`;

    const list = document.getElementById('sidebarList');
    list.innerHTML = '';
    batchQueue.forEach((item, i) => {
        const el = document.createElement('div');
        el.className = 'sidebar-item'
            + (item.status !== 'pending' ? ' ' + item.status : '')
            + (item.saved ? ' saved' : '')
            + (i === activeIndex ? ' active' : '');
        el.innerHTML = `
            <div class="sidebar-thumb"><img src="${item.thumbnailUrl}" alt=""></div>
            <div class="sidebar-name">${item.name}</div>
        `;
        el.addEventListener('click', () => onSidebarItemClick(i));
        list.appendChild(el);
    });
}

async function onSidebarItemClick(index) {
    const item = batchQueue[index];
    activeIndex = index;

    // Load this image's settings into UI
    loadSettingsToUI(item.settings);

    // Resolve aspect and cache target image
    if (cachedTargetIndex !== index || !cachedTargetImg) {
        if (item.filePath) {
            try {
                cachedTargetImg = await loadImage('file:///' + item.filePath.replace(/\\/g, '/'));
                cachedTargetIndex = index;
                item.sourceAspect = cachedTargetImg.height / cachedTargetImg.width;
            } catch { cachedTargetImg = null; }
        }
    }
    if (item.sourceAspect) targetImgAspect = item.sourceAspect;

    // Show result, in-progress render, or placeholder
    if (item.status === 'processing' && index === generatingIndex && liveBaseCanvas) {
        // Reconstruct full view: placeholder blocks + rendered rows overlay
        const outputCanvas = document.getElementById('outputCanvas');
        const gc = item._liveGridCols, gr = item._liveGridRows;
        const tw = item._liveTileW, th = item._liveTileH;
        const rgbs = item._liveGridRgbs;
        const renderedRow = item._liveRenderedRow;

        outputCanvas.width = liveBaseCanvas.width;
        outputCanvas.height = liveBaseCanvas.height;
        const ctx = outputCanvas.getContext('2d');

        // 1. Draw placeholder color blocks for ALL cells
        if (rgbs && gc && gr) {
            for (let r = 0; r < gr; r++) {
                for (let c = 0; c < gc; c++) {
                    const rgb = rgbs[r * gc + c];
                    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                    ctx.fillRect(c * tw, r * th, tw, th);
                }
            }
        }

        // 2. Overlay already-rendered tile rows from liveBaseCanvas
        if (renderedRow >= 0) {
            const h = (renderedRow + 1) * th;
            ctx.drawImage(liveBaseCanvas, 0, 0, liveBaseCanvas.width, h, 0, 0, liveBaseCanvas.width, h);

            // 3. Apply fidelity overlay on rendered rows
            const fAlpha = item.settings.fidelity / 100;
            if (fAlpha > 0 && rgbs && gc) {
                for (let r = 0; r <= renderedRow; r++) {
                    for (let c = 0; c < gc; c++) {
                        const rgb = rgbs[r * gc + c];
                        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${fAlpha})`;
                        ctx.fillRect(c * tw, r * th, tw, th);
                    }
                }
            }
        }

        if (viewer) viewer.fitToContainer();
    } else if (item.status === 'done') {
        await showResult(item, index);
    } else if (cachedTargetImg) {
        renderPlaceholder(cachedTargetImg, item.settings);
    }

    renderSidebarUI();

    // U5: done image shows actual params summary in estimate; others show live estimate
    if (item.status === 'done') {
        showDoneEstimate(item);
    } else {
        updateEstimate();
    }

    // U4: progress bar sync on switch
    if (item.status === 'done' && item.elapsed) {
        setProgress(1, 1, `完成! ${item.gridCols}x${item.gridRows} 网格, ${item.width}x${item.height}px, 耗时 ${item.elapsed}s`);
    } else if (item.status === 'pending') {
        document.getElementById('progress').style.display = 'none';
    }

    // U3: button text feedback
    updateGenerateButtonText();
}

async function showResult(item, index) {
    if (!item.tempBasePath || !fs.existsSync(item.tempBasePath)) return;
    if (cachedBaseIndex !== index || !cachedBase) {
        cachedBase = await loadImage('file:///' + item.tempBasePath.replace(/\\/g, '/'));
        cachedBaseIndex = index;
    }
    compositeToOutput(cachedBase, item, item.settings.fidelity / 100);
    if (viewer) viewer.fitToContainer();
}

// ============================================================
// Custom modal (replaces native confirm)
// ============================================================

function showModal(html) {
    return new Promise(resolve => {
        const overlay = document.getElementById('modalOverlay');
        const body = document.getElementById('modalBody');
        const btnOk = document.getElementById('modalConfirm');
        const btnCancel = document.getElementById('modalCancel');
        body.innerHTML = html;
        overlay.style.display = 'flex';

        function cleanup(result) {
            overlay.style.display = 'none';
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            resolve(result);
        }
        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
    });
}

// ============================================================
// Tile index cache (memory + disk)
// ============================================================

function sanitizeFolderName(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim() || 'default';
}

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function shapeKeyToFileName(shapeStr) {
    // '1:1' -> '1x1', '16:9' -> '16x9'
    return shapeStr.replace(':', 'x');
}

let currentLibraryCacheDir = null;

function getCacheDir() {
    if (!currentLibraryCacheDir) {
        // name_hash format: readable prefix + unique hash from path
        const name = sanitizeFolderName(currentLibraryName || 'default');
        const hash = simpleHash(currentLibraryId || 'default');
        const libFolder = `${name}_${hash}`;
        currentLibraryCacheDir = path.join(require('os').homedir(), '.photomosaic', 'cache', libFolder);
    }
    if (!fs.existsSync(currentLibraryCacheDir)) fs.mkdirSync(currentLibraryCacheDir, { recursive: true });
    return currentLibraryCacheDir;
}

function getCachePath(shapeStr) {
    return path.join(getCacheDir(), `tile_index_${shapeKeyToFileName(shapeStr)}.json`);
}

function hasDiskCache(shapeStr) {
    const fp = getCachePath(shapeStr);
    return fs.existsSync(fp);
}

function tryLoadDiskCache(shapeStr) {
    const fp = getCachePath(shapeStr);
    if (!fs.existsSync(fp)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (data.tiles && data.tiles.length > 0) return data.tiles;
    } catch {}
    return null;
}

function saveDiskCache(shapeStr, tiles) {
    const fp = getCachePath(shapeStr);
    try { fs.writeFileSync(fp, JSON.stringify({ tiles })); } catch {}
}

function clearAllDiskCache() {
    const dir = getCacheDir();
    try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
            if (f.startsWith('tile_index_') && f.endsWith('.json')) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
    } catch {}
    tileIndexCache.clear();
    cachedTiles = null;
    cachedKdRoot = null;
}

async function syncLibraryId() {
    try {
        // Try all available API approaches to get library name and path
        let newName = null;
        let newId = null;

        // Approach 1: direct properties
        if (eagle.library.name) newName = eagle.library.name;
        if (eagle.library.path) newId = eagle.library.path;

        // Approach 2: async info() if direct properties are empty
        if (!newName || !newId) {
            try {
                const info = await eagle.library.info();
                if (info) {
                    if (!newName && info.name) newName = info.name;
                    if (!newId && info.path) newId = info.path;
                    // info might have other id fields
                    if (!newId && info.id) newId = info.id;
                }
            } catch {}
        }

        // Approach 3: derive name from path (path looks like "X:\...\MyLib.library")
        if (!newName && newId) {
            const base = path.basename(newId);
            newName = base.replace(/\.library$/i, '') || base;
        }

        newName = newName || 'unknown';
        newId = newId || 'unknown';

        if (currentLibraryId && currentLibraryId !== newId) {
            tileIndexCache.clear();
            cachedTiles = null;
            cachedKdRoot = null;
            currentLibraryCacheDir = null;
        }
        currentLibraryName = newName;
        currentLibraryId = newId;
    } catch {}
}

function getIndexMode() {
    const el = document.getElementById('indexMode');
    return el ? el.value : 'sampled';
}

async function ensureTileIndex(shapeStr, tileAspect, shouldCancel) {
    await syncLibraryId();
    const mode = getIndexMode();
    const memKey = mode === 'palette' ? 'palette' : shapeStr;

    // 1. Memory cache hit
    if (tileIndexCache.has(memKey)) {
        const cached = tileIndexCache.get(memKey);
        cachedTiles = cached.tiles;
        cachedKdRoot = cached.kdRoot;
        libraryTileCount = cachedTiles.length;
        return { tiles: cachedTiles, kdRoot: cachedKdRoot };
    }

    // 2. Disk cache hit (sampled mode only; palette is instant)
    if (mode === 'sampled') {
        const diskTiles = tryLoadDiskCache(shapeStr);
        if (diskTiles) {
            setProgress(0, 1, '从缓存加载索引...');
            cachedTiles = diskTiles;
            libraryTileCount = cachedTiles.length;

            setProgress(0, 1, '构建 KD-Tree 空间索引...');
            cachedKdRoot = buildKDTree(cachedTiles.map((_, i) => i), cachedTiles, 0);
            tileIndexCache.set(memKey, { tiles: cachedTiles, kdRoot: cachedKdRoot });
            return { tiles: cachedTiles, kdRoot: cachedKdRoot };
        }
    }

    // 3. Full rebuild
    setProgress(0, 1, '获取图库列表...');
    const allItems = await eagle.item.getAll();

    let newTiles;
    if (mode === 'palette') {
        newTiles = buildTileDatabasePalette(allItems, setProgress);
    } else {
        newTiles = await buildTileDatabaseSampled(allItems, tileAspect, setProgress, shouldCancel);
    }

    if (newTiles.length < 20) {
        alert(`仅索引到 ${newTiles.length} 张有效瓦片图，效果可能较差`);
    }

    setProgress(0, 1, '构建 KD-Tree 空间索引...');
    const newKdRoot = buildKDTree(newTiles.map((_, i) => i), newTiles, 0);

    // Atomic swap: only update globals after full build succeeds
    cachedTiles = newTiles;
    cachedKdRoot = newKdRoot;
    libraryTileCount = cachedTiles.length;
    tileIndexCache.set(memKey, { tiles: cachedTiles, kdRoot: cachedKdRoot });
    if (mode === 'sampled') {
        saveDiskCache(shapeStr, cachedTiles);
    }

    return { tiles: cachedTiles, kdRoot: cachedKdRoot };
}

// ============================================================
// Single-item generation
// ============================================================

async function generateForItem(index, tiles, kdRoot, plugin, progressPrefix) {
    const qItem = batchQueue[index];
    const settings = getSettingsForItem(index);

    if (!qItem.filePath || !fs.existsSync(qItem.filePath)) {
        throw new Error('文件不存在');
    }

    const targetImg = await loadImage('file:///' + qItem.filePath.replace(/\\/g, '/'));
    qItem.sourceAspect = targetImg.height / targetImg.width;
    targetImgAspect = qItem.sourceAspect;

    // Visual update callbacks for progressive rendering
    const fidelityAlpha = settings.fidelity / 100;
    let liveGridRgbs = null;
    let liveGridCols = 0;

    const onVisualUpdate = {
        onPlaceholderReady(gridRgbs, gridCols, gridRows, tileW, tileH) {
            liveGridRgbs = gridRgbs;
            liveGridCols = gridCols;
            // Store on qItem so switch-back can reconstruct full view
            qItem._liveGridRgbs = gridRgbs;
            qItem._liveGridCols = gridCols;
            qItem._liveGridRows = gridRows;
            qItem._liveTileW = tileW;
            qItem._liveTileH = tileH;
            qItem._liveRenderedRow = -1;
            if (activeIndex !== index) return;
            const outputCanvas = document.getElementById('outputCanvas');
            outputCanvas.width = gridCols * tileW;
            outputCanvas.height = gridRows * tileH;
            const ctx = outputCanvas.getContext('2d');
            for (let row = 0; row < gridRows; row++) {
                for (let col = 0; col < gridCols; col++) {
                    const idx = row * gridCols + col;
                    const rgb = gridRgbs[idx];
                    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                    ctx.fillRect(col * tileW, row * tileH, tileW, tileH);
                }
            }
            if (viewer) viewer.fitToContainer();
        },
        onRowRendered(baseCanvas, row, gridCols, tileW, tileH) {
            liveBaseCanvas = baseCanvas;
            qItem._liveRenderedRow = row;
            if (activeIndex !== index) return;
            const outputCanvas = document.getElementById('outputCanvas');
            const ctx = outputCanvas.getContext('2d');
            const sy = row * tileH;
            const w = gridCols * tileW;
            ctx.drawImage(baseCanvas, 0, sy, w, tileH, 0, sy, w, tileH);
            if (fidelityAlpha > 0 && liveGridRgbs) {
                for (let col = 0; col < gridCols; col++) {
                    const idx = row * liveGridCols + col;
                    const rgb = liveGridRgbs[idx];
                    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${fidelityAlpha})`;
                    ctx.fillRect(col * tileW, sy, tileW, tileH);
                }
            }
        }
    };

    const pfx = progressPrefix || '';
    const result = await generateMosaic(
        targetImg, tiles, kdRoot,
        settings.gridCols, settings.tileW, settings.tileH, settings.repeatDistance,
        (cur, tot, text) => setProgress(cur, tot, pfx + text),
        onVisualUpdate,
        () => isBatchCancelled
    );

    // Mark done immediately — user sees completion with no delay
    qItem.width = result.width;
    qItem.height = result.height;
    qItem.gridCols = result.gridCols;
    qItem.gridRows = result.gridRows;
    qItem.tileW = result.tileW;
    qItem.tileH = result.tileH;
    qItem.gridRgbs = result.gridRgbs;
    qItem.status = 'done';

    cachedBase = result.baseCanvas;
    cachedBaseIndex = index;

    // Save base canvas to disk in background (delay lets browser paint "完成" first)
    const oldTemp = qItem.tempBasePath;
    qItem.tempBasePath = null;
    setTimeout(() => {
        if (oldTemp) { try { fs.unlinkSync(oldTemp); } catch {} }
        qItem.tempBasePath = saveCanvasToTemp(result.baseCanvas, qItem.id, plugin.path);
    }, 300);
}

// ============================================================
// Plugin lifecycle & UI wiring
// ============================================================

// ============================================================
// Theme sync (must be top-level, same pattern as MangaStream)
// ============================================================

const EAGLE_THEME_MAP = { LIGHT:'theme-light', LIGHTGRAY:'theme-lightgray', GRAY:'theme-gray', DARK:'theme-dark', BLUE:'theme-blue', PURPLE:'theme-purple' };
const ALL_THEMES = ['theme-light', 'theme-lightgray', 'theme-gray', 'theme-dark', 'theme-blue', 'theme-purple'];

function syncEagleTheme() {
    if (typeof eagle === 'undefined' || !eagle.app) return;
    const eagleTheme = eagle.app.theme;
    let themeClass = EAGLE_THEME_MAP[eagleTheme];
    if (!themeClass) {
        themeClass = eagle.app.isDarkColors() ? 'theme-gray' : 'theme-light';
    }
    ALL_THEMES.forEach(t => document.body.classList.remove(t));
    document.body.classList.add(themeClass);
}

eagle.onPluginCreate(async (plugin) => {
    pluginPath = plugin.path;
    await syncLibraryId();

    // ---- Theme sync ----
    syncEagleTheme();

    // ---- Window controls ----
    const minimizeBtn = document.getElementById('titlebar-minimize');
    const maximizeBtn = document.getElementById('titlebar-maximize');
    const closeBtn2 = document.getElementById('titlebar-close');
    const titlebarDrag = document.getElementById('titlebar-drag');
    const pinBtn = document.getElementById('titlebar-pin');
    let isPinned = false;

    // Minimize
    minimizeBtn.addEventListener('click', () => {
        if (eagle.window && typeof eagle.window.minimize === 'function') {
            eagle.window.minimize().catch(() => {});
        }
    });

    // Close
    closeBtn2.addEventListener('click', () => {
        if (eagle.window && typeof eagle.window.close === 'function') {
            eagle.window.close();
        } else {
            window.close();
        }
    });

    // Maximize / restore (fullscreen toggle)
    function updateMaximizeIcon() {
        const maxIcon = document.querySelector('#titlebar-maximize .maximize-icon');
        const restIcon = document.querySelector('#titlebar-maximize .restore-icon');
        if (document.fullscreenElement) {
            maxIcon.style.display = 'none';
            restIcon.style.display = '';
        } else {
            maxIcon.style.display = '';
            restIcon.style.display = 'none';
        }
    }

    maximizeBtn.addEventListener('click', async () => {
        try {
            if (!document.fullscreenElement) {
                await document.documentElement.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch {}
    });

    // Double-click titlebar → toggle fullscreen
    titlebarDrag.addEventListener('dblclick', async () => {
        try {
            if (!document.fullscreenElement) {
                await document.documentElement.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch {}
    });

    // Drag titlebar in fullscreen → exit fullscreen
    let dragStart = null;
    titlebarDrag.addEventListener('mousedown', (e) => {
        if (document.fullscreenElement) {
            dragStart = { x: e.screenX, y: e.screenY };
        }
    });
    document.addEventListener('mousemove', (e) => {
        if (dragStart && document.fullscreenElement) {
            const dx = Math.abs(e.screenX - dragStart.x);
            const dy = Math.abs(e.screenY - dragStart.y);
            if (dx > 10 || dy > 10) {
                dragStart = null;
                document.exitFullscreen().catch(() => {});
            }
        }
    });
    document.addEventListener('mouseup', () => { dragStart = null; });

    // Sync icon + drag region on fullscreen change
    document.addEventListener('fullscreenchange', () => {
        updateMaximizeIcon();
        titlebarDrag.style.webkitAppRegion = document.fullscreenElement ? 'no-drag' : 'drag';
    });

    // Pin (always on top)
    pinBtn.addEventListener('click', () => {
        isPinned = !isPinned;
        eagle.window.setAlwaysOnTop(isPinned)
            .then(() => eagle.window.focus())
            .catch(() => {});
        const normalIcon = pinBtn.querySelector('.pin-icon-normal');
        const pinnedIcon = pinBtn.querySelector('.pin-icon-pinned');
        if (isPinned) {
            pinBtn.classList.add('active');
            normalIcon.style.display = 'none';
            pinnedIcon.style.display = '';
        } else {
            pinBtn.classList.remove('active');
            normalIcon.style.display = '';
            pinnedIcon.style.display = 'none';
        }
    });

    const btnGenerate = document.getElementById('btnGenerate');
    const btnGenerateAll = document.getElementById('btnGenerateAll');
    const btnSave = document.getElementById('btnSave');
    const btnSaveAll = document.getElementById('btnSaveAll');

    const densitySlider = document.getElementById('density');
    const densityValue = document.getElementById('densityValue');
    const fidelitySlider = document.getElementById('colorFidelity');
    const fidelityValue = document.getElementById('colorFidelityValue');
    const diversitySlider = document.getElementById('diversity');
    const diversityValueEl = document.getElementById('diversityValue');
    const outputWidthSelect = document.getElementById('outputWidth');
    const tileShapeSelect = document.getElementById('tileShape');

    viewer = initViewer();

    // Rebuild index button + index mode + cache status
    const btnRebuild = document.getElementById('btnRebuildIndex');
    const indexModeSelect = document.getElementById('indexMode');

    function getCurrentShapeStr() {
        return batchQueue[activeIndex] ? batchQueue[activeIndex].settings.tileShape : (tileShapeSelect.value || '1:1');
    }

    function updateRebuildLabel() {
        const shape = getCurrentShapeStr();
        const mode = indexModeSelect.value;
        if (mode === 'palette') {
            btnRebuild.style.display = 'none';
        } else {
            btnRebuild.style.display = '';
            btnRebuild.textContent = `重建索引 (${shape})`;
        }
    }

    function updateCacheStatus() {
        // Cache status is now rendered inside the estimate area
        // Just refresh the estimate/done display
        const item = batchQueue[activeIndex];
        if (item && item.status === 'done') {
            showDoneEstimate(item);
        } else {
            updateEstimate();
        }
    }

    await syncLibraryId();
    updateRebuildLabel();
    updateCacheStatus();

    let isRebuilding = false;
    let rebuildCancelled = false;

    btnRebuild.addEventListener('click', async () => {
        // If rebuilding, treat click as cancel
        if (isRebuilding) {
            rebuildCancelled = true;
            btnRebuild.textContent = '取消中...';
            btnRebuild.disabled = true;
            return;
        }
        if (isBatchRunning) return;
        await syncLibraryId();
        const shape = tileShapeSelect.value || '1:1';
        const libName = currentLibraryName || '未知';
        const ok = await showModal(
            `即将重建素材库「<b>${libName}</b>」瓦片 <b>${shape}</b> 的颜色索引。<br><br>` +
            `此操作需要加载图库中所有缩略图并逐张采样裁剪区域的平均颜色，图库较大时可能耗时数秒到数十秒。<br><br>` +
            `<span style="color:var(--text-secondary)">建议在图库内容发生较大变化后执行。</span>`
        );
        if (!ok) return;

        isRebuilding = true;
        rebuildCancelled = false;
        btnRebuild.textContent = '取消重建';
        setAllGenBtnsDisabled(true);
        setProgress(0, 1, '正在重建索引...');

        try {
            const s = parseTileRatio(shape);
            const tileAspect = s.w / s.h;

            // Build new index WITHOUT clearing old one first (atomic)
            setProgress(0, 1, '获取图库列表...');
            const allItems = await eagle.item.getAll();
            const newTiles = await buildTileDatabaseSampled(allItems, tileAspect, setProgress, () => rebuildCancelled);

            setProgress(0, 1, '构建 KD-Tree 空间索引...');
            const newKdRoot = buildKDTree(newTiles.map((_, i) => i), newTiles, 0);

            // Success — now atomically replace old cache
            clearAllDiskCache();
            cachedTiles = newTiles;
            cachedKdRoot = newKdRoot;
            libraryTileCount = cachedTiles.length;
            const memKey = shape;
            tileIndexCache.set(memKey, { tiles: cachedTiles, kdRoot: cachedKdRoot });
            saveDiskCache(shape, cachedTiles);

            setProgress(1, 1, `索引重建完成，${cachedTiles.length} 张有效瓦片`);
        } catch (err) {
            if (err.message === 'CANCELLED') {
                setProgress(0, 0, '重建已取消，原索引不受影响');
            } else {
                setProgress(0, 0, '重建失败: ' + err.message);
            }
        }

        isRebuilding = false;
        rebuildCancelled = false;
        updateRebuildLabel();
        updateButtonStates();
        updateCacheStatus();
    });

    // Switching index mode clears memory cache
    indexModeSelect.addEventListener('change', () => {
        tileIndexCache.clear();
        cachedTiles = null;
        cachedKdRoot = null;
        updateRebuildLabel();
        updateCacheStatus();
    });

    function onSettingChange() {
        densityValue.textContent = densitySlider.value;
        fidelityValue.textContent = fidelitySlider.value;
        diversityValueEl.textContent = diversitySlider.value;
        saveUIToSettings();
        updateEstimate();

        // If pending and we have a cached target, redraw placeholder
        if (batchQueue[activeIndex] && batchQueue[activeIndex].status === 'pending' && cachedTargetImg && cachedTargetIndex === activeIndex) {
            renderPlaceholder(cachedTargetImg, batchQueue[activeIndex].settings);
        }

        // U3: show live estimate when done item params change (user might want to regenerate)
        updateGenerateButtonText();
        updateRebuildLabel();
        updateCacheStatus();
    }

    densitySlider.addEventListener('input', onSettingChange);
    diversitySlider.addEventListener('input', onSettingChange);
    outputWidthSelect.addEventListener('change', onSettingChange);
    tileShapeSelect.addEventListener('change', onSettingChange);

    // Fidelity: live re-composite for done items, placeholder redraw for pending
    fidelitySlider.addEventListener('input', () => {
        fidelityValue.textContent = fidelitySlider.value;
        saveUIToSettings();
        updateEstimate();

        if (batchQueue[activeIndex] && batchQueue[activeIndex].status === 'done') {
            showResult(batchQueue[activeIndex], activeIndex);
        } else if (batchQueue[activeIndex] && batchQueue[activeIndex].status === 'pending' && cachedTargetImg && cachedTargetIndex === activeIndex) {
            renderPlaceholder(cachedTargetImg, batchQueue[activeIndex].settings);
        }
    });

    // ---- Load selected items and show sidebar ----
    // P1: empty state handling
    const emptyState = document.getElementById('emptyState');

    try {
        const selected = await eagle.item.getSelected();
        if (selected && selected.length > 0) {
            emptyState.style.display = 'none';
            batchQueue = selected.map(item => ({
                id: item.id,
                name: item.name,
                filePath: item.filePath,
                thumbnailUrl: 'file:///' + (item.thumbnailPath || item.filePath).replace(/\\/g, '/'),
                sourceAspect: (item.height && item.width) ? item.height / item.width : 0,
                status: 'pending',
                errorMessage: null,
                tempBasePath: null,
                width: 0, height: 0,
                gridCols: 0, gridRows: 0, tileW: 0, tileH: 0,
                gridRgbs: null,
                saved: false,
                settings: { ...getDefaultSettings() }
            }));
            activeIndex = 0;

            if (selected.length > 1) btnSaveAll.style.display = '';

            // Load first image for placeholder
            try {
                cachedTargetImg = await loadImage('file:///' + selected[0].filePath.replace(/\\/g, '/'));
                cachedTargetIndex = 0;
                batchQueue[0].sourceAspect = cachedTargetImg.height / cachedTargetImg.width;
                targetImgAspect = batchQueue[0].sourceAspect;
                renderPlaceholder(cachedTargetImg, batchQueue[0].settings);
            } catch {}

            renderSidebarUI();
        } else {
            // P1: no images selected - empty state stays visible
            document.querySelector('.sidebar-header').textContent = '图片列表 (0)';
        }
    } catch {}

    updateEstimate();

    function setAllGenBtnsDisabled(v) {
        btnGenerate.disabled = v;
        btnGenerateAll.disabled = v;
    }

    function updateButtonStates() {
        const hasDone = batchQueue.some(q => q.status === 'done');
        btnSave.disabled = !hasDone;
        btnSaveAll.disabled = !hasDone || batchQueue.length <= 1;
        const empty = batchQueue.length === 0;
        btnGenerate.disabled = empty;
        btnGenerateAll.disabled = empty;
    }
    updateButtonStates();

    // ---- Generate current ----
    btnGenerate.addEventListener('click', async () => {
        // If already running, treat click as cancel
        if (isBatchRunning) {
            isBatchCancelled = true;
            btnGenerate.textContent = '取消中...';
            btnGenerate.disabled = true;
            return;
        }
        if (activeIndex < 0 || !batchQueue[activeIndex]) return;

        isBatchRunning = true;
        isBatchCancelled = false;
        btnGenerateAll.disabled = true;
        btnGenerate.textContent = '取消';

        try {
            const curShapeStr = batchQueue[activeIndex].settings.tileShape;
            const curShape = parseTileRatio(curShapeStr);
            const { tiles, kdRoot } = await ensureTileIndex(curShapeStr, curShape.w / curShape.h, () => isBatchCancelled);
            if (isBatchCancelled) throw new Error('CANCELLED');
            updateEstimate();

            generatingIndex = activeIndex;
            batchQueue[activeIndex].status = 'processing';
            renderSidebarUI();

            const t0 = performance.now();
            await generateForItem(activeIndex, tiles, kdRoot, plugin);
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            batchQueue[activeIndex].elapsed = elapsed;

            generatingIndex = -1;
            liveBaseCanvas = null;
            renderSidebarUI();

            const r = batchQueue[activeIndex];
            setProgress(1, 1, `完成! ${r.gridCols}x${r.gridRows} 网格, ${r.width}x${r.height}px, 耗时 ${elapsed}s`);
            showDoneEstimate(r);
        } catch (err) {
            if (err.message === 'CANCELLED') {
                if (batchQueue[activeIndex]) batchQueue[activeIndex].status = 'pending';
                setProgress(0, 0, '已取消');
            } else {
                if (batchQueue[activeIndex]) batchQueue[activeIndex].status = 'error';
                alert('生成失败: ' + err.message);
                setProgress(0, 0, '出错: ' + err.message);
            }
            generatingIndex = -1;
            liveBaseCanvas = null;
            renderSidebarUI();
        }

        isBatchRunning = false;
        isBatchCancelled = false;
        updateGenerateButtonText();
        updateButtonStates();
        updateCacheStatus();
    });

    // ---- Generate all ----
    btnGenerateAll.addEventListener('click', async () => {
        if (isBatchRunning) {
            isBatchCancelled = true;
            btnGenerateAll.textContent = '取消中...';
            btnGenerateAll.disabled = true;
            btnGenerate.disabled = true;
            return;
        }

        isBatchRunning = true;
        isBatchCancelled = false;
        setAllGenBtnsDisabled(true);
        btnGenerateAll.textContent = '取消';
        btnGenerateAll.disabled = false;

        try {
            const firstShapeStr = batchQueue[0].settings.tileShape;
            const firstShape = parseTileRatio(firstShapeStr);
            const { tiles, kdRoot } = await ensureTileIndex(firstShapeStr, firstShape.w / firstShape.h, () => isBatchCancelled);
            if (isBatchCancelled) throw new Error('CANCELLED');
            updateEstimate();

            const t0 = performance.now();
            for (let i = 0; i < batchQueue.length; i++) {
                if (isBatchCancelled) break;

                generatingIndex = i;
                batchQueue[i].status = 'processing';
                renderSidebarUI();

                try {
                    const pfx = batchQueue.length > 1 ? `[${i + 1}/${batchQueue.length}] ` : '';
                    const itemT0 = performance.now();
                    await generateForItem(i, tiles, kdRoot, plugin, pfx);
                    const itemElapsed = ((performance.now() - itemT0) / 1000).toFixed(1);
                    batchQueue[i].elapsed = itemElapsed;

                    const r = batchQueue[i];
                    setProgress(1, 1, `[${i + 1}/${batchQueue.length}] 完成! ${r.gridCols}x${r.gridRows}, 耗时 ${itemElapsed}s`);
                } catch (err) {
                    if (err.message === 'CANCELLED') {
                        batchQueue[i].status = 'pending';
                        break;
                    } else {
                        batchQueue[i].status = 'error';
                        batchQueue[i].errorMessage = err.message;
                    }
                }

                renderSidebarUI();
            }
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

            generatingIndex = -1;
            liveBaseCanvas = null;
            isBatchRunning = false;
            btnGenerateAll.textContent = '全部生成';

            const doneCount = batchQueue.filter(q => q.status === 'done').length;
            const errorCount = batchQueue.filter(q => q.status === 'error').length;
            let msg = `完成! ${doneCount}/${batchQueue.length} 张成功, 总耗时 ${elapsed}s`;
            if (errorCount > 0) msg += `，${errorCount} 张失败`;
            if (isBatchCancelled) msg += '（已取消）';
            setProgress(1, 1, msg);
        } catch (err) {
            if (err.message === 'CANCELLED') {
                setProgress(0, 0, '已取消');
            } else {
                alert('生成失败: ' + err.message);
                setProgress(0, 0, '出错: ' + err.message);
            }
            isBatchRunning = false;
            btnGenerateAll.textContent = '全部生成';
        }

        isBatchRunning = false;
        isBatchCancelled = false;
        generatingIndex = -1;
        liveBaseCanvas = null;
        updateGenerateButtonText();
        updateButtonStates();
        updateCacheStatus();
    });

    // ---- Save current ----
    btnSave.addEventListener('click', async () => {
        try {
            btnSave.disabled = true;
            setProgress(0, 1, '导出中...');

            const folderId = await ensureMosaicFolder();

            const canvas = document.getElementById('outputCanvas');
            const dataUrl = canvas.toDataURL('image/png');
            const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

            const tempDir = ensureTempDir(plugin.path);
            const timestamp = Date.now();
            const tempFile = path.join(tempDir, `photomosaic_${timestamp}.png`);
            fs.writeFileSync(tempFile, Buffer.from(base64Data, 'base64'));

            const itemName = (activeIndex >= 0 && batchQueue[activeIndex])
                ? `Photomosaic_${batchQueue[activeIndex].name}`
                : `Photomosaic_${timestamp}`;

            await eagle.item.addFromPath(tempFile, {
                name: itemName,
                tags: ['photomosaic', 'generated'],
                folders: [folderId],
            });

            if (batchQueue[activeIndex]) batchQueue[activeIndex].saved = true;
            renderSidebarUI();

            try { fs.unlinkSync(tempFile); } catch {}
            setProgress(1, 1, '已保存到 Eagle 图库 / 马赛克图片');

            // U3: temporary save confirmation
            btnSave.textContent = '已保存 \u2713';
            setTimeout(() => { btnSave.textContent = '保存到 Eagle'; }, 2000);

            // U5: update estimate if viewing done item
            if (batchQueue[activeIndex] && batchQueue[activeIndex].status === 'done') {
                showDoneEstimate(batchQueue[activeIndex]);
            }
        } catch (err) {
            alert('保存失败: ' + err.message);
        } finally {
            btnSave.disabled = false;
        }
    });

    // ---- Save all (skip already saved) ----
    btnSaveAll.addEventListener('click', async () => {
        const unsaved = batchQueue.filter(q => q.status === 'done' && !q.saved);
        if (unsaved.length === 0) {
            setProgress(1, 1, '所有图片均已保存，无需重复操作');
            return;
        }

        try {
            btnSaveAll.disabled = true;
            const folderId = await ensureMosaicFolder();
            const tempDir = ensureTempDir(plugin.path);

            for (let i = 0; i < unsaved.length; i++) {
                const item = unsaved[i];
                setProgress(i, unsaved.length, `保存 ${i + 1}/${unsaved.length}: ${item.name}`);

                const baseImg = await loadImage('file:///' + item.tempBasePath.replace(/\\/g, '/'));
                compositeToOutput(baseImg, item, item.settings.fidelity / 100);

                const canvas = document.getElementById('outputCanvas');
                const dataUrl = canvas.toDataURL('image/png');
                const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

                const outFile = path.join(tempDir, `photomosaic_${item.id}_${Date.now()}.png`);
                fs.writeFileSync(outFile, Buffer.from(base64Data, 'base64'));

                await eagle.item.addFromPath(outFile, {
                    name: `Photomosaic_${item.name}`,
                    tags: ['photomosaic', 'generated', 'batch'],
                    folders: [folderId],
                });

                item.saved = true;
                try { fs.unlinkSync(outFile); } catch {}
            }

            renderSidebarUI();
            setProgress(1, 1, `已保存 ${unsaved.length} 张到 Eagle 图库 / 马赛克图片`);
        } catch (err) {
            alert('批量保存失败: ' + err.message);
        } finally {
            btnSaveAll.disabled = false;
        }
    });

    // Cleanup on exit
    eagle.onPluginBeforeExit(() => {
        if (batchQueue.length > 0) cleanupTempFiles(batchQueue, plugin.path);
    });
});

// 监听 Eagle 主题变化（顶层注册，与 MangaStream 一致）
eagle.onThemeChanged(() => {
    syncEagleTheme();
});

// 监听 Eagle 素材库切换，清除缓存并刷新状态
eagle.onLibraryChanged(async () => {
    await syncLibraryId();
    tileIndexCache.clear();
    cachedTiles = null;
    cachedKdRoot = null;
    currentLibraryCacheDir = null;
});
