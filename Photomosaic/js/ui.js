// ============================================================
// UI: Estimate panel, sidebar, settings sync, modal, placeholder
// ============================================================

let targetImgAspect = 1.33;
let viewer = null;

// Queue & state
let batchQueue = [];
let activeIndex = 0;
let isBatchRunning = false;
let isBatchCancelled = false;
let generatingIndex = -1;
let liveBaseCanvas = null;

let pluginPath = null;

// Display caches
let cachedBase = null;
let cachedBaseIndex = -1;
let cachedTargetImg = null;
let cachedTargetIndex = -1;

// ---- Per-image settings <-> UI sync ----

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

// ---- Estimate panel ----

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

// ---- Cross-library index dropdown ----

const CROSS_LIB_LOCAL_KEY = '__local__';
let crossLibrarySelection = new Map();
let crossLibDropdownOpen = false;

function renderCrossLibraryPanel(shapeStr) {
    const row = document.getElementById('crossLibraryRow');
    const trigger = document.getElementById('crossLibTrigger');
    const dropdown = document.getElementById('crossLibDropdown');
    if (!row || !trigger || !dropdown) return;

    // Close dropdown if open
    crossLibDropdownOpen = false;
    document.getElementById('crossLibMenu').classList.remove('open');

    const mode = getIndexMode();
    if (mode !== 'sampled') {
        dropdown.classList.add('disabled');
        trigger.textContent = '仅精确模式可用';
        return;
    }

    const externals = discoverExternalIndexes(shapeStr);
    const localHasIndex = hasDiskCache(shapeStr);
    const localName = currentLibraryName || '当前图库';

    // No externals — show local name only, not interactive
    if (externals.length === 0) {
        dropdown.classList.add('disabled');
        if (!crossLibrarySelection.has(CROSS_LIB_LOCAL_KEY)) {
            crossLibrarySelection.set(CROSS_LIB_LOCAL_KEY, { cachePath: null, selected: true });
        }
        trigger.textContent = localName + '（本库）';
        return;
    }

    dropdown.classList.remove('disabled');

    // Clean stale entries
    const validKeys = new Set([CROSS_LIB_LOCAL_KEY, ...externals.map(e => e.dirName)]);
    for (const key of crossLibrarySelection.keys()) {
        if (!validKeys.has(key)) crossLibrarySelection.delete(key);
    }

    // Default: local always selected
    if (!crossLibrarySelection.has(CROSS_LIB_LOCAL_KEY)) {
        crossLibrarySelection.set(CROSS_LIB_LOCAL_KEY, { cachePath: null, selected: true });
    }
    for (const ext of externals) {
        if (!crossLibrarySelection.has(ext.dirName)) {
            crossLibrarySelection.set(ext.dirName, { cachePath: ext.cachePath, selected: false });
        }
    }

    // Build menu HTML
    const menu = document.getElementById('crossLibMenu');
    const allSelected = crossLibrarySelection.get(CROSS_LIB_LOCAL_KEY)?.selected !== false
        && externals.every(e => crossLibrarySelection.get(e.dirName)?.selected);
    let html = `<label class="cross-lib-item cross-lib-select-all">` +
        `<input type="checkbox" id="crossLibSelectAll" ${allSelected ? 'checked' : ''}> ` +
        `<span class="cross-lib-name">全选</span>` +
        `</label>`;

    // Local library entry — always selectable
    const localChecked = crossLibrarySelection.get(CROSS_LIB_LOCAL_KEY).selected ? 'checked' : '';
    let localCountText = '';
    if (localHasIndex) {
        const localFile = findCacheFile(shapeStr);
        if (localFile) {
            const m = path.basename(localFile).match(TILE_INDEX_RE);
            if (m) localCountText = parseInt(m[3], 10) + ' 张';
        }
    } else {
        localCountText = '首次自动构建';
    }
    html += `<label class="cross-lib-item">` +
        `<input type="checkbox" data-dir="${CROSS_LIB_LOCAL_KEY}" ${localChecked}> ` +
        `<span class="cross-lib-name">${localName}</span>` +
        `<span class="cross-lib-tag">本库</span>` +
        `<span class="cross-lib-count">${localCountText}</span>` +
        `</label>`;

    // External libraries
    for (const ext of externals) {
        const checked = crossLibrarySelection.get(ext.dirName).selected ? 'checked' : '';
        html += `<label class="cross-lib-item">` +
            `<input type="checkbox" data-dir="${ext.dirName}" ${checked}> ` +
            `<span class="cross-lib-name">${ext.displayName}</span>` +
            `<span class="cross-lib-count">${ext.tileCount > 0 ? ext.tileCount + ' 张' : ''}</span>` +
            `</label>`;
    }
    menu.innerHTML = html;

    // Bind checkbox events
    const itemCbs = menu.querySelectorAll('input[type="checkbox"][data-dir]');
    const selectAllCb = document.getElementById('crossLibSelectAll');

    itemCbs.forEach(cb => {
        cb.addEventListener('change', () => {
            const entry = crossLibrarySelection.get(cb.dataset.dir);
            if (entry) entry.selected = cb.checked;
            tileIndexCache.clear();
            cachedTiles = null;
            cachedKdRoot = null;
            // Sync select-all state
            if (selectAllCb) {
                selectAllCb.checked = [...itemCbs].every(c => c.checked);
            }
            updateCrossLibTriggerText();
        });
    });

    if (selectAllCb) {
        selectAllCb.addEventListener('change', () => {
            const val = selectAllCb.checked;
            itemCbs.forEach(cb => {
                cb.checked = val;
                const entry = crossLibrarySelection.get(cb.dataset.dir);
                if (entry) entry.selected = val;
            });
            tileIndexCache.clear();
            cachedTiles = null;
            cachedKdRoot = null;
            updateCrossLibTriggerText();
        });
    }

    updateCrossLibTriggerText();
}

