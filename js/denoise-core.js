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

  /**
   * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} imageData
   * @param {{strength?:number,preserveEdges?:number,flatFill?:boolean,mask?:Uint8Array,onProgress?:Function}} [options]
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
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.DenoiseCore = api;
})(typeof self !== "undefined" ? self : typeof global !== "undefined" ? global : this);
