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
    this._rev = 0;
    this._clipCanvas = null;
    this._clipRev = -1;
  }

  Selection.prototype.resize = function (w, h) {
    this.w = w;
    this.h = h;
    this.mask = null;
    this._edgeList = null;
    this._bounds = null;
    this._rev++;
  };

  Selection.prototype.has = function () {
    return !!this.mask;
  };

  Selection.prototype.clear = function () {
    this.mask = null;
    this._edgeList = null;
    this._bounds = null;
    this._rev++;
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
    this._rev++;
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

  /* Contiguous magic-wand flood. Lab is cached per visited pixel so
     tolerance drags do not convert RGB again. 4-connected scanline. */
  function AutoSession(imageData, w, h, sx, sy) {
    this.w = w;
    this.h = h;
    this.data = imageData.data;
    this.sx = sx | 0;
    this.sy = sy | 0;
    this.n = w * h;
    this.lab = new Float32Array(this.n * 3);
    this.haveLab = new Uint8Array(this.n);
    this.mask = new Uint8Array(this.n);
    this.threshold = -1;
    this.bounds = { minx: this.sx, miny: this.sy, maxx: this.sx, maxy: this.sy };
    var o = (this.sy * w + this.sx) * 4;
    var seed = new Float32Array(3);
    C().writeLab(this.data[o], this.data[o + 1], this.data[o + 2], seed, 0);
    this.sL = seed[0];
    this.sa = seed[1];
    this.sb = seed[2];
    this.haveLab[this.sy * w + this.sx] = 1;
    this.lab[(this.sy * w + this.sx) * 3] = seed[0];
    this.lab[(this.sy * w + this.sx) * 3 + 1] = seed[1];
    this.lab[(this.sy * w + this.sx) * 3 + 2] = seed[2];
  }

  AutoSession.prototype._dist2 = function (x, y) {
    var i = y * this.w + x;
    var o3 = i * 3;
    if (!this.haveLab[i]) {
      var o = i * 4;
      var d = this.data;
      C().writeLab(d[o], d[o + 1], d[o + 2], this.lab, o3);
      this.haveLab[i] = 1;
    }
    return C().labDist2(this.lab[o3], this.lab[o3 + 1], this.lab[o3 + 2], this.sL, this.sa, this.sb);
  };

  AutoSession.prototype._fill = function (limit) {
    var w = this.w, h = this.h;
    var mask = this.mask;
    mask.fill(0);
    var sx = this.sx, sy = this.sy;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
      this.bounds = { minx: 0, miny: 0, maxx: -1, maxy: -1 };
      return;
    }
    var self = this;
    function ok(x, y) { return self._dist2(x, y) <= limit; }
    var stackX = [];
    var stackY = [];
    stackX.push(sx);
    stackY.push(sy);
    var minx = sx, miny = sy, maxx = sx, maxy = sy;
    while (stackX.length) {
      var y = stackY.pop();
      var x = stackX.pop();
      var row = y * w;
      if (mask[row + x]) continue;
      var lx = x;
      while (lx > 0 && ok(lx - 1, y) && !mask[row + lx - 1]) lx--;
      var rx = x;
      while (rx < w - 1 && ok(rx + 1, y) && !mask[row + rx + 1]) rx++;
      if (lx < minx) minx = lx;
      if (rx > maxx) maxx = rx;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      var up = false;
      var down = false;
      for (var i = lx; i <= rx; i++) {
        mask[row + i] = 255;
        if (y > 0) {
          var above = (y - 1) * w + i;
          if (!mask[above] && ok(i, y - 1)) {
            if (!up) { stackX.push(i); stackY.push(y - 1); up = true; }
          } else up = false;
        }
        if (y < h - 1) {
          var below = (y + 1) * w + i;
          if (!mask[below] && ok(i, y + 1)) {
            if (!down) { stackX.push(i); stackY.push(y + 1); down = true; }
          } else down = false;
        }
      }
    }
    this.bounds = { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
  };

  AutoSession.prototype.ensure = function (threshold) {
    var t = threshold < 0.5 ? 0.5 : threshold > 140 ? 140 : threshold;
    if (this.threshold >= 0 && Math.abs(t - this.threshold) < 0.34) return this.mask;
    this.threshold = t;
    this._fill(t * t);
    return this.mask;
  };

  Selection.prototype.autoFromPoint = function (imageData, sx, sy, threshold) {
    var session = new AutoSession(imageData, this.w, this.h, Math.round(sx), Math.round(sy));
    var mask = session.ensure(threshold);
    var copy = new Uint8Array(mask.length);
    copy.set(mask);
    return copy;
  };

  Selection.prototype.traceEdges = function (mask, w, h, bounds) {
    var list = [];
    if (!mask) return list;
    w = w || this.w;
    h = h || this.h;
    var x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    if (bounds && bounds.maxx >= bounds.minx) {
      x0 = bounds.minx; y0 = bounds.miny; x1 = bounds.maxx; y1 = bounds.maxy;
    }
    for (var y = y0; y <= y1; y++) {
      var row = y * w;
      var up = y > 0 ? row - w : -1;
      var down = y < h - 1 ? row + w : -1;
      for (var x = x0; x <= x1; x++) {
        if (!mask[row + x]) continue;
        if (
          x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          !mask[row + x - 1] || !mask[row + x + 1] ||
          up < 0 || !mask[up + x] || down < 0 || !mask[down + x]
        ) list.push(x, y);
      }
    }
    return list;
  };

  function paintAnts(ctx, edges, phase) {
    if (!edges || !edges.length) return;
    var p = phase | 0;
    var i, x, y;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.beginPath();
    for (i = 0; i < edges.length; i += 2) {
      x = edges[i]; y = edges[i + 1];
      if (((x + y + p) & 7) < 4) continue;
      ctx.rect(x, y, 1, 1);
    }
    ctx.fillStyle = "#1a1a1c";
    ctx.fill();
    ctx.beginPath();
    for (i = 0; i < edges.length; i += 2) {
      x = edges[i]; y = edges[i + 1];
      if (((x + y + p) & 7) >= 4) continue;
      ctx.rect(x, y, 1, 1);
    }
    ctx.fillStyle = "#f4f1ea";
    ctx.fill();
    ctx.restore();
  }

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
    paintAnts(ctx, this.ensureEdges(), phase == null ? this.antsPhase : phase);
  };

  Selection.prototype.drawEdgeAnts = function (ctx, edges, phase) {
    paintAnts(ctx, edges, phase);
  };

  /* Clip a drawing operation to the (possibly feathered) selection. */
  Selection.prototype.constrainCanvas = function () {
    if (!this.mask) return null;
    if (this._clipCanvas && this._clipRev === this._rev) return this._clipCanvas;
    var c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    var ctx = c.getContext("2d");
    var id = ctx.createImageData(this.w, this.h);
    var d = id.data, m = this.mask;
    for (var i = 0; i < m.length; i++) d[i * 4 + 3] = m[i];
    ctx.putImageData(id, 0, 0);
    this._clipCanvas = c;
    this._clipRev = this._rev;
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
  global.DN.AutoSession = AutoSession;
})(typeof window !== "undefined" ? window : self);
