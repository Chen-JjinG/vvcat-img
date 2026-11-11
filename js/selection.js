(function (global) {
  "use strict";
  var Color = null;
  function C() {
    return Color || (Color = global.DN.Color);
  }

  function Selection() {
    this.w = 0;
    this.h = 0;
    this.mask = null;
    this.antsPhase = 0;
    this._edgeList = null;
    this._bounds = null;
  }

  Selection.prototype.resize = function (w, h) {
    this.w = w;
    this.h = h;
    this.mask = null;
    this._edgeList = null;
    this._bounds = null;
  };

  Selection.prototype.has = function () {
    return !!this.mask;
  };

  Selection.prototype.clear = function () {
    this.mask = null;
    this._edgeList = null;
    this._bounds = null;
  };

  Selection.prototype.getMask = function () {
    return this.mask;
  };

  Selection.prototype.cloneMask = function () {
    if (!this.mask) return null;
    var m = new Uint8Array(this.mask.length);
    m.set(this.mask);
    return m;
  };

  Selection.prototype.setMask = function (mask, w, h) {
    if (!mask) {
      this.clear();
      return;
    }
    this.w = w;
    this.h = h;
    var any = false;
    for (var i = 0; i < mask.length; i++) {
      if (mask[i]) {
        any = true;
        break;
      }
    }
    if (!any) {
      this.clear();
      return;
    }
    this.mask = mask;
    this._edgeList = null;
    this._bounds = null;
  };

  Selection.prototype.restore = function (snap) {
    if (snap && snap.selection) this.setMask(snap.selection, snap.selW, snap.selH);
    else this.clear();
  };

  function addMode(dst, src, mode) {
    var n = dst.length;
    var i;
    if (mode === "add") {
      for (i = 0; i < n; i++) if (src[i] > dst[i]) dst[i] = src[i];
    } else if (mode === "subtract") {
      for (i = 0; i < n; i++) {
        var v = dst[i] - src[i];
        dst[i] = v < 0 ? 0 : v;
      }
    } else {
      dst.set(src);
    }
    return dst;
  }

  Selection.prototype.commitMask = function (next, mode) {
    if (!next) return;
    if (!this.mask || mode === "replace" || !mode) {
      this.setMask(next, this.w, this.h);
      return;
    }
    var merged = new Uint8Array(this.mask);
    addMode(merged, next, mode);
    this.setMask(merged, this.w, this.h);
  };

  /* ---- geometry selections ---- */

  Selection.prototype.fromRect = function (x0, y0, x1, y1) {
    var w = this.w, h = this.h;
    var m = new Uint8Array(w * h);
    if (x1 < x0) { var t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { var t2 = y0; y0 = y1; y1 = t2; }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(w - 1, Math.ceil(x1));
    y1 = Math.min(h - 1, Math.ceil(y1));
    for (var y = y0; y <= y1; y++) {
      var row = y * w;
      for (var x = x0; x <= x1; x++) m[row + x] = 255;
    }
    return m;
  };

  Selection.prototype.fromEllipse = function (x0, y0, x1, y1) {
    var w = this.w, h = this.h;
    var m = new Uint8Array(w * h);
    var cx = (x0 + x1) / 2,
      cy = (y0 + y1) / 2;
    var rx = Math.abs(x1 - x0) / 2,
      ry = Math.abs(y1 - y0) / 2;
    if (rx < 0.5) rx = 0.5;
    if (ry < 0.5) ry = 0.5;
    var minx = Math.max(0, Math.floor(cx - rx));
    var maxx = Math.min(w - 1, Math.ceil(cx + rx));
    var miny = Math.max(0, Math.floor(cy - ry));
    var maxy = Math.min(h - 1, Math.ceil(cy + ry));
    for (var y = miny; y <= maxy; y++) {
      for (var x = minx; x <= maxx; x++) {
        var nx = (x + 0.5 - cx) / rx;
        var ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1) m[y * w + x] = 255;
      }
    }
    return m;
  };

  Selection.prototype.fromLasso = function (points) {
    var w = this.w, h = this.h;
    var m = new Uint8Array(w * h);
    if (!points || points.length < 3) return m;
    var minx = w, miny = h, maxx = 0, maxy = 0, i, j;
    for (i = 0; i < points.length; i++) {
      var px = points[i].x, py = points[i].y;
      if (px < minx) minx = px;
      if (py < miny) miny = py;
      if (px > maxx) maxx = px;
      if (py > maxy) maxy = py;
    }
    minx = Math.max(0, Math.floor(minx));
    miny = Math.max(0, Math.floor(miny));
    maxx = Math.min(w - 1, Math.ceil(maxx));
    maxy = Math.min(h - 1, Math.ceil(maxy));
    /* even-odd fill */
    for (var y = miny; y <= maxy; y++) {
      var row = y * w;
      var cy = y + 0.5;
      for (var x = minx; x <= maxx; x++) {
        var cx = x + 0.5;
        var inside = false;
        for (i = 0, j = points.length - 1; i < points.length; j = i++) {
          var xi = points[i].x, yi = points[i].y;
          var xj = points[j].x, yj = points[j].y;
          if (yi > cy !== yj > cy &&
              cx < ((xj - xi) * (cy - yi)) / (yj - yi + 0.0) + xi) {
            inside = !inside;
          }
        }
        if (inside) m[row + x] = 255;
      }
    }
    return m;
  };

  /* Procreate-like automatic selection: contiguous flood from a seed
     with Lab distance < threshold. */
  Selection.prototype.autoFromPoint = function (imageData, sx, sy, threshold) {
    var w = this.w, h = this.h;
    var m = new Uint8Array(w * h);
    sx = Math.round(sx);
    sy = Math.round(sy);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return m;
    var data = imageData.data;
    var i0 = (sy * w + sx) * 4;
    var seed = C().rgbToLab(data[i0], data[i0 + 1], data[i0 + 2]);
    var stack = [sx, sy];
    var seen = new Uint8Array(w * h);
    seen[sy * w + sx] = 1;
    var labCache = new Float32Array(w * h * 3);
    var computed = new Uint8Array(w * h);
    function labAt(x, y) {
      var idx = y * w + x;
      if (!computed[idx]) {
        var o = idx * 4;
        var lab = C().rgbToLab(data[o], data[o + 1], data[o + 2]);
        labCache[idx * 3] = lab.L;
        labCache[idx * 3 + 1] = lab.a;
        labCache[idx * 3 + 2] = lab.b;
        computed[idx] = 1;
      }
      return idx;
    }
    computed[sy * w + sx] = 1;
    labCache[(sy * w + sx) * 3] = seed.L;
    labCache[(sy * w + sx) * 3 + 1] = seed.a;
    labCache[(sy * w + sx) * 3 + 2] = seed.b;
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
    var T = Math.max(0.5, threshold);
    while (stack.length) {
      var y = stack.pop();
      var x = stack.pop();
      m[y * w + x] = 255;
      for (var a = 0; a < 16; a += 2) {
        var nx = x + dirs[a], ny = y + dirs[a + 1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = ny * w + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        var li = labAt(nx, ny) * 3;
        var dL = labCache[li] - seed.L;
        var da = labCache[li + 1] - seed.a;
        var db = labCache[li + 2] - seed.b;
        if (Math.sqrt(dL * dL + da * da + db * db) <= T) {
          stack.push(nx, ny);
        }
      }
    }
    return m;
  };

  Selection.prototype.invert = function () {
    if (!this.mask) {
      var m = new Uint8Array(this.w * this.h);
      m.fill(255);
      this.setMask(m, this.w, this.h);
      return;
    }
    var n = this.mask.length;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = 255 - this.mask[i];
    this.setMask(out, this.w, this.h);
  };

  function morph(mask, w, h, radius, dilate) {
    if (!mask || radius <= 0) return mask;
    var out = new Uint8Array(mask);
    var tmp = new Uint8Array(mask.length);
    var r = Math.max(1, Math.round(radius));
    var x, y, k, i, v, xx, row;
    /* separable min/max */
    for (y = 0; y < h; y++) {
      row = y * w;
      for (x = 0; x < w; x++) {
        v = dilate ? 0 : 255;
        for (k = -r; k <= r; k++) {
          xx = x + k;
          if (xx < 0) xx = 0;
          else if (xx >= w) xx = w - 1;
          i = mask[row + xx];
          if (dilate) { if (i > v) v = i; } else { if (i < v) v = i; }
        }
        tmp[row + x] = v;
      }
    }
    for (x = 0; x < w; x++) {
      for (y = 0; y < h; y++) {
        v = dilate ? 0 : 255;
        for (k = -r; k <= r; k++) {
          var yy = y + k;
          if (yy < 0) yy = 0;
          else if (yy >= h) yy = h - 1;
          i = tmp[yy * w + x];
          if (dilate) { if (i > v) v = i; } else { if (i < v) v = i; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  Selection.prototype.expand = function (px) {
    if (!this.mask) return;
    this.setMask(morph(this.mask, this.w, this.h, px, true), this.w, this.h);
  };
  Selection.prototype.contract = function (px) {
    if (!this.mask) return;
    this.setMask(morph(this.mask, this.w, this.h, px, false), this.w, this.h);
  };

  Selection.prototype.feather = function (px) {
    if (!this.mask || px <= 0) return;
    var r = Math.max(1, Math.round(px));
    var w = this.w, h = this.h;
    var src = this.mask;
    /* box blur iterated ~3 times ≈ gaussian */
    function box(src) {
      var tmp = new Uint8Array(src.length);
      var out = new Uint8Array(src.length);
      var x, y, k, acc, row, xx, yy;
      var size = r * 2 + 1;
      for (y = 0; y < h; y++) {
        row = y * w;
        acc = 0;
        for (k = -r; k <= r; k++) {
          xx = k < 0 ? 0 : k >= w ? w - 1 : k;
          acc += src[row + xx];
        }
        for (x = 0; x < w; x++) {
          tmp[row + x] = Math.round(acc / size);
          var outX = x + r + 1;
          var inX = x - r;
          acc += src[row + (outX >= w ? w - 1 : outX)] - src[row + (inX < 0 ? 0 : inX)];
        }
      }
      for (x = 0; x < w; x++) {
        acc = 0;
        for (k = -r; k <= r; k++) {
          yy = k < 0 ? 0 : k >= h ? h - 1 : k;
          acc += tmp[yy * w + x];
        }
        for (y = 0; y < h; y++) {
          out[y * w + x] = Math.round(acc / size);
          var outY = y + r + 1;
          var inY = y - r;
          acc += tmp[(outY >= h ? h - 1 : outY) * w + x] - tmp[(inY < 0 ? 0 : inY) * w + x];
        }
      }
      return out;
    }
    var m = box(src);
    m = box(m);
    this.setMask(m, w, h);
  };

  Selection.prototype.bounds = function () {
    if (this._bounds) return this._bounds;
    if (!this.mask) return null;
    var w = this.w, h = this.h, m = this.mask;
    var minx = w, miny = h, maxx = -1, maxy = -1;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        if (m[row + x]) {
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }
    if (maxx < 0) return (this._bounds = null);
    return (this._bounds = { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 });
  };

  Selection.prototype.ensureEdges = function () {
    if (this._edgeList) return this._edgeList;
    var list = [];
    if (!this.mask) return (this._edgeList = list);
    var w = this.w, h = this.h, m = this.mask;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        if (
          x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          !m[y * w + x - 1] || !m[y * w + x + 1] ||
          !m[(y - 1) * w + x] || !m[(y + 1) * w + x]
        ) {
          list.push(x, y);
        }
      }
    }
    this._edgeList = list;
    return list;
  };

  Selection.prototype.drawAnts = function (ctx, phase) {
    if (!this.mask) return;
    var list = this.ensureEdges();
    var p = phase == null ? this.antsPhase : phase;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (var i = 0; i < list.length; i += 2) {
      var x = list[i], y = list[i + 1];
      var on = ((x + y + p) & 7) < 4;
      ctx.fillStyle = on ? "#f4f1ea" : "#1a1a1c";
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.restore();
  };

  /* Clip a drawing operation to the (possibly feathered) selection. */
  Selection.prototype.constrainCanvas = function () {
    if (!this.mask) return null;
    var c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    var ctx = c.getContext("2d");
    var id = ctx.createImageData(this.w, this.h);
    var d = id.data, m = this.mask;
    for (var i = 0; i < m.length; i++) {
      d[i * 4 + 3] = m[i];
    }
    ctx.putImageData(id, 0, 0);
    return c;
  };

  Selection.prototype.contains = function (x, y) {
    if (!this.mask) return true;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.mask[y * this.w + x] > 0;
  };

  global.DN = global.DN || {};
  global.DN.Selection = Selection;
})(typeof window !== "undefined" ? window : self);
