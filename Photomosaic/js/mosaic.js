// ============================================================
// Tile database builders
// ============================================================

const SUB_GRID = 5;       // 5×5 sub-block matching grid
const TOP_K = 50;         // candidates from KD-Tree coarse search

function buildTileDatabasePalette(items, onProgress) {
    const tiles = [];
    const imageExts = new Set(['jpg', 'jpeg', 'png', 'bmp', 'webp']);

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!imageExts.has((item.ext || '').toLowerCase())) continue;

        const palettes = item.palettes;
        if (!palettes || palettes.length === 0) continue;

        const imgPath = item.thumbnailPath || item.filePath;
        if (!imgPath) continue;

        let lSum = 0, aSum = 0, bSum = 0, totalRatio = 0;
        for (const p of palettes) {
            const ratio = p.ratio || 0;
            if (ratio === 0) continue;
            const lab = rgbToLab(p.color[0], p.color[1], p.color[2]);
            lSum += lab[0] * ratio;
            aSum += lab[1] * ratio;
            bSum += lab[2] * ratio;
            totalRatio += ratio;
        }
        if (totalRatio === 0) continue;

        const avgLab = [lSum / totalRatio, aSum / totalRatio, bSum / totalRatio];

        tiles.push({
            id: item.id,
            imgPath: 'file:///' + imgPath.replace(/\\/g, '/'),
            lab: avgLab
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

// Helper: compute 5×5 sub-block Lab averages from imageData region
function computeSubBlockLabs(data, dataWidth, x0, y0, regionW, regionH) {
    const labs = new Array(SUB_GRID * SUB_GRID);
    const subW = regionW / SUB_GRID;
    const subH = regionH / SUB_GRID;

    for (let sr = 0; sr < SUB_GRID; sr++) {
        for (let sc = 0; sc < SUB_GRID; sc++) {
            const sx0 = x0 + Math.floor(sc * subW);
            const sy0 = y0 + Math.floor(sr * subH);
            const sx1 = x0 + Math.floor((sc + 1) * subW);
            const sy1 = y0 + Math.floor((sr + 1) * subH);

            let lSum = 0, aSum = 0, bSum = 0, count = 0;
            for (let py = sy0; py < sy1; py++) {
                for (let px = sx0; px < sx1; px++) {
                    const i = (py * dataWidth + px) * 4;
                    const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
                    lSum += lab[0]; aSum += lab[1]; bSum += lab[2];
                    count++;
                }
            }
            if (count === 0) count = 1;
            labs[sr * SUB_GRID + sc] = [lSum / count, aSum / count, bSum / count];
        }
    }
    return labs;
}

async function buildTileDatabaseSampled(items, tileAspect, onProgress, shouldCancel) {
    const candidates = [];
    const imageExts = new Set(['jpg', 'jpeg', 'png', 'bmp', 'webp']);

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

        // Compute 5×5 sub-block Labs
        const labs = computeSubBlockLabs(data, sw, 0, 0, sw, sh);

        // Overall average = mean of 25 sub-block Labs
        let oL = 0, oA = 0, oB = 0;
        for (let j = 0; j < labs.length; j++) {
            oL += labs[j][0]; oA += labs[j][1]; oB += labs[j][2];
        }
        const n = labs.length;
        const avgLab = [oL / n, oA / n, oB / n];

        tiles.push({
            id: candidates[i].id,
            imgPath: candidates[i].imgPath,
            lab: avgLab,
            labs: labs
        });
    }

    if (onProgress) {
        onProgress(candidates.length, candidates.length, `索引完成: ${tiles.length} 张有效瓦片`);
    }
    return tiles;
}

// ============================================================
// Main generation pipeline
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

    // Sample target image grid cells
    const sampleCanvas = document.createElement('canvas');
    const sampleCtx = sampleCanvas.getContext('2d');
    sampleCanvas.width = targetImg.width;
    sampleCanvas.height = targetImg.height;
    sampleCtx.drawImage(targetImg, 0, 0);

    const cellW = targetImg.width / gridCols;
    const cellH = targetImg.height / gridRows;
    const gridLabs = new Array(totalCells);
    const gridRgbs = new Array(totalCells);
    const gridSubLabs = new Array(totalCells);

    const imgData = sampleCtx.getImageData(0, 0, targetImg.width, targetImg.height).data;
    const imgW = targetImg.width;

    // Check if tiles have sub-block data (sampled mode)
    const hasSubBlocks = tiles.length > 0 && !!tiles[0].labs;

    for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
            const x0 = Math.floor(col * cellW);
            const y0 = Math.floor(row * cellH);
            const x1 = Math.min(Math.ceil((col + 1) * cellW), imgW);
            const y1 = Math.min(Math.ceil((row + 1) * cellH), targetImg.height);
            const regionW = x1 - x0;
            const regionH = y1 - y0;

            const idx = row * gridCols + col;

            if (hasSubBlocks && regionW >= SUB_GRID && regionH >= SUB_GRID) {
                // 5×5 sub-block Labs for fine matching
                const subLabs = computeSubBlockLabs(imgData, imgW, x0, y0, regionW, regionH);
                gridSubLabs[idx] = subLabs;

                // Overall average = mean of sub-block Labs
                let oL = 0, oA = 0, oB = 0;
                for (let j = 0; j < subLabs.length; j++) {
                    oL += subLabs[j][0]; oA += subLabs[j][1]; oB += subLabs[j][2];
                }
                const n = subLabs.length;
                gridLabs[idx] = [oL / n, oA / n, oB / n];
            } else {
                // Fallback: single Lab average (palette mode or tiny cells)
                let lSum = 0, aSum = 0, bSum = 0, count = 0;
                for (let py = y0; py < y1; py++) {
                    const rowOff = py * imgW;
                    for (let px = x0; px < x1; px++) {
                        const i = (rowOff + px) * 4;
                        const lab = rgbToLab(imgData[i], imgData[i + 1], imgData[i + 2]);
                        lSum += lab[0]; aSum += lab[1]; bSum += lab[2];
                        count++;
                    }
                }
                if (count === 0) count = 1;
                gridLabs[idx] = [lSum / count, aSum / count, bSum / count];
                gridSubLabs[idx] = null;
            }

            // RGB average (always needed for placeholder and fidelity overlay)
            let r = 0, g = 0, b = 0, rgbCount = 0;
            for (let py = y0; py < y1; py++) {
                const rowOff = py * imgW;
                for (let px = x0; px < x1; px++) {
                    const i = (rowOff + px) * 4;
                    r += imgData[i]; g += imgData[i + 1]; b += imgData[i + 2];
                    rgbCount++;
                }
            }
            if (rgbCount === 0) rgbCount = 1;
            gridRgbs[idx] = [Math.round(r / rgbCount), Math.round(g / rgbCount), Math.round(b / rgbCount)];
        }
    }

    // Visual update: show pixelated placeholder
    if (onVisualUpdate && onVisualUpdate.onPlaceholderReady) {
        onVisualUpdate.onPlaceholderReady(gridRgbs, gridCols, gridRows, finalTileW, finalTileH);
        await new Promise(r => setTimeout(r, 50));
    }

    // Match + load + render
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

            // Two-stage matching if sub-block data available, else single-stage
            let bestIdx;
            if (gridSubLabs[idx]) {
                bestIdx = findBestTileSubBlock(kdRoot, gridLabs[idx], gridSubLabs[idx], tiles, excluded, TOP_K);
            } else {
                bestIdx = findBestTileKD(kdRoot, gridLabs[idx], tiles, excluded);
            }

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
// Tile index orchestrator (memory → disk → rebuild)
// ============================================================

