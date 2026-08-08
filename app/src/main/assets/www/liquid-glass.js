/*!
 * liquid-glass.js
 * ---------------------------------------------------------------------------
 * Physically-based "Liquid Glass" refraction engine for SVG backdrop-filter.
 *
 * This implements the approach described in:
 *   "Liquid Glass in the Browser: Refraction with CSS and SVG" (kube.io)
 *   https://kube.io/blog/liquid-glass-css-svg
 *
 * For every element marked with [data-lg], this module:
 *   1. Reads the element's real size + border-radius (all 4 corners) from
 *      the DOM, so the glass shape always matches the actual rendered shape.
 *   2. Builds a 1D "radial" refraction profile by ray-tracing a straight
 *      incident ray through a convex-squircle glass bezel via Snell's law
 *      (air n=1.0 -> glass n=1.5), exactly like the article's simulation.
 *   3. Extends that 1D profile into a full 2D displacement vector field
 *      using a rounded-rect signed-distance-field (SDF), so corners and
 *      straight edges share the same physically-computed falloff.
 *   4. Rasterizes the vector field into an RGBA displacement map
 *      (R = X shift, G = Y shift, 128 = no shift) plus a rim/specular map.
 *   5. Injects a <filter> (feImage + feGaussianBlur + feDisplacementMap +
 *      feBlend) into a shared <svg> defs pool and points the element's
 *      `backdrop-filter` at it via the `--lg-url` custom property.
 *
 * Usage (see index.html / style.css):
 *   <div id="mob-nav" data-lg data-lg-bezel="16" data-lg-strength="1"></div>
 *   .css -> backdrop-filter: var(--lg-url, <fallback blur>) brightness(1.05);
 *
 * No build step, no dependencies. Safe no-op on browsers without SVG
 * backdrop-filter support (falls back to the CSS `var(--lg-url, ...)`
 * default value already declared in style.css).
 * ---------------------------------------------------------------------------
 */
