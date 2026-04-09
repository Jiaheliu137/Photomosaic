// ============================================================
// Tile index cache (memory + disk) & library sync
// ============================================================

const CACHE_VERSION = 2;  // Bump when index format changes

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

// Filename pattern: tile_index_{shape}_v{version}_{count}.json
const TILE_INDEX_RE = /^tile_index_(.+)_v(\d+)_(\d+)\.json$/;

function findCacheFile(shapeStr) {
    const dir = getCacheDir();
    const shapeName = shapeKeyToFileName(shapeStr);
    const prefix = `tile_index_${shapeName}_v${CACHE_VERSION}_`;
    try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
            if (f.startsWith(prefix) && f.endsWith('.json')) return path.join(dir, f);
        }
    } catch {}
    return null;
}

function hasDiskCache(shapeStr) {
    return findCacheFile(shapeStr) !== null;
}

function tryLoadDiskCache(shapeStr) {
    const fp = findCacheFile(shapeStr);
    if (!fp) return null;
    try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (data.tiles && data.tiles.length > 0) return data.tiles;
    } catch {}
    return null;
}

function saveDiskCache(shapeStr, tiles) {
    // Remove old cache files for this shape (any version/count)
    const dir = getCacheDir();
    const shapeName = shapeKeyToFileName(shapeStr);
    const prefix = `tile_index_${shapeName}_`;
    try {
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(prefix) && f.endsWith('.json')) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
    } catch {}
    const fp = path.join(dir, `tile_index_${shapeName}_v${CACHE_VERSION}_${tiles.length}.json`);
    try { fs.writeFileSync(fp, JSON.stringify({ version: CACHE_VERSION, tiles })); } catch {}
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

function discoverExternalIndexes(shapeStr) {
    const cacheRoot = path.join(require('os').homedir(), '.photomosaic', 'cache');
    if (!fs.existsSync(cacheRoot)) return [];
    const currentDir = getCacheDir();
    const shapeName = shapeKeyToFileName(shapeStr);
    const prefix = `tile_index_${shapeName}_v${CACHE_VERSION}_`;
    const results = [];
    let entries;
    try { entries = fs.readdirSync(cacheRoot); } catch { return []; }
    for (const entry of entries) {
        const dirPath = path.join(cacheRoot, entry);
        if (dirPath === currentDir) continue;
        try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
        // Scan for matching index file by prefix
        let matchedFile = null;
        let tileCount = 0;
        try {
            for (const f of fs.readdirSync(dirPath)) {
                if (f.startsWith(prefix) && f.endsWith('.json')) {
                    matchedFile = f;
                    const m = f.match(TILE_INDEX_RE);
                    if (m) tileCount = parseInt(m[3], 10);
                    break;
                }
            }
        } catch { continue; }
        if (!matchedFile) continue;
        const lastUnderscore = entry.lastIndexOf('_');
        const displayName = lastUnderscore > 0 ? entry.substring(0, lastUnderscore) : entry;
        results.push({ dirName: entry, displayName, cachePath: path.join(dirPath, matchedFile), tileCount });
    }
    return results;
}

function loadExternalIndex(cachePath) {
    if (!fs.existsSync(cachePath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (data.version !== CACHE_VERSION) return null;
        if (data.tiles && data.tiles.length > 0) return data.tiles;
    } catch {}
    return null;
}

let _currentIndexMode = 'sampled';

function getIndexMode() {
    return _currentIndexMode;
}

function setIndexMode(mode) {
    _currentIndexMode = mode;
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
