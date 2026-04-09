const path = require('path');
const fs = require('fs');
const os = require('os');

const MAX_CANVAS_DIM = 16384;

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load: ${src}`));
        img.src = src;
    });
}

function parseTileRatio(shapeStr) {
    const [w, h] = shapeStr.split(':').map(Number);
    return { w, h, ratio: h / w };
}

function getDefaultSettings() {
    return { outputWidth: 4000, density: 80, tileShape: '1:1', diversity: 3, fidelity: 20 };
}

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
    return shapeStr.replace(':', 'x');
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

// Temp file management for batch memory control
function ensureTempDir() {
    const tempDir = path.join(os.tmpdir(), 'photomosaic_temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

function saveCanvasToTemp(canvas, itemId) {
    const tempDir = ensureTempDir();
    const filePath = path.join(tempDir, `base_${itemId}_${Date.now()}.png`);
    return new Promise((resolve) => {
        canvas.toBlob((blob) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const buffer = Buffer.from(reader.result);
                fs.writeFile(filePath, buffer, () => resolve(filePath));
            };
            reader.readAsArrayBuffer(blob);
        }, 'image/png');
    });
}

function cleanupTempFiles(queue) {
    for (const item of queue) {
        if (item.tempBasePath) {
            try { fs.unlinkSync(item.tempBasePath); } catch {}
            item.tempBasePath = null;
        }
    }
}
