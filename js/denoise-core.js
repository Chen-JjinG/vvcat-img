/**
 * denoise-core.js
 * Client-side color-blotch / chroma-noise removal for AI-generated images.
 * Works in a Worker or on the main thread (and in Node for tests).
 *
 * Pipeline:
 *   1. sRGB -> Lab
 *   2. Detect small isolated blotches (especially lighter / hue-shifted patches)
 *      via morphological opening/closing + a small median residual.
 *   3. Connected components on *strong* outliers only (avoids merging the
 *      whole skin field), then grow into weaker residuals.
 *   4. Inpaint each blotch from the robust color of its exterior ring.
 *   5. Cel / flat-fill pass (default on): structure-aware region flatten in
 *      low *structure* gradient regions (gradient of a median-filtered L,
 *      so skin speckles are not treated as edges). Large flat fills such
 *      as anime skin collapse toward the local dominant color.
 *   6. Seal skin fills to nearby ink (close the light AA seam) and fill
 *      light holes that sit on dark strokes.
 *   7. Guided filter: stronger on chroma than luma, weighted by structure edges.
 *   8. Ink-side-only unsharp on structural edges (never lighten a bright fringe).
 *   9. Palette-first cleanup (v7, default with 纯净平涂): estimate the
 *      image's small set of intentional cel flats, snap near-white paper
 *      / stripe / sclera / shoe-body interiors to pure white, near-black
 *      ink to solid ink, and mottled interiors to each region's dominant
 *      flat. A pixel that sits between ink and a colored fill must NEVER
 *      snap to pure white (that punched the v6 white rim around lineart);
 *      those fringes go to the adjacent fill or stay a short ink↔fill AA.
 *      Ink black stays distinct from dark hair/pants fills. Distinct flats
 *      (vest stripes, skin vs sclera, iris midtones, shoe gray) are not merged.
 */