function updateCrossLibTriggerText() {
    const trigger = document.getElementById('crossLibTrigger');
    if (!trigger) return;
    let count = 0;
    let names = [];
    for (const [key, entry] of crossLibrarySelection) {
        if (entry.selected) {
            count++;
            if (key === CROSS_LIB_LOCAL_KEY) {
                names.push((currentLibraryName || '当前图库') + '(本库)');
            } else {
                const lastUnderscore = key.lastIndexOf('_');
                names.push(lastUnderscore > 0 ? key.substring(0, lastUnderscore) : key);
            }
        }
    }
    if (count === 0) {
        trigger.textContent = '未选择索引库';
    } else if (count === 1) {
        trigger.textContent = names[0];
    } else {
        trigger.textContent = `已选 ${count} 个索引库`;
    }
}

function initCrossLibDropdown() {
    const trigger = document.getElementById('crossLibTrigger');
    const menu = document.getElementById('crossLibMenu');
    if (!trigger || !menu) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (trigger.closest('.cross-lib-dropdown.disabled')) return;
        crossLibDropdownOpen = !crossLibDropdownOpen;
        menu.classList.toggle('open', crossLibDropdownOpen);
    });

    document.addEventListener('click', (e) => {
        if (crossLibDropdownOpen && !menu.contains(e.target) && e.target !== trigger) {
            crossLibDropdownOpen = false;
            menu.classList.remove('open');
        }
    });
}

function getSelectedExternalPaths() {
    const paths = [];
    for (const [key, entry] of crossLibrarySelection) {
        if (key !== CROSS_LIB_LOCAL_KEY && entry.selected) {
            paths.push(entry.cachePath);
        }
    }
    return paths;
}

function isLocalIndexSelected() {
    const entry = crossLibrarySelection.get(CROSS_LIB_LOCAL_KEY);
    return entry ? entry.selected : true;
}

function hasAnyIndexSelected() {
    if (crossLibrarySelection.size === 0) return true; // No dropdown = local-only
    for (const [, entry] of crossLibrarySelection) {
        if (entry.selected) return true;
    }
    return false;
}

// ---- Save button state ----

function updateSaveButtonState() {
    const btnSave = document.getElementById('btnSave');
    const btnSaveAll = document.getElementById('btnSaveAll');
    if (!btnSave) return;
    const item = batchQueue[activeIndex];
    const anySaving = batchQueue.some(q => q._savingTemp);
    if (item && item._savingTemp) {
        btnSave.disabled = true;
        btnSave.textContent = '准备中…';
    } else if (item && item.status === 'done') {
        btnSave.disabled = false;
        btnSave.textContent = '保存到 Eagle';
    } else {
        btnSave.disabled = true;
        btnSave.textContent = '保存到 Eagle';
    }
    if (btnSaveAll) {
        const hasDone = batchQueue.some(q => q.status === 'done');
        btnSaveAll.disabled = !hasDone || anySaving || batchQueue.length <= 1;
    }
}

// ---- Generate button text ----

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

// ---- Pixelated placeholder ----

