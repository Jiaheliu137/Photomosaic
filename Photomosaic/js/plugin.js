// ============================================================
// Plugin lifecycle & UI wiring
// ============================================================

// Theme sync
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

// Single-item generation
async function generateForItem(index, tiles, kdRoot, plugin, progressPrefix) {
    const qItem = batchQueue[index];
    const settings = getSettingsForItem(index);

    if (!qItem.filePath || !fs.existsSync(qItem.filePath)) {
        throw new Error('文件不存在');
    }

    const targetImg = await loadImage('file:///' + qItem.filePath.replace(/\\/g, '/'));
    qItem.sourceAspect = targetImg.height / targetImg.width;
    targetImgAspect = qItem.sourceAspect;

    const fidelityAlpha = settings.fidelity / 100;
    let liveGridRgbs = null;
    let liveGridCols = 0;

    const onVisualUpdate = {
        onPlaceholderReady(gridRgbs, gridCols, gridRows, tileW, tileH) {
            liveGridRgbs = gridRgbs;
            liveGridCols = gridCols;
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
            if (viewer) viewer.softFit();
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

    const oldTemp = qItem.tempBasePath;
    qItem.tempBasePath = null;
    setTimeout(async () => {
        if (oldTemp) { try { fs.unlinkSync(oldTemp); } catch {} }
        qItem.tempBasePath = await saveCanvasToTemp(result.baseCanvas, qItem.id, plugin.path);
    }, 100);
}

// ============================================================
// Main plugin entry
// ============================================================

eagle.onPluginCreate(async (plugin) => {
    pluginPath = plugin.path;
    await syncLibraryId();

    syncEagleTheme();

    // ---- Window controls ----
    const minimizeBtn = document.getElementById('titlebar-minimize');
    const maximizeBtn = document.getElementById('titlebar-maximize');
    const closeBtn2 = document.getElementById('titlebar-close');
    const titlebarDrag = document.getElementById('titlebar-drag');
    const pinBtn = document.getElementById('titlebar-pin');
    let isPinned = false;

    minimizeBtn.addEventListener('click', () => {
        if (eagle.window && typeof eagle.window.minimize === 'function') {
            eagle.window.minimize().catch(() => {});
        }
    });

    closeBtn2.addEventListener('click', () => {
        if (eagle.window && typeof eagle.window.close === 'function') {
            eagle.window.close();
        } else {
            window.close();
        }
    });

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

    titlebarDrag.addEventListener('dblclick', async () => {
        try {
            if (!document.fullscreenElement) {
                await document.documentElement.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch {}
    });

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

    document.addEventListener('fullscreenchange', () => {
        updateMaximizeIcon();
        titlebarDrag.style.webkitAppRegion = document.fullscreenElement ? 'no-drag' : 'drag';
    });

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
        const item = batchQueue[activeIndex];
        if (item && item.status === 'done') {
            showDoneEstimate(item);
        } else {
            updateEstimate();
        }
    }

    await syncLibraryId();
    try { await ensureMosaicFolder(); } catch {}
    try { loadExcludedFolders(); } catch {}
    if (mosaicFolderId) excludedFolderIds.add(mosaicFolderId);
    try { saveExcludedFolders(); } catch {}
    updateRebuildLabel();
    updateCacheStatus();

    let isRebuilding = false;
    let rebuildCancelled = false;

    btnRebuild.addEventListener('click', async () => {
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

        let allFolders = [];
        try { allFolders = await eagle.folder.getAll(); } catch {}

        function flattenFolders(folders, depth) {
            let result = [];
            for (const f of folders) {
                result.push({ id: f.id, name: f.name, depth });
                if (f.children && f.children.length > 0) {
                    result = result.concat(flattenFolders(f.children, depth + 1));
                }
            }
            return result;
        }
        const flatFolders = flattenFolders(allFolders, 0);

        try { loadExcludedFolders(); } catch {}
        if (mosaicFolderId) excludedFolderIds.add(mosaicFolderId);

        let folderHtml = '';
        if (flatFolders.length > 0) {
            folderHtml = `<div style="margin-top:8px;max-height:180px;overflow-y:auto;border:1px solid var(--border-color);border-radius:6px;padding:6px 8px;">` +
                flatFolders.map(f => {
                    const checked = excludedFolderIds.has(f.id) ? 'checked' : '';
                    const indent = f.depth * 16;
                    const label = f.id === mosaicFolderId ? `${f.name} <span style="color:var(--text-muted);font-size:10px">（输出文件夹）</span>` : f.name;
                    return `<label style="display:flex;align-items:center;gap:4px;padding:2px 0;padding-left:${indent}px;cursor:pointer;font-size:12px;color:var(--text-primary)">` +
                        `<input type="checkbox" value="${f.id}" class="exclude-folder-cb" ${checked} style="margin:0;accent-color:var(--accent)"> ${label}</label>`;
                }).join('') +
                `</div>`;
        }

        const ok = await showModal(
            `即将重建素材库「<b>${libName}</b>」瓦片 <b>${shape}</b> 的颜色索引。<br><br>` +
            `此操作需要加载图库中所有缩略图并逐张采样裁剪区域的平均颜色，图库较大时可能耗时数秒到数十秒。<br><br>` +
            `<b style="font-size:12px">排除以下文件夹的图片：</b>` +
            folderHtml +
            `<br><span style="color:var(--text-secondary)">建议在图库内容发生较大变化后执行。</span>`
        );
        if (!ok) return;

        const checkboxes = document.querySelectorAll('.exclude-folder-cb');
        excludedFolderIds = new Set();
        checkboxes.forEach(cb => { if (cb.checked) excludedFolderIds.add(cb.value); });
        try { saveExcludedFolders(); } catch {}

        isRebuilding = true;
        rebuildCancelled = false;
        btnRebuild.textContent = '取消重建';
        setAllGenBtnsDisabled(true);
        setProgress(0, 1, '正在重建索引...');

        try {
            const s = parseTileRatio(shape);
            const tileAspect = s.w / s.h;

            setProgress(0, 1, '获取图库列表...');
            const allItems = filterItemsByExcludedFolders(await eagle.item.getAll());
            const newTiles = await buildTileDatabaseSampled(allItems, tileAspect, setProgress, () => rebuildCancelled);

            setProgress(0, 1, '构建 KD-Tree 空间索引...');
            const newKdRoot = buildKDTree(newTiles.map((_, i) => i), newTiles, 0);

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

        if (batchQueue[activeIndex] && batchQueue[activeIndex].status === 'pending' && cachedTargetImg && cachedTargetIndex === activeIndex) {
            renderPlaceholder(cachedTargetImg, batchQueue[activeIndex].settings);
        }

        updateGenerateButtonText();
        updateRebuildLabel();
    }

    densitySlider.addEventListener('input', onSettingChange);
    diversitySlider.addEventListener('input', onSettingChange);
    outputWidthSelect.addEventListener('change', onSettingChange);
    tileShapeSelect.addEventListener('change', onSettingChange);

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

    // ---- Load selected items ----
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

            try {
                cachedTargetImg = await loadImage('file:///' + selected[0].filePath.replace(/\\/g, '/'));
                cachedTargetIndex = 0;
                batchQueue[0].sourceAspect = cachedTargetImg.height / cachedTargetImg.width;
                targetImgAspect = batchQueue[0].sourceAspect;
                renderPlaceholder(cachedTargetImg, batchQueue[0].settings);
            } catch {}

            renderSidebarUI();
        } else {
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

            btnSave.textContent = '已保存 \u2713';
            setTimeout(() => { btnSave.textContent = '保存到 Eagle'; }, 2000);

            if (batchQueue[activeIndex] && batchQueue[activeIndex].status === 'done') {
                showDoneEstimate(batchQueue[activeIndex]);
            }
        } catch (err) {
            alert('保存失败: ' + err.message);
        } finally {
            btnSave.disabled = false;
        }
    });

    // ---- Save all ----
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

// Top-level Eagle event listeners
eagle.onThemeChanged(() => {
    syncEagleTheme();
});

eagle.onLibraryChanged(async () => {
    await syncLibraryId();
    tileIndexCache.clear();
    cachedTiles = null;
    cachedKdRoot = null;
    currentLibraryCacheDir = null;
});