(function () {
    'use strict';

    /* ─────────────────────────────────────────────
       Optics constants (see article: "Understanding Refraction")
    ───────────────────────────────────────────── */
    var N_AIR = 1.0;
    var N_GLASS = 1.5;      // Apple Liquid Glass ~= standard glass
    var RADIAL_SAMPLES = 128; // matches the article's "127 ray simulations"

    /* ─────────────────────────────────────────────
       Surface height function: Convex Squircle
       y = (1 - (1-x)^4)^(1/4)   for x in [0,1]
       (softer flat->curve transition than a circle, matches Apple's bezel)
    ───────────────────────────────────────────── */
    function squircleHeight(s) {
        var c = 1 - Math.min(1, Math.max(0, s));
        var v = 1 - Math.pow(c, 4);
        return Math.pow(Math.max(0, v), 0.25);
    }

    /**
     * Ray-traces a single vertical incident ray through the glass bezel at
     * normalized distance-from-edge `s`, and returns how far (in px) its
     * exit point on the background plane is shifted, using real Snell's
     * law refraction (see article: "Displacement Vector Field").
     *
     * Cross-section coordinates: u = distance from outer edge (px, along
     * the surface), z = height of the glass surface above the background
     * plane (px). The incident ray travels straight down (0,-1).
     */
    function buildRadialProfile(bezelPx, thicknessPx) {
        var profile = new Float32Array(RADIAL_SAMPLES + 1);
        var eta = N_AIR / N_GLASS;
        var delta = 1 / (RADIAL_SAMPLES * 4);

        for (var i = 0; i <= RADIAL_SAMPLES; i++) {
            var s = i / RADIAL_SAMPLES;
            var s0 = Math.max(0, s - delta);
            var s1 = Math.min(1, s + delta);
            var h0 = squircleHeight(s0) * thicknessPx;
            var h1 = squircleHeight(s1) * thicknessPx;
            var dHdu = (h1 - h0) / Math.max(1e-6, (s1 - s0) * bezelPx);

            // Outward surface normal in the (u,z) cross-section
            var nx = -dHdu, nz = 1;
            var nLen = Math.hypot(nx, nz) || 1;
            var Nx = nx / nLen, Nz = nz / nLen;

            // theta1: angle of incidence between the ray and the normal
            var cosT1 = Math.min(1, Math.max(-1, Nz));
            var sinT1 = Math.sqrt(Math.max(0, 1 - cosT1 * cosT1));
            var sinT2 = Math.min(1, eta * sinT1);
            var cosT2 = Math.sqrt(Math.max(0, 1 - sinT2 * sinT2));

            // Vector refraction: r = eta*d + (eta*cosT1 - cosT2)*N, d=(0,-1)
            var k = eta * cosT1 - cosT2;
            var rx = k * Nx;
            var rz = -eta + k * Nz;

            var u = s * bezelPx;
            var H = squircleHeight(s) * thicknessPx;

            var uExit = u;
            if (rz < -1e-6) {
                var t = H / -rz; // travel until the ray reaches the background plane (z=0)
                uExit = u + t * rx;
            }
            profile[i] = uExit - u; // signed horizontal displacement at this radius
        }
        return profile;
    }

    function sampleProfile(profile, s) {
        s = Math.min(1, Math.max(0, s));
        var f = s * RADIAL_SAMPLES;
        var i0 = Math.floor(f), i1 = Math.min(RADIAL_SAMPLES, i0 + 1);
        var frac = f - i0;
        return profile[i0] * (1 - frac) + profile[i1] * frac;
    }

    /* ─────────────────────────────────────────────
       Rounded-rect SDF (per-corner radius), used to find, for every pixel,
       the distance to the nearest edge and the inward direction — this is
       what lets one radial profile wrap correctly around straight edges
       *and* corners (see article: "Circles let us form rounded rectangles").
    ───────────────────────────────────────────── */
    function roundedRectDistance(px, py, cx, cy, hw, hh, rTL, rTR, rBR, rBL) {
        var r = (px < cx)
            ? (py < cy ? rTL : rBL)
            : (py < cy ? rTR : rBR);
        r = Math.min(r, hw, hh);
        var qx = Math.abs(px - cx) - (hw - r);
        var qy = Math.abs(py - cy) - (hh - r);
        var outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r + Math.min(Math.max(qx, qy), 0);
        return -outside; // > 0 inside the shape, 0 at the border
    }

    /* ─────────────────────────────────────────────
       Build the displacement map + specular map canvases for one shape.
    ───────────────────────────────────────────── */
    function buildMaps(opts) {
        var W = Math.max(4, Math.round(opts.width));
        var H = Math.max(4, Math.round(opts.height));

        // Downsample the raster for performance; feImage will upscale the
        // smooth gradient back to full size without visible artifacts.
        var mapScale = Math.min(1, 220 / Math.max(W, H));
        var mw = Math.max(2, Math.round(W * mapScale));
        var mh = Math.max(2, Math.round(H * mapScale));

        var bezel = opts.bezel * mapScale;
        var thickness = bezel * 0.92;
        var profile = buildRadialProfile(bezel, thickness);

        var maxAbs = 1e-3;
        for (var i = 0; i <= RADIAL_SAMPLES; i++) maxAbs = Math.max(maxAbs, Math.abs(profile[i]));

        var dispCanvas = document.createElement('canvas');
        dispCanvas.width = mw; dispCanvas.height = mh;
        var dctx = dispCanvas.getContext('2d');
        var dImg = dctx.createImageData(mw, mh);

        var specCanvas = document.createElement('canvas');
        specCanvas.width = mw; specCanvas.height = mh;
        var sctx = specCanvas.getContext('2d');
        var sImg = sctx.createImageData(mw, mh);

        var cx = mw / 2, cy = mh / 2, hw = mw / 2, hh = mh / 2;
        var rTL = opts.rTL * mapScale, rTR = opts.rTR * mapScale;
        var rBR = opts.rBR * mapScale, rBL = opts.rBL * mapScale;

        // Rim light direction (matches article's "Specular Angle: -60deg")
        var lightAngle = -60 * Math.PI / 180;
        var lightDir = { x: Math.cos(lightAngle), y: Math.sin(lightAngle), z: 0.65 };
        var lLen = Math.hypot(lightDir.x, lightDir.y, lightDir.z);
        lightDir.x /= lLen; lightDir.y /= lLen; lightDir.z /= lLen;

        var eps = 0.75;
        for (var y = 0; y < mh; y++) {
            for (var x = 0; x < mw; x++) {
                var d = roundedRectDistance(x + 0.5, y + 0.5, cx, cy, hw, hh, rTL, rTR, rBR, rBL);
                var idx = (y * mw + x) * 4;

                if (d <= 0 || bezel <= 0.001) {
                    // Outside the shape or degenerate bezel: no displacement
                    dImg.data[idx] = 128; dImg.data[idx + 1] = 128; dImg.data[idx + 2] = 128; dImg.data[idx + 3] = 255;
                    sImg.data[idx] = 255; sImg.data[idx + 1] = 255; sImg.data[idx + 2] = 255; sImg.data[idx + 3] = 0;
                    continue;
                }

                // Inward direction = gradient of the SDF (it increases toward the center)
                var dxp = roundedRectDistance(x + 0.5 + eps, y + 0.5, cx, cy, hw, hh, rTL, rTR, rBR, rBL);
                var dxm = roundedRectDistance(x + 0.5 - eps, y + 0.5, cx, cy, hw, hh, rTL, rTR, rBR, rBL);
                var dyp = roundedRectDistance(x + 0.5, y + 0.5 + eps, cx, cy, hw, hh, rTL, rTR, rBR, rBL);
                var dym = roundedRectDistance(x + 0.5, y + 0.5 - eps, cx, cy, hw, hh, rTL, rTR, rBR, rBL);
                var gx = (dxp - dxm) / (2 * eps);
                var gy = (dyp - dym) / (2 * eps);
                var gLen = Math.hypot(gx, gy) || 1;
                var inX = gx / gLen, inY = gy / gLen;

                var s = Math.min(1, d / bezel);
                var mag = sampleProfile(profile, s); // px, in downsampled space

                var vx = inX * mag;
                var vy = inY * mag;

                var nx = 128 + Math.round((vx / maxAbs) * 127);
                var ny = 128 + Math.round((vy / maxAbs) * 127);
                dImg.data[idx] = Math.min(255, Math.max(0, nx));
                dImg.data[idx + 1] = Math.min(255, Math.max(0, ny));
                dImg.data[idx + 2] = 128;
                dImg.data[idx + 3] = 255;

                // Specular rim: reconstruct the 3D surface normal from the
                // same slope used for refraction, then a simple N.L term.
                var s0b = Math.max(0, s - 0.01), s1b = Math.min(1, s + 0.01);
                var slope = (squircleHeight(s1b) - squircleHeight(s0b)) * thickness / Math.max(1e-6, (s1b - s0b) * bezel);
                var n3x = -slope * inX, n3y = -slope * inY, n3z = 1;
                var n3Len = Math.hypot(n3x, n3y, n3z) || 1;
                n3x /= n3Len; n3y /= n3Len; n3z /= n3Len;
                var ndotl = Math.max(0, n3x * lightDir.x + n3y * lightDir.y + n3z * lightDir.z);
                var rim = Math.pow(ndotl, 5) * Math.sin(Math.min(1, s * 2.2) * Math.PI); // bell curve near the edge
                var alpha = Math.min(255, Math.round(rim * 255 * opts.specular));
                sImg.data[idx] = 255; sImg.data[idx + 1] = 255; sImg.data[idx + 2] = 255; sImg.data[idx + 3] = alpha;
            }
        }

        dctx.putImageData(dImg, 0, 0);
        sctx.putImageData(sImg, 0, 0);

        return {
            dispUrl: dispCanvas.toDataURL('image/png'),
            specUrl: specCanvas.toDataURL('image/png'),
            maxDisplacementPx: maxAbs / mapScale, // rescale back to real px for feDisplacementMap `scale`
            width: W,
            height: H
        };
    }

    /* ─────────────────────────────────────────────
       Shared <svg> filter pool
    ───────────────────────────────────────────── */
    var defsRoot = null;
    function getDefsRoot() {
        if (defsRoot && document.body.contains(defsRoot)) return defsRoot;
        defsRoot = document.getElementById('lg-defs-root');
        if (!defsRoot) {
            defsRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            defsRoot.setAttribute('id', 'lg-defs-root');
            defsRoot.setAttribute('width', '0');
            defsRoot.setAttribute('height', '0');
            defsRoot.style.position = 'absolute';
            defsRoot.style.pointerEvents = 'none';
            document.body.appendChild(defsRoot);
        }
        return defsRoot;
    }

    var SVG_NS = 'http://www.w3.org/2000/svg';
    var XLINK_NS = 'http://www.w3.org/1999/xlink';

    function setHref(el, url) {
        el.setAttributeNS(XLINK_NS, 'xlink:href', url);
        el.setAttribute('href', url);
    }

    function ensureFilter(id, maps, opts) {
        var root = getDefsRoot();
        var existing = document.getElementById(id);
        if (existing) existing.remove();

        var filter = document.createElementNS(SVG_NS, 'filter');
        filter.setAttribute('id', id);
        filter.setAttribute('x', '-15%');
        filter.setAttribute('y', '-15%');
        filter.setAttribute('width', '130%');
        filter.setAttribute('height', '130%');
        filter.setAttribute('color-interpolation-filters', 'sRGB');
        filter.setAttribute('filterUnits', 'objectBoundingBox');
        filter.setAttribute('primitiveUnits', 'userSpaceOnUse');

        var dispImage = document.createElementNS(SVG_NS, 'feImage');
        setHref(dispImage, maps.dispUrl);
        dispImage.setAttribute('x', '0'); dispImage.setAttribute('y', '0');
        dispImage.setAttribute('width', String(maps.width));
        dispImage.setAttribute('height', String(maps.height));
        dispImage.setAttribute('preserveAspectRatio', 'none');
        dispImage.setAttribute('result', 'dispmap');
        filter.appendChild(dispImage);

        var specImage = document.createElementNS(SVG_NS, 'feImage');
        setHref(specImage, maps.specUrl);
        specImage.setAttribute('x', '0'); specImage.setAttribute('y', '0');
        specImage.setAttribute('width', String(maps.width));
        specImage.setAttribute('height', String(maps.height));
        specImage.setAttribute('preserveAspectRatio', 'none');
        specImage.setAttribute('result', 'specmap');
        filter.appendChild(specImage);

        var blur = document.createElementNS(SVG_NS, 'feGaussianBlur');
        blur.setAttribute('in', 'SourceGraphic');
        blur.setAttribute('stdDeviation', String(opts.blur));
        blur.setAttribute('result', 'blurred');
        filter.appendChild(blur);

        var displace = document.createElementNS(SVG_NS, 'feDisplacementMap');
        displace.setAttribute('in', 'blurred');
        displace.setAttribute('in2', 'dispmap');
        displace.setAttribute('scale', String(maps.maxDisplacementPx * opts.strength));
        displace.setAttribute('xChannelSelector', 'R');
        displace.setAttribute('yChannelSelector', 'G');
        displace.setAttribute('result', 'refracted');
        filter.appendChild(displace);

        var sat = document.createElementNS(SVG_NS, 'feColorMatrix');
        sat.setAttribute('in', 'refracted');
        sat.setAttribute('type', 'saturate');
        sat.setAttribute('values', String(opts.saturate));
        sat.setAttribute('result', 'saturated');
        filter.appendChild(sat);

        var blend = document.createElementNS(SVG_NS, 'feBlend');
        blend.setAttribute('in', 'specmap');
        blend.setAttribute('in2', 'saturated');
        blend.setAttribute('mode', 'screen');
        filter.appendChild(blend);

        root.appendChild(filter);
        return id;
    }

    /* ─────────────────────────────────────────────
       Public: per-element lifecycle
    ───────────────────────────────────────────── */
    var idCounter = 0;
    var mapCache = new Map(); // shape signature -> filter id (reuse identical shapes)
    var supportsBackdropUrl = (function () {
        try {
            return CSS && CSS.supports && CSS.supports('backdrop-filter', 'url(#a) blur(1px)');
        } catch (e) { return false; }
    })();

    function readOptions(el) {
        var cs = getComputedStyle(el);
        return {
            bezel: parseFloat(el.dataset.lgBezel) || 16,
            strength: parseFloat(el.dataset.lgStrength) || 1,
            specular: parseFloat(el.dataset.lgSpec) || 0.5,
            blur: parseFloat(el.dataset.lgBlur) || 6,
            saturate: parseFloat(el.dataset.lgSaturate) || 1.4,
            rTL: parseFloat(cs.borderTopLeftRadius) || 0,
            rTR: parseFloat(cs.borderTopRightRadius) || 0,
            rBR: parseFloat(cs.borderBottomRightRadius) || 0,
            rBL: parseFloat(cs.borderBottomLeftRadius) || 0
        };
    }

    function refresh(el) {
        if (!supportsBackdropUrl) return; // CSS var() fallback already handles this case
        var rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return; // hidden / not laid out yet

        var opts = readOptions(el);
        opts.width = rect.width;
        opts.height = rect.height;

        var sig = [
            Math.round(rect.width), Math.round(rect.height),
            Math.round(opts.rTL), Math.round(opts.rTR), Math.round(opts.rBR), Math.round(opts.rBL),
            opts.bezel, opts.strength, opts.specular, opts.blur, opts.saturate
        ].join('_');

        var cachedId = mapCache.get(sig);
        if (cachedId) {
            el.style.setProperty('--lg-url', 'url(#' + cachedId + ')');
            return;
        }

        var maps = buildMaps(opts);
        var id = 'lg-filter-' + (idCounter++);
        ensureFilter(id, maps, opts);
        mapCache.set(sig, id);
        el.style.setProperty('--lg-url', 'url(#' + id + ')');
    }

    var pending = new Set();
    var rafScheduled = false;
    function scheduleRefresh(el) {
        pending.add(el);
        if (rafScheduled) return;
        rafScheduled = true;
        requestAnimationFrame(function () {
            rafScheduled = false;
            var els = Array.from(pending);
            pending.clear();
            els.forEach(refresh);
        });
    }

    var ro = ('ResizeObserver' in window)
        ? new ResizeObserver(function (entries) {
            entries.forEach(function (entry) { scheduleRefresh(entry.target); });
        })
        : null;

    function observe(el) {
        if (el.__lgObserved) return;
        el.__lgObserved = true;
        scheduleRefresh(el);
        if (ro) ro.observe(el);
    }

    function scanAndObserve(root) {
        var nodes = root.querySelectorAll ? root.querySelectorAll('[data-lg]') : [];
        nodes.forEach ? nodes.forEach(observe) : Array.prototype.forEach.call(nodes, observe);
    }

    function init() {
        scanAndObserve(document);
        // Watch for glass surfaces added/shown later (modals, dynamic panels)
        var mo = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes && m.addedNodes.forEach(function (node) {
                    if (node.nodeType !== 1) return;
                    if (node.hasAttribute && node.hasAttribute('data-lg')) observe(node);
                    if (node.querySelectorAll) scanAndObserve(node);
                });
            });
        });
        mo.observe(document.body, { childList: true, subtree: true });

        window.addEventListener('orientationchange', function () {
            pending.clear();
            document.querySelectorAll('[data-lg]').forEach(scheduleRefresh);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.LiquidGlass = { refresh: refresh, observe: observe, scan: scanAndObserve };
})();
