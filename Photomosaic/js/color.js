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

// L-channel weighted distance (human vision is more sensitive to luminance)
function deltaESq(lab1, lab2) {
    const dL = lab1[0] - lab2[0];
    const da = lab1[1] - lab2[1];
    const db = lab1[2] - lab2[2];
    return 2 * dL * dL + da * da + db * db;
}

// Sum of per-sub-block deltaESq for 5×5 matching
function subBlockDistSq(labs1, labs2) {
    let sum = 0;
    for (let i = 0; i < labs1.length; i++) {
        sum += deltaESq(labs1[i], labs2[i]);
    }
    return sum;
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

// Single nearest neighbor search (used by palette mode)
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

// Top-K nearest neighbor search (used by sampled mode for two-stage matching)
function kdSearchTopK(node, target, tiles, excluded, heap, k) {
    if (!node) return;

    const tileLab = tiles[node.tileIdx].lab;
    const d = deltaESq(target, tileLab);

    if (!excluded.has(tiles[node.tileIdx].id)) {
        if (heap.length < k) {
            heap.push({ dist: d, idx: node.tileIdx });
            if (heap.length === k) {
                // Build max-heap by sorting descending; heap[0] is the farthest
                heap.sort((a, b) => b.dist - a.dist);
            }
        } else if (d < heap[0].dist) {
            heap[0] = { dist: d, idx: node.tileIdx };
            // Re-sort to maintain max at [0]
            heap.sort((a, b) => b.dist - a.dist);
        }
    }

    const axis = node.axis;
    const diff = target[axis] - tileLab[axis];
    const near = diff <= 0 ? node.left : node.right;
    const far = diff <= 0 ? node.right : node.left;

    kdSearchTopK(near, target, tiles, excluded, heap, k);

    // Prune: only search far side if splitting plane is closer than worst in heap
    const threshold = heap.length < k ? Infinity : heap[0].dist;
    if (diff * diff < threshold) {
        kdSearchTopK(far, target, tiles, excluded, heap, k);
    }
}

const EMPTY_SET = new Set();

// Original single-best search (palette mode)
function findBestTileKD(root, targetLab, tiles, excluded) {
    const result = kdSearch(root, targetLab, tiles, excluded, { dist: Infinity, idx: -1 });
    if (result.idx >= 0) return result.idx;
    const fallback = kdSearch(root, targetLab, tiles, EMPTY_SET, { dist: Infinity, idx: -1 });
    return fallback.idx;
}

// Two-stage search: KD-Tree coarse → sub-block fine ranking (sampled mode)
function findBestTileSubBlock(root, targetLab, targetSubLabs, tiles, excluded, topK) {
    const heap = [];
    kdSearchTopK(root, targetLab, tiles, excluded, heap, topK);

    // Fallback: if all candidates were excluded, search without exclusion
    if (heap.length === 0) {
        kdSearchTopK(root, targetLab, tiles, EMPTY_SET, heap, topK);
    }
    if (heap.length === 0) return -1;

    // If tiles don't have sub-block data, fall back to coarse result
    if (!tiles[heap[0].idx].labs) {
        let bestIdx = -1, bestDist = Infinity;
        for (const h of heap) {
            if (h.dist < bestDist) { bestDist = h.dist; bestIdx = h.idx; }
        }
        return bestIdx;
    }

    // Fine ranking: compare 5×5 sub-block distances
    let bestIdx = -1, bestDist = Infinity;
    for (const h of heap) {
        const d = subBlockDistSq(targetSubLabs, tiles[h.idx].labs);
        if (d < bestDist) {
            bestDist = d;
            bestIdx = h.idx;
        }
    }
    return bestIdx;
}
