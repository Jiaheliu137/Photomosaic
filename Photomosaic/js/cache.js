// ============================================================
// Tile index cache (memory + disk) & library sync
// ============================================================

let currentLibraryName = null;
let currentLibraryId = null;
let currentLibraryCacheDir = null;
let excludedFolderIds = new Set();

const tileIndexCache = new Map();
let cachedTiles = null;
let cachedKdRoot = null;
let libraryTileCount = 0;

let mosaicFolderId = null;

function getCacheDir() {
    if (!currentLibraryCacheDir) {
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
    return fs.existsSync(getCachePath(shapeStr));
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

function loadExcludedFolders() {
    try {
        const fp = path.join(getCacheDir(), 'excluded_folders.json');
        if (fs.existsSync(fp)) {
            const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            if (Array.isArray(arr)) excludedFolderIds = new Set(arr);
        }
    } catch {}
}

function saveExcludedFolders() {
    try {
        const fp = path.join(getCacheDir(), 'excluded_folders.json');
        fs.writeFileSync(fp, JSON.stringify([...excludedFolderIds]));
    } catch {}
}

function filterItemsByExcludedFolders(items) {
    if (excludedFolderIds.size === 0) return items;
    return items.filter(item => {
        const folders = item.folders;
        if (!folders || folders.length === 0) return true;
        return !folders.some(fid => excludedFolderIds.has(fid));
    });
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
        let newName = null;
        let newId = null;

        if (eagle.library.name) newName = eagle.library.name;
        if (eagle.library.path) newId = eagle.library.path;

        if (!newName || !newId) {
            try {
                const info = await eagle.library.info();
                if (info) {
                    if (!newName && info.name) newName = info.name;
                    if (!newId && info.path) newId = info.path;
                    if (!newId && info.id) newId = info.id;
                }
            } catch {}
        }

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