(function (root) {
  "use strict";

  var LIN = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function rgbToLab(data, w, h, L, A, B, alpha) {
    var n = w * h;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      var r = LIN[data[o]];
      var g = LIN[data[o + 1]];
      var b = LIN[data[o + 2]];
      if (alpha) alpha[i] = data[o + 3];
      var x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
      var y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
      var z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
      x /= 0.95047;
      z /= 1.08883;
      var fx = x > 0.008856 ? Math.cbrt(x) : 7.787037 * x + 16 / 116;
      var fy = y > 0.008856 ? Math.cbrt(y) : 7.787037 * y + 16 / 116;
      var fz = z > 0.008856 ? Math.cbrt(z) : 7.787037 * z + 16 / 116;
      L[i] = 116 * fy - 16;
      A[i] = 500 * (fx - fy);
      B[i] = 200 * (fy - fz);
    }
  }

  function labToRgbInto(L, A, B, alpha, w, h, out, mask) {
    var n = w * h;
    for (var i = 0; i < n; i++) {
      if (mask && mask[i] === 0) continue;
      var fy = (L[i] + 16) / 116;
      var fx = fy + A[i] / 500;
      var fz = fy - B[i] / 200;
      var x = fx > 0.2068966 ? fx * fx * fx : (fx - 16 / 116) / 7.787037;
      var y = fy > 0.2068966 ? fy * fy * fy : (fy - 16 / 116) / 7.787037;
      var z = fz > 0.2068966 ? fz * fz * fz : (fz - 16 / 116) / 7.787037;
      x *= 0.95047;
      z *= 1.08883;
      var r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
      var g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
      var b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
      r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(Math.max(r, 0), 1 / 2.4) - 0.055;
      g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(Math.max(g, 0), 1 / 2.4) - 0.055;
      b = b <= 0.0031308 ? 12.92 * b : 1.055 * Math.pow(Math.max(b, 0), 1 / 2.4) - 0.055;
      var o = i * 4;
      if (mask && mask[i] < 255) {
        var t = mask[i] / 255;
        out[o] = Math.round(out[o] * (1 - t) + clamp(r, 0, 1) * 255 * t);
        out[o + 1] = Math.round(out[o + 1] * (1 - t) + clamp(g, 0, 1) * 255 * t);
        out[o + 2] = Math.round(out[o + 2] * (1 - t) + clamp(b, 0, 1) * 255 * t);
      } else {
        out[o] = Math.round(clamp(r, 0, 1) * 255);
        out[o + 1] = Math.round(clamp(g, 0, 1) * 255);
        out[o + 2] = Math.round(clamp(b, 0, 1) * 255);
      }
      if (alpha) out[o + 3] = alpha[i];
    }
  }

  /* ---- integral / box / guided ---- */

  function integral(src, w, h) {
    var ii = new Float64Array((w + 1) * (h + 1));
    var row, x, y, s;
    for (y = 0; y < h; y++) {
      row = 0;
      for (x = 0; x < w; x++) {
        row += src[y * w + x];
        ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + row;
      }
    }
    return ii;
  }

  function boxMean(src, w, h, r, out, ii) {
    if (!ii) ii = integral(src, w, h);
    if (!out) out = new Float32Array(w * h);
    var x, y, x0, x1, y0, y1, sum, cnt;
    var stride = w + 1;
    for (y = 0; y < h; y++) {
      y0 = y - r;
      if (y0 < 0) y0 = 0;
      y1 = y + r + 1;
      if (y1 > h) y1 = h;
      for (x = 0; x < w; x++) {
        x0 = x - r;
        if (x0 < 0) x0 = 0;
        x1 = x + r + 1;
        if (x1 > w) x1 = w;
        sum =
          ii[y1 * stride + x1] -
          ii[y0 * stride + x1] -
          ii[y1 * stride + x0] +
          ii[y0 * stride + x0];
        cnt = (y1 - y0) * (x1 - x0);
        out[y * w + x] = sum / cnt;
      }
    }
    return out;
  }

  function guidedFilter(I, G, w, h, r, eps, tmp) {
    var meanI = boxMean(I, w, h, r);
    var meanG = boxMean(G, w, h, r);
    var n = w * h;
    var IG = tmp && tmp.IG ? tmp.IG : new Float32Array(n);
    var GG = tmp && tmp.GG ? tmp.GG : new Float32Array(n);
    var i;
    for (i = 0; i < n; i++) {
      IG[i] = I[i] * G[i];
      GG[i] = G[i] * G[i];
    }
    var meanIG = boxMean(IG, w, h, r);
    var meanGG = boxMean(GG, w, h, r);
    var Aa = tmp && tmp.Aa ? tmp.Aa : new Float32Array(n);
    var Bb = tmp && tmp.Bb ? tmp.Bb : new Float32Array(n);
    for (i = 0; i < n; i++) {
      var varG = meanGG[i] - meanG[i] * meanG[i];
      Aa[i] = (meanIG[i] - meanI[i] * meanG[i]) / (varG + eps);
      Bb[i] = meanI[i] - Aa[i] * meanG[i];
    }
    var meanA = boxMean(Aa, w, h, r);
    var meanB = boxMean(Bb, w, h, r);
    var out = new Float32Array(n);
    for (i = 0; i < n; i++) out[i] = meanA[i] * G[i] + meanB[i];
    return out;
  }

  /* ---- separable min/max (rectangular SE) via sliding-window deque ---- */

  function slidingExtrema1D(src, dst, len, stride, start, r, isMin) {
    var deq = new Int32Array(len + 2);
    var head = 0,
      tail = 0;
    function val(i) {
      return src[start + i * stride];
    }
    function better(a, b) {
      return isMin ? a < b : a > b;
    }
    var i, j, left;
    for (i = 0; i < len; i++) {
      while (head < tail && better(val(i), val(deq[tail - 1]))) tail--;
      deq[tail++] = i;
      left = i - 2 * r;
      if (head < tail && deq[head] <= left) head++;
      j = i - r;
      if (j >= 0) {
        var k = deq[head];
        if (k < 0) k = 0;
        dst[start + j * stride] = val(k);
      }
    }
    for (j = len - r; j < len; j++) {
      left = j - r - 1;
      if (head < tail && deq[head] <= left) head++;
      dst[start + j * stride] = val(deq[head]);
    }
  }

  function extremaFilter(src, w, h, r, isMin, tmp) {
    var tmp1 = tmp || new Float32Array(w * h);
    var out = new Float32Array(w * h);
    var x, y;
    for (y = 0; y < h; y++) slidingExtrema1D(src, tmp1, w, 1, y * w, r, isMin);
    for (x = 0; x < w; x++) slidingExtrema1D(tmp1, out, h, w, x, r, isMin);
    return out;
  }

  function minFilter(src, w, h, r, tmp) {
    return extremaFilter(src, w, h, r, true, tmp);
  }
  function maxFilter(src, w, h, r, tmp) {
    return extremaFilter(src, w, h, r, false, tmp);
  }

  /* ---- small-window median (r = 1 or 2) ---- */

  function medianFilter(src, w, h, r) {
    var out = new Float32Array(w * h);
    var size = (2 * r + 1) * (2 * r + 1);
    var buf = new Float32Array(size);
    var x, y, dx, dy, sx, sy, n, k, mid, p, t, j;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        n = 0;
        for (dy = -r; dy <= r; dy++) {
          sy = y + dy;
          if (sy < 0) sy = 0;
          else if (sy >= h) sy = h - 1;
          for (dx = -r; dx <= r; dx++) {
            sx = x + dx;
            if (sx < 0) sx = 0;
            else if (sx >= w) sx = w - 1;
            buf[n++] = src[sy * w + sx];
          }
        }
        /* insertion sort is fine for 9–25 values */
        for (k = 1; k < n; k++) {
          t = buf[k];
          j = k;
          while (j > 0 && buf[j - 1] > t) {
            buf[j] = buf[j - 1];
            j--;
          }
          buf[j] = t;
        }
        out[y * w + x] = buf[(n - 1) >> 1];
      }
    }
    return out;
  }

  /* ---- connected components on a binary Uint8 mask, 8-connected ---- */

  function labelComponents(flag, w, h, maxSize, acceptFn) {
    var n = w * h;
    var seen = new Uint8Array(n);
    var keep = new Uint8Array(n);
    var stack = new Int32Array(n);
    var comp = new Int32Array(n);
    var i, k, sp, cs, x, y, nx, ny, ni, a, meanD;
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
    for (i = 0; i < n; i++) {
      if (!flag[i] || seen[i]) continue;
      sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      cs = 0;
      while (sp) {
        k = stack[--sp];
        comp[cs++] = k;
        y = (k / w) | 0;
        x = k - y * w;
        for (a = 0; a < 16; a += 2) {
          nx = x + dirs[a];
          ny = y + dirs[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (flag[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack[sp++] = ni;
          }
        }
      }
      if (cs <= maxSize && (!acceptFn || acceptFn(comp, cs))) {
        for (a = 0; a < cs; a++) keep[comp[a]] = 1;
      }
    }
    return keep;
  }

  function growInto(seed, allow, w, h, steps) {
    var n = w * h;
    var out = new Uint8Array(n);
    out.set(seed);
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
    var x, y, i, a, nx, ny, ni, s;
    var frontier = [];
    for (i = 0; i < n; i++) if (out[i]) frontier.push(i);
    for (s = 0; s < steps; s++) {
      var next = [];
      for (var fi = 0; fi < frontier.length; fi++) {
        i = frontier[fi];
        y = (i / w) | 0;
        x = i - y * w;
        for (a = 0; a < 16; a += 2) {
          nx = x + dirs[a];
          ny = y + dirs[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (!out[ni] && allow[ni]) {
            out[ni] = 1;
            next.push(ni);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  function dilate1(mask, w, h, blocked) {
    var n = w * h;
    var out = new Uint8Array(n);
    out.set(mask);
    var x, y, i, a, nx, ny, ni;
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
    for (i = 0; i < n; i++) {
      if (!mask[i]) continue;
      y = (i / w) | 0;
      x = i - y * w;
      for (a = 0; a < 8; a += 2) {
        nx = x + dirs[a];
        ny = y + dirs[a + 1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        ni = ny * w + nx;
        if (blocked && blocked[ni]) continue;
        out[ni] = 1;
      }
    }
    return out;
  }

  function inpaintExterior(L, A, B, blotch, blocked, w, h) {
    var n = w * h;
    var outL = new Float32Array(L);
    var outA = new Float32Array(A);
    var outB = new Float32Array(B);
    var seen = new Uint8Array(n);
    var stack = new Int32Array(n);
    var comp = new Int32Array(n);
    var dirs8 = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
    /* slightly larger ring for stable color */
    var ring = [1, 0, -1, 0, 0, 1, 0, -1, 2, 0, -2, 0, 0, 2, 0, -2, 1, 1, 1, -1, -1, 1, -1, -1, 3, 0, -3, 0, 0, 3, 0, -3, 2, 1, 2, -1, -2, 1, -2, -1, 1, 2, 1, -2, -1, 2, -1, -2];
    var i, k, sp, cs, x, y, a, nx, ny, ni, sL, sA, sB, cnt, t, j;
    var bufL = new Float32Array(4096);
    var bufA = new Float32Array(4096);
    var bufB = new Float32Array(4096);

    function medianOf(buf, cnt) {
      var k, j, t;
      var tmp = buf.subarray ? Array.prototype.slice.call(buf, 0, cnt) : buf;
      /* copy to a sortable plain array of exact length */
      var arr = new Float32Array(cnt);
      for (k = 0; k < cnt; k++) arr[k] = buf[k];
      for (k = 1; k < cnt; k++) {
        t = arr[k];
        j = k;
        while (j > 0 && arr[j - 1] > t) {
          arr[j] = arr[j - 1];
          j--;
        }
        arr[j] = t;
      }
      return arr[(cnt - 1) >> 1];
    }

    function gather(useBlocked) {
      var cnt = 0;
      for (var c = 0; c < cs; c++) {
        var p = comp[c];
        var yy = (p / w) | 0;
        var xx = p - yy * w;
        for (var ri = 0; ri < ring.length; ri += 2) {
          var rx = xx + ring[ri];
          var ry = yy + ring[ri + 1];
          if (rx < 0 || ry < 0 || rx >= w || ry >= h) continue;
          var rni = ry * w + rx;
          if (blotch[rni]) continue;
          if (!useBlocked && blocked && blocked[rni]) continue;
          if (cnt < 4096) {
            bufL[cnt] = L[rni];
            bufA[cnt] = A[rni];
            bufB[cnt] = B[rni];
            cnt++;
          }
        }
      }
      return cnt;
    }

    for (i = 0; i < n; i++) {
      if (!blotch[i] || seen[i]) continue;
      sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      cs = 0;
      while (sp) {
        k = stack[--sp];
        comp[cs++] = k;
        y = (k / w) | 0;
        x = k - y * w;
        for (a = 0; a < 16; a += 2) {
          nx = x + dirs8[a];
          ny = y + dirs8[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (blotch[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack[sp++] = ni;
          }
        }
      }
      cnt = gather(false);
      if (cnt < 5) cnt = gather(true);
      if (cnt < 1) continue;
      sL = medianOf(bufL, cnt);
      sA = medianOf(bufA, cnt);
      sB = medianOf(bufB, cnt);
      for (a = 0; a < cs; a++) {
        ni = comp[a];
        /* do not lighten confirmed dark edge pixels (protects lineart) */
        if (blocked && blocked[ni] && sL > L[ni] + 4) continue;
        outL[ni] = sL;
        outA[ni] = sA;
        outB[ni] = sB;
      }
    }
    return { L: outL, A: outA, B: outB };
  }

  function copyChannel(src) {
    var o = new Float32Array(src.length);
    o.set(src);
    return o;
  }

  function rectSum(ii, stride, x0, y0, x1, y1) {
    return (
      ii[y1 * stride + x1] -
      ii[y0 * stride + x1] -
      ii[y1 * stride + x0] +
      ii[y0 * stride + x0]
    );
  }

  /* Classic 4-quadrant Kuwahara in Lab, O(1) per pixel via integral images. */
  function kuwaharaLab(L, A, B, w, h, r) {
    if (r < 1) r = 1;
    var n = w * h;
    var iL = integral(L, w, h);
    var iA = integral(A, w, h);
    var iB = integral(B, w, h);
    var L2 = new Float32Array(n);
    var A2 = new Float32Array(n);
    var B2 = new Float32Array(n);
    var i;
    for (i = 0; i < n; i++) {
      L2[i] = L[i] * L[i];
      A2[i] = A[i] * A[i];
      B2[i] = B[i] * B[i];
    }
    var iL2 = integral(L2, w, h);
    var iA2 = integral(A2, w, h);
    var iB2 = integral(B2, w, h);
    var outL = new Float32Array(n);
    var outA = new Float32Array(n);
    var outB = new Float32Array(n);
    var stride = w + 1;
    var x, y, q, bestV, bL, bA, bB;
    var x0, y0, x1, y1, cnt, sL, sA, sB, sL2, sA2, sB2, mL, mA, mB, v;

    function consider(qx0, qy0, qx1, qy1) {
      x0 = qx0 < 0 ? 0 : qx0;
      y0 = qy0 < 0 ? 0 : qy0;
      x1 = qx1 > w ? w : qx1;
      y1 = qy1 > h ? h : qy1;
      cnt = (x1 - x0) * (y1 - y0);
      if (cnt < 1) return;
      sL = rectSum(iL, stride, x0, y0, x1, y1);
      sA = rectSum(iA, stride, x0, y0, x1, y1);
      sB = rectSum(iB, stride, x0, y0, x1, y1);
      sL2 = rectSum(iL2, stride, x0, y0, x1, y1);
      sA2 = rectSum(iA2, stride, x0, y0, x1, y1);
      sB2 = rectSum(iB2, stride, x0, y0, x1, y1);
      mL = sL / cnt;
      mA = sA / cnt;
      mB = sB / cnt;
      v = sL2 / cnt - mL * mL + (sA2 / cnt - mA * mA) + (sB2 / cnt - mB * mB);
      if (v < bestV) {
        bestV = v;
        bL = mL;
        bA = mA;
        bB = mB;
      }
    }

    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        bestV = 1e30;
        bL = L[y * w + x];
        bA = A[y * w + x];
        bB = B[y * w + x];
        consider(x - r, y - r, x + 1, y + 1);
        consider(x, y - r, x + r + 1, y + 1);
        consider(x - r, y, x + 1, y + r + 1);
        consider(x, y, x + r + 1, y + r + 1);
        i = y * w + x;
        outL[i] = bL;
        outA[i] = bA;
        outB[i] = bB;
      }
    }
    return { L: outL, A: outA, B: outB };
  }

  function gradientMag(ch, w, h) {
    var n = w * h;
    var g = new Float32Array(n);
    var x, y, i, gx, gy;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        gx = ch[y * w + (x < w - 1 ? x + 1 : x)] - ch[y * w + (x > 0 ? x - 1 : x)];
        gy = ch[(y < h - 1 ? y + 1 : y) * w + x] - ch[(y > 0 ? y - 1 : y) * w + x];
        g[i] = Math.sqrt(gx * gx + gy * gy) * 0.5;
      }
    }
    return g;
  }

  /**
   * Flatten each connected non-edge region to its trimmed-mean color.
   * Edge / protected pixels are left unchanged — this is what keeps lineart sharp.
   */
  function regionFlatten(L, A, B, protect, w, h, minSize, darkGentle, colorT, startable, coarse, coarseCap, filled, fillC) {
    var n = w * h;
    var seen = new Uint8Array(n);
    var stack = new Int32Array(n);
    var comp = new Int32Array(n);
    var bufL = new Float32Array(n);
    var bufA = new Float32Array(n);
    var bufB = new Float32Array(n);
    /* 4-connected, distance-to-SEED (not just neighbor). Neighbor-only
       floods walk across soft eyelid gradients into the sclera. */
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
    var ct2 = (colorT == null ? 9 : colorT);
    ct2 = ct2 * ct2;
    var i, k, sp, cs, x, y, a, nx, ny, ni, sL, sA, sB, mL, mA, mB, cnt2, dL, dA, dB;
    var seedL, seedA, seedB;
    for (i = 0; i < n; i++) {
      if (protect[i] || seen[i]) continue;
      if (startable && !startable[i]) continue;
      seedL = L[i];
      seedA = A[i];
      seedB = B[i];
      var seedC = coarse ? coarse[i] : 0;
      var cCapHi = coarseCap != null ? coarseCap : 2.0;
      var cCapLo = cCapHi + 1.5;
      sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      cs = 0;
      sL = sA = sB = 0;
      while (sp) {
        k = stack[--sp];
        comp[cs] = k;
        bufL[cs] = L[k];
        bufA[cs] = A[k];
        bufB[cs] = B[k];
        sL += L[k];
        sA += A[k];
        sB += B[k];
        cs++;
        y = (k / w) | 0;
        x = k - y * w;
        for (a = 0; a < 8; a += 2) {
          nx = x + dirs[a];
          ny = y + dirs[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (protect[ni] || seen[ni]) continue;
          dL = L[ni] - seedL;
          dA = A[ni] - seedA;
          dB = B[ni] - seedB;
          if (dL > 4.5 || dL < -6) continue;
          if (dL * dL + dA * dA + dB * dB > ct2) continue;
          /* Coarse-L cap: high-frequency speckles share the seed's
             box-smoothed L and may join, but a 15–30px eyelid ramp
             cannot, so the flood stops at the lid instead of the sclera. */
          if (coarse) {
            var dC = coarse[ni] - seedC;
            if (dC > cCapHi || dC < -cCapLo) continue;
          }
          seen[ni] = 1;
          stack[sp++] = ni;
        }
      }
      if (cs < minSize) continue;
      mL = sL / cs;
      mA = sA / cs;
      mB = sB / cs;
      /* trimmed mean: drop outliers (leftover speckles) */
      sL = sA = sB = 0;
      cnt2 = 0;
      for (a = 0; a < cs; a++) {
        dL = bufL[a] - mL;
        if (dL > 6 || dL < -8) continue;
        sL += bufL[a];
        sA += bufA[a];
        sB += bufB[a];
        cnt2++;
      }
      if (cnt2 >= 4) {
        mL = sL / cnt2;
        mA = sA / cnt2;
        mB = sB / cnt2;
      }
      var amt = 1;
      if (darkGentle && mL < 48) amt = 0.35;
      if (amt <= 0) continue;
      for (a = 0; a < cs; a++) {
        ni = comp[a];
        L[ni] = mL * amt + L[ni] * (1 - amt);
        A[ni] = mA * amt + A[ni] * (1 - amt);
        B[ni] = mB * amt + B[ni] * (1 - amt);
        if (filled && amt >= 0.99) {
          filled[ni] = 1;
          if (fillC) fillC[ni] = seedC;
        }
      }
    }
  }

  function labDist2(L, A, B, i, j) {
    var dL = L[i] - L[j];
    var dA = A[i] - A[j];
    var dB = B[i] - B[j];
    return dL * dL + dA * dA + dB * dB;
  }

  /**
   * Merge adjacent fully-flattened regions whose means are close,
   * so a cheek split into a few near-identical patches becomes one tone.
   */
  function mergeSimilarFills(L, A, B, filled, fillC, w, h, mergeT, coarseCap) {
    var n = w * h;
    var parent = new Int32Array(n);
    var i, k, x, y, a, nx, ny, ni, sp, cs;
    for (i = 0; i < n; i++) parent[i] = i;
    function find(a) {
      var r = a, t;
      while (parent[r] !== r) r = parent[r];
      while (parent[a] !== r) {
        t = parent[a];
        parent[a] = r;
        a = t;
      }
      return r;
    }
    function unite(a, b) {
      a = find(a);
      b = find(b);
      if (a !== b) parent[b] = a;
    }
    /* first: 4-connected components of filled pixels */
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
    for (i = 0; i < n; i++) {
      if (!filled[i]) continue;
      y = (i / w) | 0;
      x = i - y * w;
      if (x + 1 < w) {
        ni = i + 1;
        if (filled[ni]) unite(i, ni);
      }
      if (y + 1 < h) {
        ni = i + w;
        if (filled[ni]) unite(i, ni);
      }
    }
    var label = new Int32Array(n);
    var ids = [];
    var map = Object.create(null);
    var cid = 0;
    for (i = 0; i < n; i++) {
      if (!filled[i]) {
        label[i] = -1;
        continue;
      }
      k = find(i);
      if (map[k] == null) {
        map[k] = cid;
        ids.push(k);
        cid++;
      }
      label[i] = map[k];
    }
    if (cid === 0) return;
    var sL = new Float64Array(cid);
    var sA = new Float64Array(cid);
    var sB = new Float64Array(cid);
    var sC = new Float64Array(cid);
    var sz = new Int32Array(cid);
    for (i = 0; i < n; i++) {
      k = label[i];
      if (k < 0) continue;
      sL[k] += L[i];
      sA[k] += A[i];
      sB[k] += B[i];
      if (fillC) sC[k] += fillC[i];
      sz[k]++;
    }
    var mL = new Float32Array(cid);
    var mA = new Float32Array(cid);
    var mB = new Float32Array(cid);
    var mC = new Float32Array(cid);
    for (k = 0; k < cid; k++) {
      mL[k] = sL[k] / sz[k];
      mA[k] = sA[k] / sz[k];
      mB[k] = sB[k] / sz[k];
      mC[k] = sC[k] / sz[k];
    }
    /* union-find over components that touch and have close means */
    var cp = new Int32Array(cid);
    for (k = 0; k < cid; k++) cp[k] = k;
    function cfind(a) {
      var r = a, t;
      while (cp[r] !== r) r = cp[r];
      while (cp[a] !== r) {
        t = cp[a];
        cp[a] = r;
        a = t;
      }
      return r;
    }
    function cunite(a, b, sa, sb) {
      a = cfind(a);
      b = cfind(b);
      if (a === b) return;
      /* attach smaller to larger */
      if (sa < sb) {
        cp[a] = b;
      } else {
        cp[b] = a;
      }
    }
    var mt2 = mergeT * mergeT;
    var seenPair = Object.create(null);
    for (i = 0; i < n; i++) {
      k = label[i];
      if (k < 0) continue;
      y = (i / w) | 0;
      x = i - y * w;
      for (a = 0; a < 8; a += 2) {
        nx = x + dirs[a];
        ny = y + dirs[a + 1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        ni = ny * w + nx;
        var k2 = label[ni];
        if (k2 < 0 || k2 === k) continue;
        var key = k < k2 ? k + "," + k2 : k2 + "," + k;
        if (seenPair[key]) continue;
        seenPair[key] = 1;
        var dL = mL[k] - mL[k2];
        var dA = mA[k] - mA[k2];
        var dB = mB[k] - mB[k2];
        if (dL * dL + dA * dA + dB * dB > mt2) continue;
        /* do not merge across a coarse-L ramp (sclera / eyelid / cheek) */
        var capC = coarseCap != null ? coarseCap : 2.0;
        var dC = mC[k] - mC[k2];
        if (dC > capC || dC < -capC) continue;
        cunite(k, k2, sz[k], sz[k2]);
      }
    }
    /* means of merged groups, weighted by size */
    var gL = new Float64Array(cid);
    var gA = new Float64Array(cid);
    var gB = new Float64Array(cid);
    var gC = new Float64Array(cid);
    var gS = new Float64Array(cid);
    for (k = 0; k < cid; k++) {
      var r = cfind(k);
      gL[r] += mL[k] * sz[k];
      gA[r] += mA[k] * sz[k];
      gB[r] += mB[k] * sz[k];
      gC[r] += mC[k] * sz[k];
      gS[r] += sz[k];
    }
    for (k = 0; k < cid; k++) {
      var r = cfind(k);
      if (gS[r] <= 0) continue;
      var tL = gL[r] / gS[r];
      var tA = gA[r] / gS[r];
      var tB = gB[r] / gS[r];
      var tC = gC[r] / gS[r];
      mL[k] = tL;
      mA[k] = tA;
      mB[k] = tB;
      mC[k] = tC;
    }
    for (i = 0; i < n; i++) {
      k = label[i];
      if (k < 0) continue;
      var r = cfind(k);
      L[i] = mL[r];
      A[i] = mA[r];
      B[i] = mB[r];
      if (fillC) fillC[i] = mC[r];
    }
  }

  /**
   * Grow a solid fill into leftover similar pixels, including the light
   * (skin-side) AA ring around lineart. Never grow into dark ink, ink-side
   * AA, or across a coarse-L eyelid ramp.
   */
  function growFlatFill(L, A, B, protect, filled, fillC, L0, coarse, w, h, colorT, coarseCap, lSkin) {
    var n = w * h;
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
    var q = new Int32Array(n);
    var head = 0, tail = 0;
    var i, k, x, y, a, nx, ny, ni, dL, dA, dB, dC;
    var ct2 = colorT * colorT;
    var cHi = coarseCap != null ? coarseCap : 2.0;
    /* Allow growing into slightly darker shade (mouth/nose shadow) but
       never toward lighter sclera/lid. fillC is the region origin, so
       this cannot walk a ramp. */
    var cLo = cHi + 2.0;
    if (lSkin == null) lSkin = 64;
    for (i = 0; i < n; i++) {
      if (filled[i]) q[tail++] = i;
    }
    while (head < tail) {
      k = q[head++];
      y = (k / w) | 0;
      x = k - y * w;
      for (a = 0; a < 16; a += 2) {
        nx = x + dirs[a];
        ny = y + dirs[a + 1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        ni = ny * w + nx;
        if (filled[ni]) continue;
        if (L0[ni] < 55) continue;
        if (protect[ni] && L0[ni] < lSkin) continue;
        dL = L[ni] - L[k];
        dA = A[ni] - A[k];
        dB = B[ni] - B[k];
        if (dL * dL + dA * dA + dB * dB > ct2) continue;
        if (coarse && fillC) {
          dC = coarse[ni] - fillC[k];
          if (dC > cHi || dC < -cLo) continue;
        }
        L[ni] = L[k];
        A[ni] = A[k];
        B[ni] = B[k];
        filled[ni] = 1;
        if (fillC) fillC[ni] = fillC[k];
        q[tail++] = ni;
      }
    }
  }

  /**
   * Absorb small leftover islands completely surrounded (or mostly
   * bordered) by one already-flat fill, if they pass the coarse-L cap.
   */
  function absorbEnclosed(L, A, B, protect, filled, fillC, L0, coarse, w, h, coarseCap, maxSize) {
    var n = w * h;
    var seen = new Uint8Array(n);
    var stack = new Int32Array(n);
    var comp = new Int32Array(n);
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
    var capC = coarseCap != null ? coarseCap : 2.0;
    var cHi = capC;
    var cLo = capC + 2.0;
    if (maxSize == null) maxSize = 80;
    var i, k, sp, cs, x, y, a, nx, ny, ni, bL, bA, bB, bC, bN, bHits, ok;
    for (i = 0; i < n; i++) {
      if (seen[i] || filled[i] || protect[i] || L0[i] < 55) continue;
      sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      cs = 0;
      bL = bA = bB = bC = bN = 0;
      bHits = 1;
      ok = 1;
      while (sp) {
        k = stack[--sp];
        comp[cs++] = k;
        if (cs > maxSize) { ok = 0; break; }
        y = (k / w) | 0;
        x = k - y * w;
        for (a = 0; a < 8; a += 2) {
          nx = x + dirs[a];
          ny = y + dirs[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (filled[ni]) {
            if (coarse && fillC) {
              var dC = coarse[k] - fillC[ni];
              if (dC > cHi || dC < -cLo) { bHits = 0; continue; }
            }
            if (bN === 0) {
              bL = L[ni]; bA = A[ni]; bB = B[ni]; bC = fillC ? fillC[ni] : 0;
            } else {
              var dL = L[ni] - bL, dA = A[ni] - bA, dB2 = B[ni] - bB;
              if (dL * dL + dA * dA + dB2 * dB2 > 9) bHits = 0;
            }
            bN++;
            continue;
          }
          if (seen[ni] || protect[ni] || L0[ni] < 55) continue;
          seen[ni] = 1;
          stack[sp++] = ni;
        }
      }
      /* drain rest so seen stays consistent if we overflowed */
      while (sp) seen[stack[--sp]] = 0;
      if (!ok || cs < 1 || bN < 4 || !bHits) continue;
      /* require a reasonable fraction of the island to border the fill */
      if (bN < cs * 0.25 && bN < 6) continue;
      for (a = 0; a < cs; a++) {
        ni = comp[a];
        if (coarse && fillC) {
          var dC2 = coarse[ni] - bC;
          if (dC2 > cHi || dC2 < -cLo) continue;
        }
        L[ni] = bL;
        A[ni] = bA;
        B[ni] = bB;
        filled[ni] = 1;
        if (fillC) fillC[ni] = bC;
      }
    }
  }

  /**
   * Snap leftover isolated speckles to the majority already-flat color
   * in a 5x5 window (catches faint dots the blotch pass missed).
   */
  function snapSpeckles(L, A, B, protect, filled, fillC, L0, coarse, w, h, coarseCap) {
    var n = w * h;
    var i, x, y, dx, dy, sx, sy, ni, cnt, sL, sA, sB, sC, dL, dA, dB, dC;
    var nL = new Float32Array(n);
    var nA = new Float32Array(n);
    var nB = new Float32Array(n);
    var nC = new Float32Array(n);
    var hit = new Uint8Array(n);
    var capC = coarseCap != null ? coarseCap : 2.0;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (filled[i] || protect[i] || L0[i] < 55) continue;
        cnt = 0;
        sL = sA = sB = sC = 0;
        for (dy = -2; dy <= 2; dy++) {
          sy = y + dy;
          if (sy < 0 || sy >= h) continue;
          for (dx = -2; dx <= 2; dx++) {
            sx = x + dx;
            if (sx < 0 || sx >= w) continue;
            ni = sy * w + sx;
            if (!filled[ni]) continue;
            dL = L[i] - L[ni];
            dA = A[i] - A[ni];
            dB = B[i] - B[ni];
            if (dL * dL + dA * dA + dB * dB > 81) continue; /* Lab dist > 9 */
            if (coarse && fillC) {
              dC = coarse[i] - fillC[ni];
              if (dC > capC || dC < -capC) continue;
            }
            sL += L[ni];
            sA += A[ni];
            sB += B[ni];
            if (fillC) sC += fillC[ni];
            cnt++;
          }
        }
        if (cnt >= 10) {
          nL[i] = sL / cnt;
          nA[i] = sA / cnt;
          nB[i] = sB / cnt;
          nC[i] = sC / cnt;
          hit[i] = 1;
        }
      }
    }
    for (i = 0; i < n; i++) {
      if (!hit[i]) continue;
      L[i] = nL[i];
      A[i] = nA[i];
      B[i] = nB[i];
      if (fillC) fillC[i] = nC[i];
      filled[i] = 1;
    }
  }

  /**
   * Chessboard (Chebyshev) distance to the nearest set mask pixel, capped.
   */
  function chessboardDist(mask, w, h, cap) {
    var n = w * h;
    var INF = cap != null ? cap + 1 : 255;
    var d = new Uint8Array(n);
    var i, x, y, v;
    for (i = 0; i < n; i++) d[i] = mask[i] ? 0 : INF;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        v = d[i];
        if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
        if (y > 0 && d[i - w] + 1 < v) v = d[i - w] + 1;
        if (x > 0 && y > 0 && d[i - w - 1] + 1 < v) v = d[i - w - 1] + 1;
        if (x + 1 < w && y > 0 && d[i - w + 1] + 1 < v) v = d[i - w + 1] + 1;
        d[i] = v;
      }
    }
    for (y = h - 1; y >= 0; y--) {
      for (x = w - 1; x >= 0; x--) {
        i = y * w + x;
        v = d[i];
        if (x + 1 < w && d[i + 1] + 1 < v) v = d[i + 1] + 1;
        if (y + 1 < h && d[i + w] + 1 < v) v = d[i + w] + 1;
        if (x + 1 < w && y + 1 < h && d[i + w + 1] + 1 < v) v = d[i + w + 1] + 1;
        if (x > 0 && y + 1 < h && d[i + w - 1] + 1 < v) v = d[i + w - 1] + 1;
        d[i] = v;
      }
    }
    return d;
  }

  /**
   * Fill light crumbs / notches that sit on dark lineart with the surrounding
   * ink color. Only tiny light islands (small connected non-ink components)
   * are filled, so iris midtones, catchlights, sclera, and skin-side AA are
   * left alone.
   */
  function fillInkHoles(L, A, B, L0, A0, B0, w, h) {
    var n = w * h;
    var i, y, x, a, nx, ny, ni, k, sp, cs, ok, bN, dMed;
    /* 4-connected components of non-ink; only tiny ones can be holes */
    var label = new Int32Array(n);
    for (i = 0; i < n; i++) label[i] = -1;
    var stack = new Int32Array(n);
    var comp = new Int32Array(n);
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
    var maxHole = 12;
    var cid = 0;
    var sizeOf = [];
    var inkBorderOf = [];
    for (i = 0; i < n; i++) {
      if (label[i] >= 0 || L0[i] < 32) continue;
      sp = 0;
      stack[sp++] = i;
      label[i] = cid;
      cs = 0;
      ok = 1;
      bN = 0;
      while (sp) {
        k = stack[--sp];
        comp[cs++] = k;
        if (cs > maxHole) { ok = 0; break; }
        y = (k / w) | 0;
        x = k - y * w;
        for (a = 0; a < 8; a += 2) {
          nx = x + dirs[a];
          ny = y + dirs[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (L0[ni] < 32) { bN++; continue; }
          if (label[ni] >= 0) continue;
          label[ni] = cid;
          stack[sp++] = ni;
        }
      }
      /* drain if overflowed so leftover pixels get a later (large) id or skip */
      while (sp) {
        k = stack[--sp];
        label[k] = ok ? cid : 0x7fffffff;
      }
      if (!ok) {
        /* mark the rest of this large region so we do not restart it */
        /* BFS without size cap, label only */
        /* The overflowing stack was drained with a sentinel; flood from
           already-labelled cells of this cid via a second scan is heavy.
           Instead, continue a walk from neighbours of the partial comp. */
        var qh = 0, qt = 0;
        var q = stack;
        for (a = 0; a < cs; a++) q[qt++] = comp[a];
        while (qh < qt) {
          k = q[qh++];
          y = (k / w) | 0;
          x = k - y * w;
          for (a = 0; a < 8; a += 2) {
            nx = x + dirs[a];
            ny = y + dirs[a + 1];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            ni = ny * w + nx;
            if (L0[ni] < 32) continue;
            if (label[ni] >= 0 && label[ni] !== 0x7fffffff && label[ni] !== cid) continue;
            if (label[ni] === cid || label[ni] === 0x7fffffff) continue;
            /* unlabelled light */
            if (label[ni] >= 0) continue;
            label[ni] = 0x7fffffff;
            q[qt++] = ni;
          }
        }
        cid++;
        sizeOf[cid - 1] = 9999;
        inkBorderOf[cid - 1] = 0;
        continue;
      }
      sizeOf[cid] = cs;
      inkBorderOf[cid] = bN;
      cid++;
    }

    var bufL = new Float32Array(25);
    var bufA = new Float32Array(25);
    var bufB = new Float32Array(25);
    function medSmall(buf, cnt) {
      var t, j, arr = new Float32Array(cnt);
      var p;
      for (p = 0; p < cnt; p++) arr[p] = buf[p];
      for (p = 1; p < cnt; p++) {
        t = arr[p];
        j = p;
        while (j > 0 && arr[j - 1] > t) { arr[j] = arr[j - 1]; j--; }
        arr[j] = t;
      }
      return arr[(cnt - 1) >> 1];
    }

    for (i = 0; i < n; i++) {
      var lab = label[i];
      if (lab < 0 || lab === 0x7fffffff) continue;
      if (sizeOf[lab] < 1 || sizeOf[lab] > maxHole) continue;
      /* skip catchlights: tiny but very bright, or mixed with sclera-like light */
      if (L0[i] > 155 || L0[i] < 40) continue;
      /* must be a real hole: enough ink around the island */
      if (inkBorderOf[lab] < sizeOf[lab] * 1.2 && inkBorderOf[lab] < 6) continue;
      /* local ink median in 5x5 */
      y = (i / w) | 0;
      x = i - y * w;
      var cntD = 0, dy, dx, sy, sx;
      for (dy = -2; dy <= 2; dy++) {
        sy = y + dy;
        if (sy < 0 || sy >= h) continue;
        for (dx = -2; dx <= 2; dx++) {
          sx = x + dx;
          if (sx < 0 || sx >= w) continue;
          ni = sy * w + sx;
          if (L0[ni] < 32) {
            bufL[cntD] = L0[ni];
            bufA[cntD] = A0[ni];
            bufB[cntD] = B0[ni];
            cntD++;
          }
        }
      }
      if (cntD < 6) continue;
      dMed = medSmall(bufL, cntD);
      if (L[i] <= dMed + 8) continue;
      L[i] = dMed;
      A[i] = medSmall(bufA, cntD);
      B[i] = medSmall(bufB, cntD);
    }
  }

  /**
   * Close the light / white seam at the edge of a skin flat fill.
   * Only snaps the bright fringe and the very light end of the AA ring
   * (a few pixels) so the fill meets a natural ink-to-skin blend.
   * Does not march down the mid-gray ramp (that hard-cuts hair and lids).
   */
  function sealToInk(L, A, B, filled, fillC, L0, w, h, inkDist) {
    var n = w * h;
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
    var i, k, x, y, a, nx, ny, ni, Lf, Af, Bf, Cf, hits, chromaF, chromaP;
    var lSkin = 70;
    /* only consider pixels already close in lightness to the fill */
    var maxDarker = 2.5;
    var maxLighter = 14;
    var maxStepsDark = 2;
    /* bright / equal-L fringe may be wider than 2 px; mid-gray AA is not */
    var maxStepsLight = 6;

    function isSkinFringe(Li, Ai, Bi, Lf, Af, Bf, lightOnly) {
      if (Li < Lf - (lightOnly ? 0.8 : maxDarker)) return 0;
      if (Li > Lf + maxLighter) return 0;
      chromaF = Math.sqrt(Af * Af + Bf * Bf);
      chromaP = Math.sqrt(Ai * Ai + Bi * Bi);
      var dAB2 = (Ai - Af) * (Ai - Af) + (Bi - Bf) * (Bi - Bf);
      if (Li >= Lf - 1) {
        /* Accept anything v4 already accepted (C/Cf>=0.42, dAB<=9.5),
           plus paler peach fringes with strong hue alignment.
           Mid-lid C/Cf~0.18 cos~0.85; sclera C/Cf~0.04. */
        var cos = (chromaP * chromaF > 1e-6) ? (Ai * Af + Bi * Bf) / (chromaP * chromaF) : 0;
        var classic = chromaP >= chromaF * 0.42 && dAB2 <= 90;
        var pale = chromaP >= chromaF * 0.28 && cos >= 0.90 && dAB2 <= 121;
        if (chromaF > 4 && !classic && !pale) return 0;
      } else {
        if (chromaF > 4 && chromaP < chromaF * 0.42) return 0;
        if (dAB2 > 90) return 0;
      }
      return 1;
    }

    /* only grow from the pre-seal fill so mid-AA cannot become a new source */
    var seed = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      /* skin fills only — never grow a sclera fill into the eyelid */
      if (filled[i] && L[i] >= lSkin && (A[i] * A[i] + B[i] * B[i]) >= 36) seed[i] = 1;
    }

    var q = new Int32Array(n);
    var depth = new Int16Array(n);
    var head = 0, tail = 0;
    for (i = 0; i < n; i++) {
      if (!seed[i]) continue;
      q[tail++] = i;
      depth[i] = 0;
    }
    while (head < tail) {
      k = q[head++];
      if (depth[k] >= maxStepsLight) continue;
      y = (k / w) | 0;
      x = k - y * w;
      Lf = L[k];
      Af = A[k];
      Bf = B[k];
      for (a = 0; a < 16; a += 2) {
        nx = x + dirs[a];
        ny = y + dirs[a + 1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        ni = ny * w + nx;
        if (filled[ni]) continue;
        if (L0[ni] < 64) continue;
        var light = L[ni] >= Lf - 0.8;
        var nextD = depth[k] + 1;
        if (light) {
          if (nextD > maxStepsLight) continue;
        } else {
          if (nextD > maxStepsDark) continue;
        }
        if (!isSkinFringe(L[ni], A[ni], B[ni], Lf, Af, Bf, light)) continue;
        /* Close a bright / equal-L fringe for several steps; only take
           one or two steps into slightly darker AA. */
        L[ni] = Lf;
        A[ni] = Af;
        B[ni] = Bf;
        filled[ni] = 1;
        if (fillC) fillC[ni] = fillC[k];
        depth[ni] = nextD;
        q[tail++] = ni;
      }
    }
  }

  function chroma2(a, b) {
    return a * a + b * b;
  }

  function labDelta2(l1, a1, b1, l2, a2, b2) {
    var dL = l1 - l2;
    var dA = a1 - a2;
    var dB = b1 - b2;
    return dL * dL + dA * dA + dB * dB;
  }

  function labSegDist(l, a, b, c1, c2) {
    var vx = c2.L - c1.L, vy = c2.A - c1.A, vz = c2.B - c1.B;
    var wx = l - c1.L, wy = a - c1.A, wz = b - c1.B;
    var vv = vx * vx + vy * vy + vz * vz;
    var t = vv < 1e-8 ? 0 : (wx * vx + wy * vy + wz * vz) / vv;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var dx = wx - vx * t, dy = wy - vy * t, dz = wz - vz * t;
    return { d2: dx * dx + dy * dy + dz * dz, t: t };
  }

  function labToRgbBytes(l, a, b) {
    var fy = (l + 16) / 116;
    var fx = fy + a / 500;
    var fz = fy - b / 200;
    var x = fx > 0.2068966 ? fx * fx * fx : (fx - 16 / 116) / 7.787037;
    var y = fy > 0.2068966 ? fy * fy * fy : (fy - 16 / 116) / 7.787037;
    var z = fz > 0.2068966 ? fz * fz * fz : (fz - 16 / 116) / 7.787037;
    x *= 0.95047;
    z *= 1.08883;
    var r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    var g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
    var bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(Math.max(r, 0), 1 / 2.4) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(Math.max(g, 0), 1 / 2.4) - 0.055;
    bl = bl <= 0.0031308 ? 12.92 * bl : 1.055 * Math.pow(Math.max(bl, 0), 1 / 2.4) - 0.055;
    return [
      Math.round(clamp(r, 0, 1) * 255),
      Math.round(clamp(g, 0, 1) * 255),
      Math.round(clamp(bl, 0, 1) * 255)
    ];
  }

  function rgbBytesToLab(r, g, b) {
    var R = LIN[r];
    var G = LIN[g];
    var Bv = LIN[b];
    var x = (R * 0.4124564 + G * 0.3575761 + Bv * 0.1804375) / 0.95047;
    var y = R * 0.2126729 + G * 0.7151522 + Bv * 0.072175;
    var z = (R * 0.0193339 + G * 0.119192 + Bv * 0.9503041) / 1.08883;
    var fx = x > 0.008856 ? Math.cbrt(x) : 7.787037 * x + 16 / 116;
    var fy = y > 0.008856 ? Math.cbrt(y) : 7.787037 * y + 16 / 116;
    var fz = z > 0.008856 ? Math.cbrt(z) : 7.787037 * z + 16 / 116;
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function quantizeLabColor(l, a, b) {
    var rgb = labToRgbBytes(l, a, b);
    var lab = rgbBytesToLab(rgb[0], rgb[1], rgb[2]);
    return { L: lab[0], A: lab[1], B: lab[2], r: rgb[0], g: rgb[1], b: rgb[2] };
  }

  function canMergePalette(c1, c2) {
    var d = Math.sqrt(labDelta2(c1.L, c1.A, c1.B, c2.L, c2.A, c2.B));
    var L1 = c1.L;
    var L2 = c2.L;
    var minL = L1 < L2 ? L1 : L2;
    var maxL = L1 > L2 ? L1 : L2;
    var C1 = Math.sqrt(chroma2(c1.A, c1.B));
    var C2 = Math.sqrt(chroma2(c2.A, c2.B));
    /* Never merge ink-black with a dark clothing/hair fill. */
    if (minL <= 4.5 && maxL >= 5.0) return false;
    /* White only merges with low-chroma near-whites. */
    if (maxL >= 93) {
      if (minL < 92.5 || C1 > 5.5 || C2 > 5.5) return false;
    }
    if (C1 > 8 && C2 > 8) {
      var cos = (c1.A * c2.A + c1.B * c2.B) / (C1 * C2);
      if (cos < 0.82 && d > 5) return false;
    }
    var mergeT = 7.5;
    if (C1 > 15 || C2 > 15) mergeT = 6.0;
    /* Mottled near-black fills (hair/pants) should collapse to one flat,
       but the ink isolation rule above still holds. */
    /* Only merge near-black clothing/hair mottles, not iris midtones (L ~ 22–35). */
    if (C1 < 8 && C2 < 8 && minL > 4.5 && maxL < 20) mergeT = 9.5;
    return d < mergeT;
  }

  /**
   * Estimate the small set of intentional cel flats from a (usually
   * already region-flattened) Lab image. Forced anchors: pure white
   * and pure ink black, kept isolated from mid-darks and chromatic fills.
   */
  function extractCelPalette(L, A, B, w, h, structGrad, edgeT) {
    var n = w * h;
    var LS = 26;
    var AS = 41;
    var BS = 41;
    var bins = LS * AS * BS;
    var count = new Int32Array(bins);
    var sumL = new Float64Array(bins);
    var sumA = new Float64Array(bins);
    var sumB = new Float64Array(bins);
    var i, li, ai, bi, idx;
    var nearWhite = 0;
    var nearBlack = 0;
    /* Peak the histogram on low-gradient interiors only, so antialiased
       mid-grays between two flats cannot become fake palette colours. */
    var useGrad = structGrad && structGrad.length === n;
    var gT = (edgeT == null ? 3.5 : edgeT) * 1.15 + 0.8;
    for (i = 0; i < n; i++) {
      if (L[i] >= 93 && chroma2(A[i], B[i]) < 30) nearWhite++;
      if (L[i] <= 5) nearBlack++;
      if (useGrad && structGrad[i] >= gT) continue;
      li = (L[i] / 4) | 0;
      if (li < 0) li = 0;
      if (li > 25) li = 25;
      ai = ((A[i] + 80) / 4) | 0;
      if (ai < 0) ai = 0;
      if (ai > 40) ai = 40;
      bi = ((B[i] + 80) / 4) | 0;
      if (bi < 0) bi = 0;
      if (bi > 40) bi = 40;
      idx = (li * AS + ai) * BS + bi;
      count[idx]++;
      sumL[idx] += L[i];
      sumA[idx] += A[i];
      sumB[idx] += B[i];
    }

    var minPeak = Math.max(40, (n * 0.00004) | 0);
    var peaks = [];
    var di, da, db, ni, greater, c0;
    for (li = 0; li < LS; li++) {
      for (ai = 0; ai < AS; ai++) {
        for (bi = 0; bi < BS; bi++) {
          idx = (li * AS + ai) * BS + bi;
          c0 = count[idx];
          if (c0 < minPeak) continue;
          greater = false;
          for (di = -1; di <= 1 && !greater; di++) {
            if (li + di < 0 || li + di >= LS) continue;
            for (da = -1; da <= 1 && !greater; da++) {
              if (ai + da < 0 || ai + da >= AS) continue;
              for (db = -1; db <= 1; db++) {
                if (di === 0 && da === 0 && db === 0) continue;
                if (bi + db < 0 || bi + db >= BS) continue;
                ni = ((li + di) * AS + (ai + da)) * BS + (bi + db);
                /* plateau: keep the lower index as the peak */
                if (count[ni] > c0 || (count[ni] === c0 && ni < idx)) {
                  greater = true;
                  break;
                }
              }
            }
          }
          if (greater) continue;
          peaks.push({
            L: sumL[idx] / c0,
            A: sumA[idx] / c0,
            B: sumB[idx] / c0,
            count: c0,
            bin: idx
          });
        }
      }
    }

    /* Assign neighbouring mass to the nearest peak so counts/means are robust. */
    if (peaks.length) {
      var belong = new Int32Array(bins);
      for (i = 0; i < bins; i++) belong[i] = -1;
      var p, best, bestD, d2, j;
      for (li = 0; li < LS; li++) {
        for (ai = 0; ai < AS; ai++) {
          for (bi = 0; bi < BS; bi++) {
            idx = (li * AS + ai) * BS + bi;
            if (count[idx] === 0) continue;
            var cL = sumL[idx] / count[idx];
            var cA = sumA[idx] / count[idx];
            var cB = sumB[idx] / count[idx];
            best = -1;
            bestD = 1e9;
            for (j = 0; j < peaks.length; j++) {
              d2 = labDelta2(cL, cA, cB, peaks[j].L, peaks[j].A, peaks[j].B);
              if (d2 < bestD) {
                bestD = d2;
                best = j;
              }
            }
            /* only claim mass that is reasonably close to a peak */
            if (best >= 0 && bestD < 14 * 14) belong[idx] = best;
          }
        }
      }
      var pL = new Float64Array(peaks.length);
      var pA = new Float64Array(peaks.length);
      var pB = new Float64Array(peaks.length);
      var pC = new Int32Array(peaks.length);
      for (idx = 0; idx < bins; idx++) {
        j = belong[idx];
        if (j < 0) continue;
        pL[j] += sumL[idx];
        pA[j] += sumA[idx];
        pB[j] += sumB[idx];
        pC[j] += count[idx];
      }
      for (j = 0; j < peaks.length; j++) {
        if (pC[j] > 0) {
          peaks[j].L = pL[j] / pC[j];
          peaks[j].A = pA[j] / pC[j];
          peaks[j].B = pB[j] / pC[j];
          peaks[j].count = pC[j];
        }
      }
    }

    var candidates = peaks.slice();
    if (nearWhite > Math.max(200, (n * 0.002) | 0)) {
      candidates.push({ L: 100, A: 0, B: 0, count: nearWhite, forced: "white" });
    }
    if (nearBlack > 80) {
      candidates.push({ L: 0, A: 0, B: 0, count: nearBlack, forced: "black" });
    }

    function mergeCandidates(list) {
      var m = list.length;
      var parent = new Int32Array(m);
      var k, a, b, changed;
      for (k = 0; k < m; k++) parent[k] = k;
      function find(x) {
        var r = x, t;
        while (parent[r] !== r) r = parent[r];
        while (parent[x] !== r) {
          t = parent[x];
          parent[x] = r;
          x = t;
        }
        return r;
      }
      function unite(x, y) {
        x = find(x);
        y = find(y);
        if (x !== y) parent[y] = x;
      }
      for (a = 0; a < m; a++) {
        for (b = a + 1; b < m; b++) {
          if (canMergePalette(list[a], list[b])) unite(a, b);
        }
      }
      var groups = {};
      for (k = 0; k < m; k++) {
        var r = find(k);
        if (!groups[r]) groups[r] = { L: 0, A: 0, B: 0, count: 0, forced: null };
        var g = groups[r];
        var ck = list[k].count || 1;
        g.L += list[k].L * ck;
        g.A += list[k].A * ck;
        g.B += list[k].B * ck;
        g.count += ck;
        if (list[k].forced) g.forced = list[k].forced;
      }
      var out = [];
      for (k in groups) {
        if (!Object.prototype.hasOwnProperty.call(groups, k)) continue;
        g = groups[k];
        out.push({
          L: g.L / g.count,
          A: g.A / g.count,
          B: g.B / g.count,
          count: g.count,
          forced: g.forced || null
        });
      }
      return out;
    }

    candidates = mergeCandidates(candidates);

    /* Leftover coherent INTERIOR flats (iris, shoe gray, a bow) that
       were too mottled to form a histogram peak. Skip edge/AA chains. */
    var palTmp = candidates;
    var minLeft = Math.max(80, (n * 0.00008) | 0);
    var seen = new Uint8Array(n);
    var stack = new Int32Array(n);
    var comp = new Int32Array(n);
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
    var x, y, a, nx, ny, ni, sp, cs, sL, sA, sB, seedL, seedA, seedB, d2, bestD, j;
    var ct2 = 16 * 16;
    var interiorN, minX, maxX, minY, maxY, sumL2, k;
    for (i = 0; i < n; i++) {
      if (seen[i]) continue;
      /* Allow medium gradients so mottled iris interiors can still form a flat. */
      if (useGrad && structGrad[i] >= gT * 2.6) { seen[i] = 1; continue; }
      bestD = 1e9;
      var bestJ = -1;
      for (j = 0; j < palTmp.length; j++) {
        d2 = labDelta2(L[i], A[i], B[i], palTmp[j].L, palTmp[j].A, palTmp[j].B);
        if (d2 < bestD) { bestD = d2; bestJ = j; }
      }
      /* already explained by a known flat. Keep this tight so a mid-dark
         iris (ΔE ~12–20 from hair fill) can still form its own entry. */
      if (bestD < 7.5 * 7.5) {
        seen[i] = 1;
        continue;
      }
      seedL = L[i];
      seedA = A[i];
      seedB = B[i];
      sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      cs = 0;
      sL = sA = sB = 0;
      sumL2 = 0;
      interiorN = 0;
      minX = w; maxX = 0; minY = h; maxY = 0;
      while (sp) {
        k = stack[--sp];
        comp[cs++] = k;
        sL += L[k];
        sA += A[k];
        sB += B[k];
        sumL2 += L[k] * L[k];
        if (!useGrad || structGrad[k] < gT) interiorN++;
        y = (k / w) | 0;
        x = k - y * w;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (a = 0; a < 8; a += 2) {
          nx = x + dirs[a];
          ny = y + dirs[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (seen[ni]) continue;
          if (useGrad && structGrad[ni] >= gT * 2.8) continue;
          if (labDelta2(L[ni], A[ni], B[ni], seedL, seedA, seedB) > ct2) continue;
          seen[ni] = 1;
          stack[sp++] = ni;
        }
      }
      if (cs >= minLeft && interiorN >= minLeft * 0.6) {
        var bbox = (maxX - minX + 1) * (maxY - minY + 1);
        var fillR = bbox > 0 ? cs / bbox : 0;
        var meanL = sL / cs;
        var varL = sumL2 / cs - meanL * meanL;
        /* Reject thin AA snakes and high-variance mixed blobs. */
        if (fillR >= 0.22 && varL < 160) {
          candidates.push({
            L: meanL,
            A: sA / cs,
            B: sB / cs,
            count: cs,
            forced: null
          });
        } else {
          /* Unmark so a later, cleaner seed (e.g. iris interior) can retry. */
          for (a = 0; a < cs; a++) seen[comp[a]] = 0;
          seen[i] = 1;
        }
      } else {
        for (a = 0; a < cs; a++) seen[comp[a]] = 0;
        seen[i] = 1;
      }
    }

    candidates = mergeCandidates(candidates);

    /* Dedicated hunt for mid-L, low-chroma islands (iris midtones).
       On a full character sheet the general leftover flood can miss
       these because they are small and sit near dark hair/ink. */
    var midMin = Math.max(80, (n * 0.00004) | 0);
    var midSeen = new Uint8Array(n);
    var midCt2 = 14 * 14;
    for (i = 0; i < n; i++) {
      if (midSeen[i]) continue;
      if (L[i] < 18 || L[i] > 52) continue;
      if (chroma2(A[i], B[i]) > 120) continue;
      if (useGrad && structGrad[i] >= gT * 2.6) { midSeen[i] = 1; continue; }
      bestD = 1e9;
      /* Only "explained" by major flats — leftover mid-grays must not
         hide an iris from this hunt. */
      for (j = 0; j < candidates.length; j++) {
        var cj = candidates[j];
        if (!cj.forced && cj.count < minPeak * 8 && Math.abs(cj.L - 50) < 30 && Math.sqrt(chroma2(cj.A, cj.B)) < 15) continue;
        d2 = labDelta2(L[i], A[i], B[i], cj.L, cj.A, cj.B);
        if (d2 < bestD) bestD = d2;
      }
      if (bestD < 7.5 * 7.5) { midSeen[i] = 1; continue; }
      seedL = L[i]; seedA = A[i]; seedB = B[i];
      sp = 0; stack[sp++] = i; midSeen[i] = 1;
      cs = 0; sL = sA = sB = 0; sumL2 = 0; interiorN = 0;
      minX = w; maxX = 0; minY = h; maxY = 0;
      while (sp) {
        k = stack[--sp];
        comp[cs++] = k;
        sL += L[k]; sA += A[k]; sB += B[k];
        sumL2 += L[k] * L[k];
        if (!useGrad || structGrad[k] < gT * 2.6) interiorN++;
        y = (k / w) | 0;
        x = k - y * w;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (a = 0; a < 8; a += 2) {
          nx = x + dirs[a];
          ny = y + dirs[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (midSeen[ni]) continue;
          if (L[ni] < 16 || L[ni] > 54) continue;
          if (chroma2(A[ni], B[ni]) > 140) continue;
          if (labDelta2(L[ni], A[ni], B[ni], seedL, seedA, seedB) > midCt2) continue;
          midSeen[ni] = 1;
          stack[sp++] = ni;
        }
      }
      var midOk = false;
      if (cs >= midMin && interiorN >= midMin * 0.5) {
        var bboxM = (maxX - minX + 1) * (maxY - minY + 1);
        var fillM = bboxM > 0 ? cs / bboxM : 0;
        var meanM = sL / cs;
        var varM = sumL2 / cs - meanM * meanM;
        if (fillM >= 0.22 && varM < 180) {
          candidates.push({ L: meanM, A: sA / cs, B: sB / cs, count: cs, forced: null });
          midOk = true;
        }
      }
      if (!midOk) {
        for (a = 0; a < cs; a++) midSeen[comp[a]] = 0;
        midSeen[i] = 1;
      }
    }
    candidates = mergeCandidates(candidates);

    var palette = [];
    for (i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var C = Math.sqrt(chroma2(c.A, c.B));
      if (c.forced === "white" || (c.L >= 93 && C < 5.5)) {
        palette.push({ L: 100, A: 0, B: 0, r: 255, g: 255, b: 255, count: c.count, kind: "white" });
        continue;
      }
      if (c.forced === "black" || (c.L <= 3.5 && C < 6)) {
        palette.push({ L: 0, A: 0, B: 0, r: 0, g: 0, b: 0, count: c.count, kind: "black" });
        continue;
      }
      if (c.count < minPeak && c.forced == null) continue;
      var q = quantizeLabColor(c.L, c.A, c.B);
      var kind = "fill";
      if (q.L <= 3.0 && q.r <= 6 && q.g <= 6 && q.b <= 6) kind = "black";
      else if (q.L >= 93 && Math.sqrt(chroma2(q.A, q.B)) < 5.5) kind = "white";
      palette.push({
        L: q.L,
        A: q.A,
        B: q.B,
        r: q.r,
        g: q.g,
        b: q.b,
        count: c.count,
        kind: kind
      });
    }

    /* Dedup after quantization (two means may snap to the same 8-bit RGB). */
    var uniq = [];
    for (i = 0; i < palette.length; i++) {
      var found = -1;
      for (j = 0; j < uniq.length; j++) {
        if (uniq[j].r === palette[i].r && uniq[j].g === palette[i].g && uniq[j].b === palette[i].b) {
          found = j;
          break;
        }
      }
      if (found >= 0) uniq[found].count += palette[i].count;
      else uniq.push(palette[i]);
    }
    /* Ensure anchors exist when the image actually has paper/ink. */
    function hasKind(k) {
      for (i = 0; i < uniq.length; i++) if (uniq[i].kind === k) return true;
      return false;
    }
    if (nearWhite > Math.max(200, (n * 0.002) | 0) && !hasKind("white")) {
      uniq.push({ L: 100, A: 0, B: 0, r: 255, g: 255, b: 255, count: nearWhite, kind: "white" });
    }
    if (nearBlack > 80 && !hasKind("black")) {
      uniq.push({ L: 0, A: 0, B: 0, r: 0, g: 0, b: 0, count: nearBlack, kind: "black" });
    }
    uniq.sort(function (a, b) { return b.count - a.count; });
    /* Drop midtones that sit on the blend between two larger flats
       (almost always antialiasing, not an intended cel shade). Keep a
       small isolated colour (iris, shoe gray, vest red) only if it is
       off every major segment and has a real interior population. */
    var majorT = Math.max(minPeak, (n * 0.01) | 0);
    var isoT = Math.max(160, (n * 0.00008) | 0);
    var kept = [];
    function isBlendOfMajors(u, majors) {
      var p, q, seg;
      for (p = 0; p < majors.length; p++) {
        for (q = p + 1; q < majors.length; q++) {
          seg = labSegDist(u.L, u.A, u.B, majors[p], majors[q]);
          if (seg.t >= 0.12 && seg.t <= 0.88 && seg.d2 < 7.5 * 7.5) return true;
        }
      }
      return false;
    }
    for (i = 0; i < uniq.length; i++) {
      var u = uniq[i];
      var Cu = Math.sqrt(chroma2(u.A, u.B));
      if (u.kind === "white" || u.kind === "black") { kept.push(u); continue; }
      var isMajor = u.count >= majorT || (Cu > 18 && u.count >= isoT);
      var minD = 1e9;
      for (j = 0; j < kept.length; j++) {
        var dd = Math.sqrt(labDelta2(u.L, u.A, u.B, kept[j].L, kept[j].A, kept[j].B));
        if (dd < minD) minD = dd;
      }
      /* Always keep a major interior flat (skin must not be discarded
         just because it sits somewhat near a vest-red–white segment). */
      if (isMajor) { kept.push(u); continue; }
      /* Tentatively keep isolated extras (iris, shoe gray). A later
         compact-interior check drops scattered AA midtones; do not
         pre-drop an iris just because it sits near the dark–white line. */
      if (u.count >= isoT && minD >= 8) kept.push(u);
    }
    /* Non-major extras must have a compact interior (shoe gray, iris).
       Scattered antialias midtones fail this and are dropped. */
    var extras = [];
    var ei;
    for (i = 0; i < kept.length; i++) {
      if (kept[i].kind === "white" || kept[i].kind === "black" || kept[i].count >= majorT) continue;
      extras.push(i);
    }
    if (extras.length) {
      var owner = new Int16Array(n);
      for (i = 0; i < n; i++) owner[i] = -1;
      for (i = 0; i < n; i++) {
        if (useGrad && structGrad[i] >= gT) continue;
        var bestE = -1, bestED = 8 * 8;
        for (ei = 0; ei < extras.length; ei++) {
          var eu = kept[extras[ei]];
          d2 = labDelta2(L[i], A[i], B[i], eu.L, eu.A, eu.B);
          if (d2 < bestED) { bestED = d2; bestE = ei; }
        }
        if (bestE >= 0) owner[i] = bestE;
      }
      var bestCS = new Int32Array(extras.length);
      var bestFill = new Float32Array(extras.length);
      var seenE = new Uint8Array(n);
      var stE = new Int32Array(n);
      var dirsE = [1, 0, -1, 0, 0, 1, 0, -1];
      for (i = 0; i < n; i++) {
        if (seenE[i] || owner[i] < 0) continue;
        var eid = owner[i];
        var spe = 0, cse = 0;
        var minXe = w, maxXe = 0, minYe = h, maxYe = 0;
        stE[spe++] = i;
        seenE[i] = 1;
        while (spe) {
          var ke = stE[--spe];
          cse++;
          y = (ke / w) | 0;
          x = ke - y * w;
          if (x < minXe) minXe = x;
          if (x > maxXe) maxXe = x;
          if (y < minYe) minYe = y;
          if (y > maxYe) maxYe = y;
          for (a = 0; a < 8; a += 2) {
            nx = x + dirsE[a];
            ny = y + dirsE[a + 1];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            ni = ny * w + nx;
            if (seenE[ni] || owner[ni] !== eid) continue;
            seenE[ni] = 1;
            stE[spe++] = ni;
          }
        }
        var bboxe = (maxXe - minXe + 1) * (maxYe - minYe + 1);
        var fr = bboxe > 0 ? cse / bboxe : 0;
        if (cse > bestCS[eid] || (cse === bestCS[eid] && fr > bestFill[eid])) {
          bestCS[eid] = cse;
          bestFill[eid] = fr;
        }
      }
      var verified = [];
      for (i = 0; i < kept.length; i++) {
        if (kept[i].kind === "white" || kept[i].kind === "black" || kept[i].count >= majorT) {
          verified.push(kept[i]);
          continue;
        }
        var eix = extras.indexOf(i);
        if (eix >= 0 && bestCS[eix] >= isoT && bestFill[eix] >= 0.25) verified.push(kept[i]);
      }
      return verified;
    }
    return kept;
  }

  /**
   * v6 whole-image palette cleanup. Snap dirty near-whites to pure white,
   * weak / holey ink to solid ink black, and mottled interiors of each
   * fill to that fill's dominant palette color. Keep a short AA blend on
   * real structure edges so hairlines, vest stripes, and lids stay sharp
   * instead of hard-cut. Never merge ink black into a dark hair/pants fill.
   */
  function paletteClean(L, A, B, L0, w, h, protect, structGrad, edgeT, paletteOut) {
    var n = w * h;
    var palette = extractCelPalette(L, A, B, w, h, structGrad, edgeT);
    if (paletteOut) paletteOut.colors = palette;
    if (!palette.length) return;

    var i, j, k, p;
    var whiteIdx = -1;
    var blackIdx = -1;
    var darkFillIdx = -1;
    var darkFillCount = 0;
    var isMajorPal = new Uint8Array(palette.length);
    var majorCountT = Math.max(40, (n * 0.01) | 0);
    for (i = 0; i < palette.length; i++) {
      p = palette[i];
      if (p.kind === "white" && whiteIdx < 0) whiteIdx = i;
      if (p.kind === "black" && blackIdx < 0) blackIdx = i;
      if (p.kind === "white" || p.kind === "black" || p.count >= majorCountT) isMajorPal[i] = 1;
      if (p.kind === "fill") {
        var C = Math.sqrt(chroma2(p.A, p.B));
        if (C < 10 && p.L > 5.5 && p.L < 28 && p.count > darkFillCount) {
          darkFillCount = p.count;
          darkFillIdx = i;
        }
      }
    }

    function nearestTwo(l, a, b, majorOnly) {
      var d1 = 1e9, d2 = 1e9, i1 = -1, i2 = -1, d, t;
      for (t = 0; t < palette.length; t++) {
        if (majorOnly && !isMajorPal[t]) continue;
        d = labDelta2(l, a, b, palette[t].L, palette[t].A, palette[t].B);
        if (d < d1) {
          d2 = d1;
          i2 = i1;
          d1 = d;
          i1 = t;
        } else if (d < d2) {
          d2 = d;
          i2 = t;
        }
      }
      return { i1: i1, d1: d1, i2: i2, d2: d2 };
    }

    function apply(i, idx) {
      L[i] = palette[idx].L;
      A[i] = palette[idx].A;
      B[i] = palette[idx].B;
    }

    function distToSeg(l, a, b, c1, c2) {
      var vx = c2.L - c1.L, vy = c2.A - c1.A, vz = c2.B - c1.B;
      var wx = l - c1.L, wy = a - c1.A, wz = b - c1.B;
      var vv = vx * vx + vy * vy + vz * vz;
      var t = vv < 1e-8 ? 0 : (wx * vx + wy * vy + wz * vz) / vv;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      var dx = wx - vx * t, dy = wy - vy * t, dz = wz - vz * t;
      return { d2: dx * dx + dy * dy + dz * dz, t: t };
    }

    /* Distance to any light/chromatic pixel: large in hair/pants interiors. */
    var lightish = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if (L[i] > 30 || chroma2(A[i], B[i]) > 225) lightish[i] = 1;
    }
    var distLight = chessboardDist(lightish, w, h, 16);

    function nearestColoredFill(l, a, b) {
      var best = -1, bestD = 1e9, t, d;
      for (t = 0; t < palette.length; t++) {
        if (t === whiteIdx || t === blackIdx) continue;
        d = labDelta2(l, a, b, palette[t].L, palette[t].A, palette[t].B);
        if (d < bestD) { bestD = d; best = t; }
      }
      return { i: best, d: bestD };
    }

    /* Solid colored flats only — leftover pale-gray AA (e.g. [212,210,210])
       must not count as a "fill" when deciding ink↔fill sandwiches. */
    function isSolidFillPal(t) {
      if (t < 0 || t === whiteIdx || t === blackIdx) return false;
      var pp = palette[t];
      if (pp.L >= 82 && chroma2(pp.A, pp.B) < 64) return false;
      return true;
    }

    function nearestSolidFill(l, a, b) {
      var best = -1, bestD = 1e9, t, d;
      for (t = 0; t < palette.length; t++) {
        if (!isSolidFillPal(t)) continue;
        d = labDelta2(l, a, b, palette[t].L, palette[t].A, palette[t].B);
        if (d < bestD) { bestD = d; best = t; }
      }
      return { i: best, d: bestD };
    }

    /* v7: map true ink, confident paper interiors, and confident colored
       fills so we can refuse to paint a white rim between ink and a fill. */
    var inkMask = new Uint8Array(n);
    var paperMask = new Uint8Array(n);
    var fillMask = new Uint8Array(n);
    var fillId = new Int16Array(n);
    for (i = 0; i < n; i++) fillId[i] = -1;
    for (i = 0; i < n; i++) {
      var lInk = L0[i] < L[i] ? L0[i] : L[i];
      var dBlack = blackIdx >= 0 ? labDelta2(L[i], A[i], B[i], palette[blackIdx].L, palette[blackIdx].A, palette[blackIdx].B) : 1e9;
      var dDark = darkFillIdx >= 0 ? labDelta2(L[i], A[i], B[i], palette[darkFillIdx].L, palette[darkFillIdx].A, palette[darkFillIdx].B) : 1e9;
      if (lInk <= 8 || (lInk <= 14 && distLight[i] <= 2 && dBlack <= dDark)) inkMask[i] = 1;
      var cInk = chroma2(A[i], B[i]);
      if (L[i] >= 96.5 && cInk < 20 && lInk > 40) paperMask[i] = 1;
    }
    var distInk = chessboardDist(inkMask, w, h, 8);
    for (i = 0; i < n; i++) {
      /* Only true interiors count as paper. A 2px washed fringe next to
         ink must not register as a white region and bless itself. */
      if (paperMask[i] && distInk[i] <= 2) paperMask[i] = 0;
    }
    var distPaper = chessboardDist(paperMask, w, h, 8);

    /* Tight cores only. Low-chroma mid fills (shoe gray) may seed only
       in interiors; fringe mid-gray AA is closer to shoe than to skin
       and must not spread along every stroke. */
    for (i = 0; i < n; i++) {
      if (inkMask[i] || paperMask[i]) continue;
      var nf0 = nearestSolidFill(L[i], A[i], B[i]);
      if (nf0.i < 0 || nf0.d > 7 * 7 || L[i] >= 94) continue;
      var fp = palette[nf0.i];
      var fC2 = chroma2(fp.A, fp.B);
      if (fC2 < 40 && fp.L >= 45 && fp.L <= 85 && distInk[i] < 4) continue;
      fillMask[i] = 1;
      fillId[i] = nf0.i;
    }

    var SAND_DIRS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];

    /* Grow confident fills 3px toward ink through the washed fringe so
       sandwich tests and fill votes see the local core (skin, vest, hair)
       rather than a globally nearest mid-gray like shoe. */
    var growList = new Int32Array(n);
    var growId = new Int16Array(n);
    var iter, growN, dx, dy, xx, yy, ji, seenId;
    for (iter = 0; iter < 3; iter++) {
      growN = 0;
      for (i = 0; i < n; i++) {
        if (fillMask[i] || inkMask[i] || paperMask[i]) continue;
        yy = (i / w) | 0;
        xx = i - yy * w;
        seenId = -1;
        for (k = 0; k < 16; k += 2) {
          dx = xx + SAND_DIRS[k];
          dy = yy + SAND_DIRS[k + 1];
          if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
          ji = dy * w + dx;
          if (fillId[ji] >= 0) { seenId = fillId[ji]; break; }
        }
        if (seenId >= 0) {
          growList[growN] = i;
          growId[growN] = seenId;
          growN++;
        }
      }
      for (k = 0; k < growN; k++) {
        i = growList[k];
        fillMask[i] = 1;
        fillId[i] = growId[k];
      }
    }
    var distFill = chessboardDist(fillMask, w, h, 8);

    /* True iff this pixel sits on a ray that hits ink one way and a
       colored fill the opposite way (the v6 sticker-halo configuration).
       Does not walk through ink, so the paper/stripe/sclera side of a
       stroke is not treated as sandwiched. */
    function sandwichedInkFill(ii) {
      var yy0 = (ii / w) | 0, xx0 = ii - yy0 * w;
      var d, s, xx, yy, ji, hitInk, hitFill;
      for (d = 0; d < 16; d += 2) {
        hitInk = 0;
        for (s = 1; s <= 4; s++) {
          xx = xx0 + SAND_DIRS[d] * s;
          yy = yy0 + SAND_DIRS[d + 1] * s;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          ji = yy * w + xx;
          if (inkMask[ji]) { hitInk = 1; break; }
        }
        if (!hitInk) continue;
        hitFill = 0;
        for (s = 1; s <= 4; s++) {
          xx = xx0 - SAND_DIRS[d] * s;
          yy = yy0 - SAND_DIRS[d + 1] * s;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          ji = yy * w + xx;
          if (inkMask[ji]) break;
          if (fillMask[ji]) { hitFill = 1; break; }
        }
        if (hitFill) return true;
      }
      return false;
    }

    function whiteForbidden(ii) {
      if (whiteIdx < 0) return true;
      if (distInk[ii] >= 3) return false;
      if (sandwichedInkFill(ii)) return true;
      /* Ray test can miss at stroke tips; if a fill is nearby and no
         true paper interior is, still refuse white. */
      if (distFill[ii] <= 3 && distPaper[ii] > 3) return true;
      return false;
    }

    function applyWhite(ii) {
      if (whiteForbidden(ii)) return false;
      apply(ii, whiteIdx);
      locked[ii] = 1;
      return true;
    }

    var fillVotes = new Int32Array(64);

    /* Light fringe that must not become white: close the gap with the
       fill on the side opposite the ink. Mid ink↔fill AA may stay unlocked. */
    function applyFillInsteadOfWhite(ii) {
      var yy0 = (ii / w) | 0, xx0 = ii - yy0 * w;
      var d, s, xx, yy, ji, t;
      var inkDx = 0, inkDy = 0, foundInk = 0, bestS = 99;
      for (d = 0; d < 16; d += 2) {
        for (s = 1; s <= 3; s++) {
          xx = xx0 + SAND_DIRS[d] * s;
          yy = yy0 + SAND_DIRS[d + 1] * s;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          if (inkMask[yy * w + xx]) {
            if (s < bestS) {
              bestS = s;
              inkDx = SAND_DIRS[d];
              inkDy = SAND_DIRS[d + 1];
              foundInk = 1;
            }
            break;
          }
        }
      }
      if (fillVotes.length < palette.length) fillVotes = new Int32Array(palette.length);
      for (t = 0; t < palette.length; t++) fillVotes[t] = 0;
      var vN = 0, dx, dy;
      for (dy = -4; dy <= 4; dy++) {
        yy = yy0 + dy;
        if (yy < 0 || yy >= h) continue;
        for (dx = -4; dx <= 4; dx++) {
          if (dx === 0 && dy === 0) continue;
          /* Prefer the half-plane opposite the nearest ink. */
          if (foundInk && dx * inkDx + dy * inkDy > 0) continue;
          xx = xx0 + dx;
          if (xx < 0 || xx >= w) continue;
          ji = yy * w + xx;
          t = fillId[ji];
          if (t < 0) continue;
          fillVotes[t]++;
          vN++;
        }
      }
      var bestI = -1, bestV = 0;
      for (t = 0; t < palette.length; t++) {
        if (fillVotes[t] > bestV) { bestV = fillVotes[t]; bestI = t; }
      }
      if (bestI >= 0 && vN >= 1) {
        apply(ii, bestI);
        locked[ii] = 1;
        return true;
      }
      /* Opposite half was empty (stroke tip). Vote any nearby core fill;
         never fall back to a globally nearest flat (that painted shoe
         gray onto face/lid fringes). */
      for (t = 0; t < palette.length; t++) fillVotes[t] = 0;
      vN = 0;
      for (dy = -5; dy <= 5; dy++) {
        yy = yy0 + dy;
        if (yy < 0 || yy >= h) continue;
        for (dx = -5; dx <= 5; dx++) {
          xx = xx0 + dx;
          if (xx < 0 || xx >= w) continue;
          t = fillId[yy * w + xx];
          if (t < 0) continue;
          fillVotes[t]++;
          vN++;
        }
      }
      bestI = -1;
      bestV = 0;
      for (t = 0; t < palette.length; t++) {
        if (fillVotes[t] > bestV) { bestV = fillVotes[t]; bestI = t; }
      }
      if (bestI >= 0 && vN >= 1) {
        apply(ii, bestI);
        locked[ii] = 1;
        return true;
      }
      return false;
    }

    var locked = new Uint8Array(n);
    var eT = edgeT == null ? 4 : edgeT;

    for (i = 0; i < n; i++) {
      var c2 = chroma2(A[i], B[i]);
      /* Near-white paper, stripe, nametag, sclera, shoe body → pure white,
         but never a fringe between ink and a colored fill. */
      if (whiteIdx >= 0 && L[i] >= 93 && c2 < 30) {
        if (applyWhite(i) || (whiteForbidden(i) && applyFillInsteadOfWhite(i))) continue;
      }
      if (whiteIdx >= 0 && !locked[i] && L[i] >= 90 && c2 < 16) {
        var nw = nearestTwo(L[i], A[i], B[i]);
        if (nw.i1 === whiteIdx) {
          if (applyWhite(i) || (whiteForbidden(i) && applyFillInsteadOfWhite(i))) continue;
        }
      }
      /* Dark clothing/hair interiors snap to the dark fill, never to ink.
         Require the pixel to actually be closer to that fill than to any
         other non-black palette, so a darker iris midtone is not eaten. */
      if (darkFillIdx >= 0 && distLight[i] >= 4 && L[i] < 28 && chroma2(A[i], B[i]) < 100) {
        var dDF = labDelta2(L[i], A[i], B[i], palette[darkFillIdx].L, palette[darkFillIdx].A, palette[darkFillIdx].B);
        var eat = dDF <= 12 * 12;
        if (eat) {
          var oj;
          for (oj = 0; oj < palette.length; oj++) {
            if (oj === darkFillIdx || oj === blackIdx) continue;
            if (labDelta2(L[i], A[i], B[i], palette[oj].L, palette[oj].A, palette[oj].B) < dDF) { eat = false; break; }
          }
        }
        if (eat) {
          apply(i, darkFillIdx);
          locked[i] = 1;
          continue;
        }
      }
    }

    /* Mid-gray holes inside true ink (not hair fill). Size stays below
       a typical iris so eye midtones cannot be painted black. */
    if (blackIdx >= 0) {
      var maxHole = Math.max(48, Math.min(120, (n * 0.00002) | 0));
      var label = new Int32Array(n);
      for (i = 0; i < n; i++) label[i] = -1;
      var stack = new Int32Array(n);
      var comp = new Int32Array(n);
      var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
      var cid = 0;
      var sizeOf = [];
      var inkOf = [];
      var x, y, a, nx, ny, ni, sp, cs, ok, bInk, k;
      function isTrueInk(ii) {
        return L[ii] <= 5.5 || (locked[ii] && blackIdx >= 0 && L[ii] <= 1);
      }
      for (i = 0; i < n; i++) {
        if (label[i] >= 0 || isTrueInk(i) || locked[i]) continue;
        /* only consider mid/dark dirty pixels as possible holes */
        if (L[i] < 6 || L[i] > 80) continue;
        /* do not start a hole on a chromatic fill (vest, skin) */
        if (chroma2(A[i], B[i]) > 140) continue;
        sp = 0;
        stack[sp++] = i;
        label[i] = cid;
        cs = 0;
        ok = 1;
        bInk = 0;
        while (sp) {
          k = stack[--sp];
          comp[cs++] = k;
          if (cs > maxHole) { ok = 0; break; }
          y = (k / w) | 0;
          x = k - y * w;
          for (a = 0; a < 8; a += 2) {
            nx = x + dirs[a];
            ny = y + dirs[a + 1];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            ni = ny * w + nx;
            if (isTrueInk(ni)) { bInk++; continue; }
            if (label[ni] >= 0) continue;
            if (locked[ni] && !(L[ni] > 6 && L[ni] < 80 && chroma2(A[ni], B[ni]) < 140)) continue;
            if (L[ni] <= 5.5 || L[ni] > 80 || chroma2(A[ni], B[ni]) > 140) continue;
            label[ni] = cid;
            stack[sp++] = ni;
          }
        }
        while (sp) {
          k = stack[--sp];
          label[k] = ok ? cid : 0x7fffffff;
        }
        if (!ok) {
          var qh = 0, qt = 0;
          var q = stack;
          for (a = 0; a < cs; a++) q[qt++] = comp[a];
          while (qh < qt) {
            k = q[qh++];
            y = (k / w) | 0;
            x = k - y * w;
            for (a = 0; a < 8; a += 2) {
              nx = x + dirs[a];
              ny = y + dirs[a + 1];
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              ni = ny * w + nx;
              if (isTrueInk(ni)) continue;
              if (label[ni] >= 0) continue;
              if (L[ni] <= 5.5 || L[ni] > 80 || chroma2(A[ni], B[ni]) > 140) continue;
              label[ni] = 0x7fffffff;
              q[qt++] = ni;
            }
          }
          cid++;
          sizeOf[cid - 1] = 9999;
          inkOf[cid - 1] = 0;
          continue;
        }
        sizeOf[cid] = cs;
        inkOf[cid] = bInk;
        cid++;
      }
      for (i = 0; i < n; i++) {
        var lab = label[i];
        if (lab < 0 || lab === 0x7fffffff) continue;
        if (sizeOf[lab] < 1 || sizeOf[lab] > maxHole) continue;
        if (inkOf[lab] < sizeOf[lab] * 1.15 && inkOf[lab] < 8) continue;
        /* Skip islands that already match a non-black palette (iris). */
        var nn = nearestTwo(L[i], A[i], B[i]);
        if (nn.i1 !== blackIdx && nn.d1 < 8 * 8 && palette[nn.i1].kind !== "black") continue;
        apply(i, blackIdx);
        locked[i] = 1;
      }
    }

    /* General snap: interiors go hard to the nearest flat. Structure
       edges use only palettes visible in already-locked neighbours so
       a jaw stroke blends from ink+paper, not from a distant hair fill. */
    var locVote = new Int32Array(palette.length);
    for (i = 0; i < n; i++) {
      if (locked[i]) continue;
      /* Dark clothing/hair interiors snap to the dark fill, never to ink.
         Require the pixel to actually be closer to that fill than to any
         other non-black palette, so a darker iris midtone is not eaten. */
      if (darkFillIdx >= 0 && distLight[i] >= 4 && L[i] < 28 && chroma2(A[i], B[i]) < 100) {
        var dDF = labDelta2(L[i], A[i], B[i], palette[darkFillIdx].L, palette[darkFillIdx].A, palette[darkFillIdx].B);
        var eat = dDF <= 12 * 12;
        if (eat) {
          var oj;
          for (oj = 0; oj < palette.length; oj++) {
            if (oj === darkFillIdx || oj === blackIdx) continue;
            if (labDelta2(L[i], A[i], B[i], palette[oj].L, palette[oj].A, palette[oj].B) < dDF) { eat = false; break; }
          }
        }
        if (eat) {
          apply(i, darkFillIdx);
          locked[i] = 1;
          continue;
        }
      }
      var onEdge = (protect && protect[i]) || (structGrad && structGrad[i] > eT);
      var nb, dLoc1, dLoc2, seg, cap, vi, y0, x0, dy, dx, sy, sx, nLoc, i1, i2, v1, v2, tmpI, tmpD;
      if (onEdge) {
        for (vi = 0; vi < palette.length; vi++) locVote[vi] = 0;
        y0 = (i / w) | 0;
        x0 = i - y0 * w;
        nLoc = 0;
        for (dy = -2; dy <= 2; dy++) {
          sy = y0 + dy;
          if (sy < 0 || sy >= h) continue;
          for (dx = -2; dx <= 2; dx++) {
            sx = x0 + dx;
            if (sx < 0 || sx >= w) continue;
            ni = sy * w + sx;
            if (!locked[ni]) continue;
            var ln = nearestTwo(L[ni], A[ni], B[ni]);
            if (ln.i1 >= 0) {
              locVote[ln.i1]++;
              nLoc++;
            }
          }
        }
        i1 = -1;
        i2 = -1;
        v1 = 0;
        v2 = 0;
        for (vi = 0; vi < palette.length; vi++) {
          if (locVote[vi] > v1) {
            v2 = v1; i2 = i1;
            v1 = locVote[vi]; i1 = vi;
          } else if (locVote[vi] > v2) {
            v2 = locVote[vi]; i2 = vi;
          }
        }
        if (i1 >= 0 && nLoc >= 2) {
          dLoc1 = labDelta2(L[i], A[i], B[i], palette[i1].L, palette[i1].A, palette[i1].B);
          if (i2 >= 0) {
            dLoc2 = labDelta2(L[i], A[i], B[i], palette[i2].L, palette[i2].A, palette[i2].B);
            if (dLoc2 < dLoc1) {
              tmpI = i1; tmpD = dLoc1;
              i1 = i2; dLoc1 = dLoc2;
              i2 = tmpI; dLoc2 = tmpD;
            }
            seg = labSegDist(L[i], A[i], B[i], palette[i1], palette[i2]);
            if (seg.d2 < 12 && seg.t >= 0.18 && seg.t <= 0.82) continue;
          }
          if (dLoc1 <= 10 * 10) {
            if (i1 === whiteIdx && whiteForbidden(i)) {
              if (i2 >= 0 && i2 !== whiteIdx && i2 !== blackIdx) {
                apply(i, i2);
                locked[i] = 1;
              } else {
                applyFillInsteadOfWhite(i);
              }
            } else {
              apply(i, i1);
              locked[i] = 1;
            }
          }
          continue;
        }
      }
      /* Edge fallback uses only major flats so shoe-gray / iris cannot
         leak into antialiased stroke rings across the page. */
      nb = nearestTwo(L[i], A[i], B[i], onEdge);
      if (nb.i1 < 0) continue;
      if (nb.i1 === whiteIdx && whiteForbidden(i)) {
        if (onEdge && nb.i2 >= 0 && nb.i2 !== whiteIdx) {
          seg = labSegDist(L[i], A[i], B[i], palette[nb.i2], blackIdx >= 0 ? palette[blackIdx] : palette[nb.i2]);
          if (nb.i2 !== blackIdx && (L[i] >= 88 || labDelta2(L[i], A[i], B[i], palette[nb.i2].L, palette[nb.i2].A, palette[nb.i2].B) <= 14 * 14)) {
            apply(i, nb.i2);
            locked[i] = 1;
          }
          /* else keep a short AA */
        } else {
          applyFillInsteadOfWhite(i);
        }
        continue;
      }
      if (onEdge && nb.i2 >= 0) {
        seg = labSegDist(L[i], A[i], B[i], palette[nb.i1], palette[nb.i2]);
        if (seg.d2 < 9 && seg.t >= 0.25 && seg.t <= 0.75) continue;
        if (nb.d1 <= 8 * 8) {
          apply(i, nb.i1);
          locked[i] = 1;
        }
        continue;
      }
      cap = onEdge ? 8 * 8 : 18 * 18;
      if (nb.d1 <= cap) {
        apply(i, nb.i1);
        locked[i] = 1;
      }
    }

    /* Tiny leftover crumbs (not a real extra shade) take the neighbour flat. */
    var dirs4 = [1, 0, -1, 0, 0, 1, 0, -1];
    var seenC = new Uint8Array(n);
    var stackC = new Int32Array(n);
    var compC = new Int32Array(n);
    for (i = 0; i < n; i++) {
      if (seenC[i] || locked[i]) continue;
      var spc = 0, csc = 0, okc = 1;
      stackC[spc++] = i;
      seenC[i] = 1;
      while (spc) {
        k = stackC[--spc];
        compC[csc++] = k;
        if (csc > 12) { okc = 0; break; }
        y = (k / w) | 0;
        x = k - y * w;
        for (a = 0; a < 8; a += 2) {
          nx = x + dirs4[a];
          ny = y + dirs4[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (seenC[ni] || locked[ni]) continue;
          seenC[ni] = 1;
          stackC[spc++] = ni;
        }
      }
      while (spc) {
        k = stackC[--spc];
        seenC[k] = 1;
      }
      if (!okc) continue;
      var votes = new Int32Array(palette.length);
      var vN = 0;
      for (a = 0; a < csc; a++) {
        k = compC[a];
        y = (k / w) | 0;
        x = k - y * w;
        for (var t = 0; t < 8; t += 2) {
          nx = x + dirs4[t];
          ny = y + dirs4[t + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          ni = ny * w + nx;
          if (!locked[ni]) continue;
          var nv = nearestTwo(L[ni], A[ni], B[ni]);
          if (nv.i1 >= 0) {
            votes[nv.i1]++;
            vN++;
          }
        }
      }
      if (vN < 2) continue;
      var bestI = 0;
      for (j = 1; j < palette.length; j++) if (votes[j] > votes[bestI]) bestI = j;
      if (votes[bestI] === 0) continue;
      for (a = 0; a < csc; a++) {
        var ci = compC[a];
        if (bestI === whiteIdx && whiteForbidden(ci)) {
          applyFillInsteadOfWhite(ci);
          continue;
        }
        apply(ci, bestI);
        locked[ci] = 1;
      }
    }

    /* Final enforce: remaining dirty paper / crushed ink.
       Still never invent a white rim between ink and a colored fill. */
    for (i = 0; i < n; i++) {
      if (whiteIdx >= 0 && L[i] >= 96.5 && chroma2(A[i], B[i]) < 16) {
        if (!whiteForbidden(i)) apply(i, whiteIdx);
        else applyFillInsteadOfWhite(i);
      }
      if (blackIdx >= 0 && L[i] <= 5.5 && chroma2(A[i], B[i]) < 16) {
        if (!(darkFillIdx >= 0 && distLight[i] >= 4)) apply(i, blackIdx);
      }
    }
  }


  /**
   * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} imageData
   * @param {{strength?:number,preserveEdges?:number,flatFill?:boolean,paletteClean?:boolean,paletteOut?:{colors?:Array},mask?:Uint8Array,onProgress?:Function}} [options]
   * @returns {{data:Uint8ClampedArray,width:number,height:number}}
   */
  function denoise(imageData, options) {
    options = options || {};
    var strength = clamp(options.strength == null ? 0.9 : options.strength, 0, 1);
    var preserve = clamp(options.preserveEdges == null ? 0.88 : options.preserveEdges, 0, 1);
    var flatFill = options.flatFill !== false;
    var mask = options.mask || null;
    var progress = options.onProgress || function () {};
    var w = imageData.width;
    var h = imageData.height;
    var src = imageData.data;
    var n = w * h;

    var L = new Float32Array(n);
    var A = new Float32Array(n);
    var Bch = new Float32Array(n);
    var alpha = new Uint8Array(n);
    rgbToLab(src, w, h, L, A, Bch, alpha);
    var L0 = new Float32Array(L);
    var A0 = new Float32Array(A);
    var B0 = new Float32Array(Bch);
    progress(0.08);

    var Ls = boxMean(L, w, h, 1);
    var grad = new Float32Array(n);
    var x, y, i, gx, gy;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        gx = Ls[y * w + (x < w - 1 ? x + 1 : x)] - Ls[y * w + (x > 0 ? x - 1 : x)];
        gy = Ls[(y < h - 1 ? y + 1 : y) * w + x] - Ls[(y > 0 ? y - 1 : y) * w + x];
        grad[i] = Math.sqrt(gx * gx + gy * gy) * 0.5;
      }
    }
    var localL = boxMean(L, w, h, 4);
    var darkEdge = new Uint8Array(n);
    var edgeT = 6.5 + preserve * 3.5;
    for (i = 0; i < n; i++) {
      if (grad[i] > edgeT && L[i] < localL[i] - 2.0) darkEdge[i] = 1;
    }
    progress(0.16);

    var openR = Math.round(6 + strength * 8); /* 6..14, enough for ~20px blobs */
    var closeR = Math.max(2, Math.round(openR * 0.45));
    var tmp = new Float32Array(n);
    var opened = maxFilter(minFilter(L, w, h, openR, tmp), w, h, openR, tmp);
    var closed = minFilter(maxFilter(L, w, h, closeR, tmp), w, h, closeR, tmp);
    progress(0.32);

    var medL = medianFilter(L, w, h, 2);
    var medA = medianFilter(A, w, h, 2);
    var medB = medianFilter(Bch, w, h, 2);
    progress(0.5);

    var strong = new Uint8Array(n);
    var weak = new Uint8Array(n);
    var sens = flatFill ? 1.35 : 0;
    var TopenS = 6.2 - strength * 1.6 - sens * 0.8;
    var TopenW = 3.4 - strength * 1.0 - sens * 0.8;
    var TmedS = 10.0 - strength * 3.0 - sens * 1.6;
    var TmedW = 5.2 - strength * 1.6 - sens * 1.4;
    var TcloseS = 6.0 - strength * 1.5 - sens * 0.7;
    var TcloseW = 3.6 - strength * 1.1 - sens * 0.7;
    for (i = 0; i < n; i++) {
      var dOpen = L[i] - opened[i];
      var dClose = closed[i] - L[i];
      var dL = L[i] - medL[i];
      var dA = A[i] - medA[i];
      var dB = Bch[i] - medB[i];
      var dMed = Math.sqrt(dL * dL + dA * dA + dB * dB);
      var isDarkEdge = darkEdge[i];
      var s =
        dOpen > TopenS ||
        dClose > TcloseS ||
        dMed > TmedS ||
        (dL > 4 && dMed > TmedS * 0.7);
      var wk =
        dOpen > TopenW ||
        dClose > TcloseW ||
        dMed > TmedW ||
        (dL > 2.2 && dMed > TmedW * 0.75);
      /* light crumbs sitting on dark ink should always be candidates */
      var crumb = medL[i] < 40 && dL > 10;
      if (isDarkEdge && !crumb) {
        /* keep lineart; only allow clearly lighter crumbs on the stroke */
        if (!(dOpen > TopenS && dL > 6)) {
          s = false;
          wk = false;
        }
      }
      if (crumb) s = true;
      if (s) strong[i] = 1;
      if (wk || s) weak[i] = 1;
    }
    progress(0.58);

    var maxSize = Math.round(400 + strength * 2800);
    var blotch = labelComponents(strong, w, h, maxSize, function (comp, cs) {
      if (cs < 4) return true;
      var sum = 0;
      for (var k = 0; k < cs; k++) sum += L[comp[k]] - localL[comp[k]];
      /* skip large, mostly-darker structures (should already be excluded) */
      if (sum / cs < -8 && cs > 150) return false;
      return true;
    });
    blotch = growInto(blotch, weak, w, h, 2);
    /* do not grow/dilate into dark ink — that nicks lineart */
    var noInk = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if (darkEdge[i] || L0[i] < 38) noInk[i] = 1;
    }
    blotch = dilate1(blotch, w, h, noInk);
    for (i = 0; i < n; i++) {
      if (noInk[i] && !(medL[i] < 40 && L0[i] - medL[i] > 10)) blotch[i] = 0;
    }
    progress(0.68);

    /* prefill small holes with the fine median, then robust exterior fill */
    for (i = 0; i < n; i++) {
      if (blotch[i]) {
        L[i] = medL[i];
        A[i] = medA[i];
        Bch[i] = medB[i];
      }
    }
    /* use original Lab for exterior samples: keep a copy taken before prefill
       — actually we already overwrote L. Re-read from med is wrong.
       We need originals. Redo: keep orig. */
    progress(0.7);

    /* The prefill already mutated L. Exterior should use *source* colors of
       non-blotch pixels, which were not mutated. OK. */
    var filled = inpaintExterior(L0, A0, B0, blotch, noInk, w, h);
    L = filled.L;
    A = filled.A;
    Bch = filled.B;
    /* restore protected ink if a fill tried to lighten it */
    for (i = 0; i < n; i++) {
      if (L0[i] < 42 && L[i] > L0[i] + 8) {
        L[i] = L0[i];
        A[i] = A0[i];
        Bch[i] = B0[i];
      }
    }
    fillInkHoles(L, A, Bch, L0, A0, B0, w, h);
    /* Structure edges from a median-filtered *original* L, so skin
       speckles are not edges, but lineart / hair / pupils are.
       Dilate 1px to protect antialiased fringes. We never rewrite
       protected pixels — that is what keeps strokes crisp. */
    var structSrc = medianFilter(L0, w, h, 2);
    var structGrad = gradientMag(structSrc, w, h);
    var edgeT = flatFill ? 2.6 + preserve * 1.4 : 3.4 + preserve * 1.6;
    var protect = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if (structGrad[i] > edgeT) protect[i] = 1;
    }
    var edgeCore = new Uint8Array(protect);
    protect = dilate1(protect, w, h, null);
    /* Keep dilated AA only on the dark/ink side so the skin-side 1px
       ring can flatten to the fill. Mid-gray stroke AA stays protected. */
    for (i = 0; i < n; i++) {
      if (protect[i] && !edgeCore[i] && L0[i] >= 72) protect[i] = 0;
    }
    /* Box-smoothed L used as a low-frequency barrier inside regionFlatten. */
    var coarse = boxMean(L0, w, h, 5);
    var coarseGrad = gradientMag(coarse, w, h);
    progress(0.8);

    var filled = null;
    if (flatFill || strength >= 0.35) {
      var minSize = flatFill ? 8 : 24;
      /* Seed threshold must stay below ~14 so cheek (dist~2) does not
         swallow the eye white (dist~15). */
      var colorT = flatFill ? 6.2 + strength * 0.8 : 5.5;
      if (colorT > 7) colorT = 7;
      var startable = new Uint8Array(n);
      var startT = edgeT * 0.5;
      /* require a uniform neighborhood so we never seed from a soft eyelid gradient */
      var meanL = boxMean(L, w, h, 3);
      var tmpL2 = new Float32Array(n);
      for (i = 0; i < n; i++) tmpL2[i] = L[i] * L[i];
      var meanL2 = boxMean(tmpL2, w, h, 3);
      var varCap = flatFill ? 3.5 : 2.5;
      var startRampT = 0.25;
      for (i = 0; i < n; i++) {
        if (protect[i] || structGrad[i] > startT) continue;
        if (coarseGrad[i] > startRampT) continue;
        if (meanL2[i] - meanL[i] * meanL[i] > varCap) continue;
        startable[i] = 1;
      }
      var coarseCap = flatFill ? 2.0 : 1.6;
      filled = new Uint8Array(n);
      var fillC = new Float32Array(n);
      regionFlatten(L, A, Bch, protect, w, h, minSize, true, colorT, startable, coarse, coarseCap, filled, fillC);
      if (flatFill) {
        mergeSimilarFills(L, A, Bch, filled, fillC, w, h, 4.8, coarseCap);
        growFlatFill(L, A, Bch, protect, filled, fillC, L0, coarse, w, h, 6.5, coarseCap, 64);
        absorbEnclosed(L, A, Bch, protect, filled, fillC, L0, coarse, w, h, coarseCap, 80);
        snapSpeckles(L, A, Bch, protect, filled, fillC, L0, coarse, w, h, coarseCap);
        growFlatFill(L, A, Bch, protect, filled, fillC, L0, coarse, w, h, 6.5, coarseCap, 64);
        var inkMask = new Uint8Array(n);
        for (i = 0; i < n; i++) if (L0[i] < 48) inkMask[i] = 1;
        var inkDist = chessboardDist(inkMask, w, h, 16);
        sealToInk(L, A, Bch, filled, fillC, L0, w, h, inkDist);
      }
    } else {
      /* mild median snap only in very flat unprotected areas */
      var medL2 = medianFilter(L, w, h, 2);
      var medA2 = medianFilter(A, w, h, 2);
      var medB2 = medianFilter(Bch, w, h, 2);
      var mild = 0.3 + strength * 0.4;
      for (i = 0; i < n; i++) {
        if (protect[i]) continue;
        L[i] = medL2[i] * mild + L[i] * (1 - mild);
        A[i] = medA2[i] * mild + A[i] * (1 - mild);
        Bch[i] = medB2[i] * mild + Bch[i] * (1 - mild);
      }
    }
    progress(0.9);

    /* Chroma tidy only off edges, so lineart color is untouched.
       Keep the radius small: interiors are already flattened, and a
       wide guided filter bleeds skin chroma through soft lids. */
    var rC = flatFill ? 2 : Math.round(2 + strength * 4);
    var epsC = flatFill ? 6 : 4 + strength * 8;
    var gA = guidedFilter(A, L, w, h, rC, epsC);
    var gB = guidedFilter(Bch, L, w, h, rC, epsC);
    var filledSkip = typeof filled !== "undefined" ? filled : null;
    for (i = 0; i < n; i++) {
      if (protect[i]) continue;
      if (filledSkip && filledSkip[i]) continue;
      A[i] = gA[i];
      Bch[i] = gB[i];
    }
    /* Very light unsharp on real structure edges only. */
    var blurL = boxMean(L, w, h, 1);
    var amt = 0.14 * preserve;
    for (i = 0; i < n; i++) {
      if (structGrad[i] <= edgeT) continue;
      var e = (structGrad[i] - edgeT) / 10;
      if (e > 1) e = 1;
      /* ink-side only: light-side unsharp pops the white seam and crumbs */
      var sh = (L[i] - blurL[i]) * amt * e;
      if (sh < 0) L[i] += sh;
    }
    progress(0.93);
    /* v6: whole-image snap to the estimated cel palette. Default on
       whenever 纯净平涂 is on, so one-click uses this path. */
    if (flatFill && options.paletteClean !== false) {
      paletteClean(L, A, Bch, L0, w, h, protect, structGrad, edgeT, options.paletteOut || null);
    }
    progress(0.97);

    var out;
    if (typeof Uint8ClampedArray !== "undefined") {
      out = new Uint8ClampedArray(src.length);
    } else {
      out = new Uint8Array(src.length);
    }
    out.set(src);
    labToRgbInto(L, A, Bch, alpha, w, h, out, mask);
    progress(1);
    return { data: out, width: w, height: h };
  }

  var api = {
    denoise: denoise,
    rgbToLab: rgbToLab,
    boxMean: boxMean,
    guidedFilter: guidedFilter,
    minFilter: minFilter,
    maxFilter: maxFilter,
    medianFilter: medianFilter,
    kuwaharaLab: kuwaharaLab,
    regionFlatten: regionFlatten,
    gradientMag: gradientMag,
    clamp: clamp,
    extractCelPalette: extractCelPalette,
    paletteClean: paletteClean,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.DenoiseCore = api;
})(typeof self !== "undefined" ? self : typeof global !== "undefined" ? global : this);
