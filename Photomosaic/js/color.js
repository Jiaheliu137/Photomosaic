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

    if (diff * diff < best.dist) {
        best = kdSearch(far, target, tiles, excluded, best);
    }

    return best;
}

const EMPTY_SET = new Set();

function findBestTileKD(root, targetLab, tiles, excluded) {
    const result = kdSearch(root, targetLab, tiles, excluded, { dist: Infinity, idx: -1 });
    if (result.idx >= 0) return result.idx;
    const fallback = kdSearch(root, targetLab, tiles, EMPTY_SET, { dist: Infinity, idx: -1 });
    return fallback.idx;
}
