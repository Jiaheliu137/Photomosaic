// ============================================================
// Pan & Zoom viewer
// ============================================================

function initViewer() {
    const container = document.getElementById('preview');
    const canvas = document.getElementById('outputCanvas');
    const PADDING = 20;

    let scale = 1, minScale = 0.1, panX = 0, panY = 0;
    let isPanning = false, startX, startY, startPanX, startPanY;
    let userInteracted = false;

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
        userInteracted = false;
    }

    // Recalculate minScale based on current canvas/container (always safe to call)
    function updateMinScale() {
        if (!canvas.width || !canvas.height) return;
        const cw = container.clientWidth - PADDING * 2;
        const ch = container.clientHeight - PADDING * 2;
        if (cw <= 0 || ch <= 0) return;
        const fitScale = Math.min(cw / canvas.width, ch / canvas.height);
        minScale = fitScale * 0.5;
    }

    // Only fit if user hasn't manually zoomed/panned
    function softFit() {
        updateMinScale();
        if (!userInteracted) fitToContainer();
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
        userInteracted = true;
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
        userInteracted = true;
    });

    window.addEventListener('mouseup', () => {
        isPanning = false;
        container.style.cursor = 'grab';
    });

    container.style.cursor = 'grab';

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(softFit, 60);
    });

    function resetInteraction() {
        userInteracted = false;
    }

    return { fitToContainer, softFit, resetInteraction };
}