function renderPlaceholder(targetImg, settings) {
    const shape = parseTileRatio(settings.tileShape);
    const gridCols = settings.density;
    const tileW = Math.max(1, Math.floor(settings.outputWidth / gridCols));
    const tileH = Math.max(1, Math.round(tileW * shape.ratio));
    const tileRatio = tileH / tileW;
    const aspect = targetImg.height / targetImg.width;
    const gridRows = Math.max(1, Math.round((gridCols * aspect) / tileRatio));

    let finalTileW = tileW, finalTileH = tileH;
    while (gridCols * finalTileW > MAX_CANVAS_DIM || gridRows * finalTileH > MAX_CANVAS_DIM) {
        finalTileW = Math.max(1, finalTileW - 1);
        finalTileH = Math.max(1, Math.round(finalTileW * tileRatio));
    }

    const outputW = gridCols * finalTileW;
    const outputH = gridRows * finalTileH;

    const sampleCanvas = document.createElement('canvas');
    const sampleCtx = sampleCanvas.getContext('2d');
    sampleCanvas.width = targetImg.width;
    sampleCanvas.height = targetImg.height;
    sampleCtx.drawImage(targetImg, 0, 0);
    const imgData = sampleCtx.getImageData(0, 0, targetImg.width, targetImg.height).data;
    const imgW = targetImg.width;
    const cellW = targetImg.width / gridCols;
    const cellH = targetImg.height / gridRows;

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

    if (viewer) viewer.softFit();
}

// ---- Sidebar ----

function renderSidebarUI() {
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
    const switchedImage = (index !== activeIndex);
    const item = batchQueue[index];
    activeIndex = index;

    // 切换到不同图片时重置缩放状态，让 softFit 自动适应
    if (switchedImage && viewer) viewer.resetInteraction();

    loadSettingsToUI(item.settings);

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

    if (item.status === 'processing' && index === generatingIndex && liveBaseCanvas) {
        const outputCanvas = document.getElementById('outputCanvas');
        const gc = item._liveGridCols, gr = item._liveGridRows;
        const tw = item._liveTileW, th = item._liveTileH;
        const rgbs = item._liveGridRgbs;
        const renderedRow = item._liveRenderedRow;

        outputCanvas.width = liveBaseCanvas.width;
        outputCanvas.height = liveBaseCanvas.height;
        const ctx = outputCanvas.getContext('2d');

        if (rgbs && gc && gr) {
            for (let r = 0; r < gr; r++) {
                for (let c = 0; c < gc; c++) {
                    const rgb = rgbs[r * gc + c];
                    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                    ctx.fillRect(c * tw, r * th, tw, th);
                }
            }
        }

        if (renderedRow >= 0) {
            const h = (renderedRow + 1) * th;
            ctx.drawImage(liveBaseCanvas, 0, 0, liveBaseCanvas.width, h, 0, 0, liveBaseCanvas.width, h);

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

        if (viewer) viewer.softFit();
    } else if (item.status === 'done') {
        await showResult(item, index);
    } else if (cachedTargetImg) {
        renderPlaceholder(cachedTargetImg, item.settings);
    }

    renderSidebarUI();

    if (item.status === 'done') {
        showDoneEstimate(item);
    } else {
        updateEstimate();
    }

    if (item.status === 'done' && item.elapsed) {
        setProgress(1, 1, `完成! ${item.gridCols}x${item.gridRows} 网格, ${item.width}x${item.height}px, 耗时 ${item.elapsed}s`);
    } else if (item.status === 'pending') {
        document.getElementById('progress').style.display = 'none';
    }

    updateGenerateButtonText();
    updateSaveButtonState();
}

async function showResult(item, index) {
    if (!item.tempBasePath || !fs.existsSync(item.tempBasePath)) return;
    if (cachedBaseIndex !== index || !cachedBase) {
        cachedBase = await loadImage('file:///' + item.tempBasePath.replace(/\\/g, '/'));
        cachedBaseIndex = index;
    }
    compositeToOutput(cachedBase, item, item.settings.fidelity / 100);
    if (viewer) viewer.softFit();
}

// ---- Custom modal ----

function showModal(html) {
    return new Promise(resolve => {
        const overlay = document.getElementById('modalOverlay');
        const body = document.getElementById('modalBody');
        const btnOk = document.getElementById('modalConfirm');
        const btnCancel = document.getElementById('modalCancel');
        body.innerHTML = html;
        btnCancel.style.display = '';
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

function showAlert(html) {
    return new Promise(resolve => {
        const overlay = document.getElementById('modalOverlay');
        const body = document.getElementById('modalBody');
        const btnOk = document.getElementById('modalConfirm');
        const btnCancel = document.getElementById('modalCancel');
        body.innerHTML = html;
        btnCancel.style.display = 'none';
        overlay.style.display = 'flex';

        function cleanup() {
            overlay.style.display = 'none';
            btnOk.removeEventListener('click', onOk);
            resolve();
        }
        function onOk() { cleanup(); }
        btnOk.addEventListener('click', onOk);
    });
}