async function ensureTileIndex(shapeStr, tileAspect, shouldCancel) {
    await syncLibraryId();
    const mode = getIndexMode();
    const baseKey = mode === 'palette' ? 'palette' : shapeStr;

    // Include selection state in cache key to avoid stale KD-Trees
    const externalPaths = mode === 'sampled' ? getSelectedExternalPaths() : [];
    const useLocal = mode === 'sampled' ? isLocalIndexSelected() : true;
    const selectionSuffix = mode === 'sampled'
        ? '|local=' + (useLocal ? '1' : '0') + (externalPaths.length > 0 ? '|' + externalPaths.slice().sort().join('|') : '')
        : '';
    const memKey = baseKey + selectionSuffix;

    if (tileIndexCache.has(memKey)) {
        const cached = tileIndexCache.get(memKey);
        cachedTiles = cached.tiles;
        cachedKdRoot = cached.kdRoot;
        libraryTileCount = cachedTiles.length;
        return { tiles: cachedTiles, kdRoot: cachedKdRoot };
    }

    // Load or build local tiles
    let localTiles = null;

    if (mode === 'palette') {
        setProgress(0, 1, '获取图库列表...');
        const allItems = filterItemsByExcludedFolders(await eagle.item.getAll());
        localTiles = buildTileDatabasePalette(allItems, setProgress);
    } else if (useLocal) {
        localTiles = tryLoadDiskCache(shapeStr);
        if (localTiles) {
            setProgress(0, 1, '从缓存加载索引...');
        } else {
            setProgress(0, 1, '获取图库列表...');
            const allItems = filterItemsByExcludedFolders(await eagle.item.getAll());
            localTiles = await buildTileDatabaseSampled(allItems, tileAspect, setProgress, shouldCancel);
            saveDiskCache(shapeStr, localTiles);
        }
    } else {
        localTiles = [];
    }

    // Merge external indexes (sampled mode only)
    let mergedTiles = localTiles;
    if (mode === 'sampled' && externalPaths.length > 0) {
        mergedTiles = localTiles.slice();
        let extTotal = 0;
        for (const extPath of externalPaths) {
            const extTiles = loadExternalIndex(extPath);
            if (extTiles) {
                const valid = extTiles.filter(t => t.lab && t.labs);
                mergedTiles = mergedTiles.concat(valid);
                extTotal += valid.length;
            }
        }
        if (extTotal > 0) {
            setProgress(0, 1, `合并完成: ${localTiles.length} + ${extTotal} = ${mergedTiles.length} 张瓦片`);
        }
    }

    if (mergedTiles.length < 20) {
        showAlert(`仅索引到 ${mergedTiles.length} 张有效瓦片图，效果可能较差`);
    }

    setProgress(0, 1, '构建 KD-Tree 空间索引...');
    const newKdRoot = buildKDTree(mergedTiles.map((_, i) => i), mergedTiles, 0);

    cachedTiles = mergedTiles;
    cachedKdRoot = newKdRoot;
    libraryTileCount = cachedTiles.length;
    tileIndexCache.set(memKey, { tiles: cachedTiles, kdRoot: cachedKdRoot });

    return { tiles: cachedTiles, kdRoot: cachedKdRoot };
}
