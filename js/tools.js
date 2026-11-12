(function (global) {
  "use strict";

  function Tools() {
    this.name = "brush";
    this.size = 24;
    this.opacity = 1;
    this.hardness = 0.82;
    this.color = { r: 212, g: 154, b: 122 };
    this.fillTolerance = 22;
    this.fillContiguous = true;
    this.smudgeStrength = 0.6;
    this.selectThreshold = 16;
    this.usePressure = true;
    this._tip = null;
    this._tipKey = "";
    this._stroke = null;
  }

  Tools.prototype.setTool = function (name) {
    this.name = name;
    this._stroke = null;
  };

  Tools.prototype.setColor = function (r, g, b) {
    this.color = { r: r, g: g, b: b };
    this._tipKey = "";
  };

  function buildTip(size, hardness, r, g, b, eraser) {
    var d = Math.max(1, Math.ceil(size) + 2);
    var c = document.createElement("canvas");
    c.width = d;
    c.height = d;
    var ctx = c.getContext("2d");
    var cx = d / 2, cy = d / 2;
    var rad = size / 2;
    var inner = rad * Math.max(0, Math.min(1, hardness));
    if (hardness >= 0.97) inner = Math.max(0, rad - 0.8);
    var grd = ctx.createRadialGradient(cx, cy, inner * 0.2, cx, cy, rad);
    var rgb = eraser ? "0,0,0" : r + "," + g + "," + b;
    grd.addColorStop(0, "rgba(" + rgb + ",1)");
    var mid = rad <= 0 ? 1 : Math.min(0.995, inner / rad);
    if (mid > 0.02) grd.addColorStop(mid, "rgba(" + rgb + ",1)");
    grd.addColorStop(1, "rgba(" + rgb + ",0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, d, d);
    return c;
  }

  Tools.prototype.getTip = function (eraser) {
    var s = this.size;
    var key = (eraser ? "e" : "b") + "|" + s + "|" + this.hardness + "|" +
      this.color.r + "," + this.color.g + "," + this.color.b;
    if (this._tipKey !== key) {
      this._tip = buildTip(s, this.hardness, this.color.r, this.color.g, this.color.b, eraser);
      this._tipKey = key;
    }
    return this._tip;
  };

  Tools.prototype.pressureScale = function (ev) {
    if (!this.usePressure || !ev) return 1;
    var type = ev.pointerType;
    var p = ev.pressure;
    if (type === "pen" || type === "stylus") {
      if (p == null || p <= 0) return 0.15;
      return 0.12 + 0.88 * p;
    }
    if (typeof p === "number" && p > 0 && p < 1 && p !== 0.5) {
      return 0.2 + 0.8 * p;
    }
    return 1;
  };

  Tools.prototype._bindTarget = function (layers, selection) {
    var canvas = layers.activeCanvas();
    this._destCtx = canvas ? canvas.getContext("2d") : null;
    this._clip = selection && selection.has() ? selection.constrainCanvas() : null;
    return !!this._destCtx;
  };

  /* Draw a dab that was painted in destination coordinates, clipped once. */
  Tools.prototype._commitDab = function (source, sx, sy, sw, sh, dx, dy, dw, dh, op, eraser) {
    var ctx = this._destCtx;
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    ctx.globalAlpha = op;
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
  };

  Tools.prototype.beginStroke = function (x, y, ev, layers, selection) {
    if (!this._bindTarget(layers, selection)) return;
    this._stroke = {
      x: x,
      y: y,
      tool: this.name,
      dist: 0,
    };
    if (this.name === "smudge") {
      this._smudgeWork = document.createElement("canvas");
      this._smudgeWork.width = layers.w;
      this._smudgeWork.height = layers.h;
      layers.compositeTo(this._smudgeWork.getContext("2d"));
    }
    this._stampAt(x, y, ev, layers, selection, true);
  };

  Tools.prototype.moveStroke = function (x, y, ev, layers, selection) {
    if (!this._stroke) {
      this.beginStroke(x, y, ev, layers, selection);
      return;
    }
    var x0 = this._stroke.x, y0 = this._stroke.y;
    var dx = x - x0, dy = y - y0;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var spacing = Math.max(0.4, this.size * 0.12);
    if (this.name === "smudge") spacing = Math.max(0.6, this.size * 0.18);
    if (dist < spacing && this.name !== "smudge") {
      return;
    }
    var steps = Math.max(1, Math.ceil(dist / spacing));
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      this._stampAt(x0 + dx * t, y0 + dy * t, ev, layers, selection, false);
    }
    this._stroke.x = x;
    this._stroke.y = y;
    this._stroke.dist += dist;
  };

  Tools.prototype.endStroke = function () {
    this._stroke = null;
    this._smudgeWork = null;
  };

  Tools.prototype._stampAt = function (x, y, ev, layers, selection, first) {
    var tool = this.name;
    var pr = this.pressureScale(ev);
    var size = this.size * (0.35 + 0.65 * pr);
    /* keep a local size just for this stamp by scaling the tip draw */
    if (tool === "eraser" || tool === "brush") {
      var eraser = tool === "eraser";
      var tip = this.getTip(eraser);
      var op = this.opacity * (0.35 + 0.65 * pr);
      var dw = tip.width * (size / this.size);
      var dh = tip.height * (size / this.size);
      var left = x - dw / 2;
      var top = y - dh / 2;
      if (!this._clip) {
        this._commitDab(tip, 0, 0, tip.width, tip.height, left, top, dw, dh, op, eraser);
        return;
      }
      var side = Math.ceil(Math.max(dw, dh)) + 2;
      var dab = this._dab;
      if (!dab || dab.width < side || dab.height < side) {
        dab = this._dab = document.createElement("canvas");
        dab.width = dab.height = Math.max(64, side);
      }
      var sctx = dab.getContext("2d");
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = "source-over";
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, dw + 1, dh + 1);
      sctx.drawImage(tip, 0, 0, dw, dh);
      sctx.globalCompositeOperation = "destination-in";
      sctx.drawImage(this._clip, left, top, dw, dh, 0, 0, dw, dh);
      this._commitDab(dab, 0, 0, dw, dh, left, top, dw, dh, op, eraser);
      return;
    }
    if (tool === "smudge") {
      this._smudgeStamp(x, y, ev, layers, selection, first, size, pr);
    }
  };

  Tools.prototype._smudgeStamp = function (x, y, ev, layers, selection, first, size, pr) {
    if (!this._smudgeWork) return;
    if (first) {
      this._smudgePrev = { x: x, y: y };
      return;
    }
    var prev = this._smudgePrev || { x: x, y: y };
    var dx = x - prev.x, dy = y - prev.y;
    var strength = this.smudgeStrength * (0.5 + 0.5 * pr);
    var srcX = x - dx * (0.6 + 0.8 * strength);
    var srcY = y - dy * (0.6 + 0.8 * strength);
    var rad = Math.max(1, size / 2);
    var d = Math.ceil(size) + 2;
    var stamp = this._smudgeStampCanvas;
    if (!stamp || stamp.width < d) {
      stamp = this._smudgeStampCanvas = document.createElement("canvas");
      stamp.width = stamp.height = Math.max(64, d);
    }
    var sctx = stamp.getContext("2d");
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, d, d);
    sctx.drawImage(this._smudgeWork, srcX - d / 2, srcY - d / 2, d, d, 0, 0, d, d);
    /* soft mask */
    sctx.globalCompositeOperation = "destination-in";
    var grd = sctx.createRadialGradient(d / 2, d / 2, rad * this.hardness * 0.2, d / 2, d / 2, rad);
    grd.addColorStop(0, "rgba(0,0,0,1)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = grd;
    sctx.fillRect(0, 0, d, d);

    if (this._clip) {
      sctx.globalCompositeOperation = "destination-in";
      sctx.drawImage(this._clip, x - d / 2, y - d / 2, d, d, 0, 0, d, d);
      sctx.globalCompositeOperation = "source-over";
    }

    var alpha = 0.35 + 0.6 * strength;
    var wctx = this._smudgeWork.getContext("2d");
    wctx.save();
    wctx.globalAlpha = alpha;
    wctx.drawImage(stamp, x - d / 2, y - d / 2);
    wctx.restore();
    this._commitDab(stamp, 0, 0, d, d, x - d / 2, y - d / 2, d, d, alpha, false);
    this._smudgePrev = { x: x, y: y };
  };

  Tools.prototype.sample = function (layers, x, y) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= layers.w || y >= layers.h) return null;
    return layers.samplePixel(x, y);
  };

  Tools.prototype.fill = function (layers, selection, x, y) {
    x = Math.round(x);
    y = Math.round(y);
    var w = layers.w, h = layers.h;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    var target = layers.activeCanvas();
    if (!target) return false;
    if (selection && selection.has() && !selection.contains(x, y)) return false;
    var src = layers.getCompositeImageData().data;
    var Color = global.DN.Color;
    var i0 = (y * w + x) * 4;
    var seed = new Float32Array(3);
    var pix = new Float32Array(3);
    Color.writeLab(src[i0], src[i0 + 1], src[i0 + 2], seed, 0);
    var T = this.fillTolerance;
    var limit = T * T;
    var gate = (T * 3 + 12) * (T * 3 + 12);
    var sr = src[i0], sg = src[i0 + 1], sb = src[i0 + 2];
    var selMask = selection && selection.has() ? selection.mask : null;
    var cr = this.color.r, cg = this.color.g, cb = this.color.b;
    var op = this.opacity;
    var hits = [];
    var minx = w, miny = h, maxx = -1, maxy = -1;

    function match(ix, iy) {
      var o = (iy * w + ix) * 4;
      var dr = src[o] - sr, dg = src[o + 1] - sg, db = src[o + 2] - sb;
      if (dr * dr + dg * dg + db * db > gate) return false;
      Color.writeLab(src[o], src[o + 1], src[o + 2], pix, 0);
      return Color.labDist2(pix[0], pix[1], pix[2], seed[0], seed[1], seed[2]) <= limit;
    }
    function paint(ix, iy) {
      var idx = iy * w + ix;
      if (selMask && !selMask[idx]) return;
      hits.push(idx);
      if (ix < minx) minx = ix;
      if (iy < miny) miny = iy;
      if (ix > maxx) maxx = ix;
      if (iy > maxy) maxy = iy;
    }

    if (this.fillContiguous) {
      var seen = new Uint8Array(w * h);
      var stackX = [x];
      var stackY = [y];
      seen[y * w + x] = 1;
      function consider(nx, ny) {
        var ni = ny * w + nx;
        if (seen[ni]) return;
        if (selMask && !selMask[ni]) return;
        seen[ni] = 1;
        stackX.push(nx);
        stackY.push(ny);
      }
      while (stackX.length) {
        var cy = stackY.pop();
        var cx = stackX.pop();
        if (selMask && !selMask[cy * w + cx]) continue;
        if (!match(cx, cy)) continue;
        paint(cx, cy);
        if (cx + 1 < w) consider(cx + 1, cy);
        if (cx > 0) consider(cx - 1, cy);
        if (cy + 1 < h) consider(cx, cy + 1);
        if (cy > 0) consider(cx, cy - 1);
      }
    } else {
      for (var iy = 0; iy < h; iy++) {
        for (var ix = 0; ix < w; ix++) {
          if (selMask && !selMask[iy * w + ix]) continue;
          if (match(ix, iy)) paint(ix, iy);
        }
      }
    }
    if (!hits.length) return false;
    var bw = maxx - minx + 1;
    var bh = maxy - miny + 1;
    var dest = new Uint8ClampedArray(bw * bh * 4);
    var baseA = Math.round(op * 255);
    for (var n = 0; n < hits.length; n++) {
      var idx = hits[n];
      var px = idx % w;
      var py = (idx / w) | 0;
      var a = baseA;
      if (selMask) a = Math.round(baseA * (selMask[idx] / 255));
      var o = ((py - miny) * bw + (px - minx)) * 4;
      dest[o] = cr;
      dest[o + 1] = cg;
      dest[o + 2] = cb;
      dest[o + 3] = a;
    }
    var tmp = document.createElement("canvas");
    tmp.width = bw;
    tmp.height = bh;
    tmp.getContext("2d").putImageData(new ImageData(dest, bw, bh), 0, 0);
    target.getContext("2d").drawImage(tmp, minx, miny);
    return true;
  };

  global.DN = global.DN || {};
  global.DN.Tools = Tools;
})(typeof window !== "undefined" ? window : self);
