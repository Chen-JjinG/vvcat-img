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

  function withSelectionClip(layers, selection, drawFn) {
    var dest = layers.retouch;
    var ctx = dest.getContext("2d");
    if (!selection || !selection.has()) {
      drawFn(ctx);
      return;
    }
    var tmp = document.createElement("canvas");
    tmp.width = layers.w;
    tmp.height = layers.h;
    var tctx = tmp.getContext("2d");
    drawFn(tctx);
    var clip = selection.constrainCanvas();
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(clip, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }

  Tools.prototype.beginStroke = function (x, y, ev, layers, selection) {
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
      var wctx = this._smudgeWork.getContext("2d");
      layers.compositeTo(wctx);
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
      var tip = this.getTip(tool === "eraser");
      var op = this.opacity * (0.35 + 0.65 * pr);
      var dw = tip.width * (size / this.size);
      var dh = tip.height * (size / this.size);
      withSelectionClip(layers, selection, function (ctx) {
        ctx.save();
        if (tool === "eraser") ctx.globalCompositeOperation = "destination-out";
        else ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = op;
        ctx.drawImage(tip, x - dw / 2, y - dh / 2, dw, dh);
        ctx.restore();
      });
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
    var stamp = document.createElement("canvas");
    stamp.width = d;
    stamp.height = d;
    var sctx = stamp.getContext("2d");
    sctx.drawImage(this._smudgeWork, srcX - d / 2, srcY - d / 2, d, d, 0, 0, d, d);
    /* soft mask */
    sctx.globalCompositeOperation = "destination-in";
    var grd = sctx.createRadialGradient(d / 2, d / 2, rad * this.hardness * 0.2, d / 2, d / 2, rad);
    grd.addColorStop(0, "rgba(0,0,0,1)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = grd;
    sctx.fillRect(0, 0, d, d);

    var wctx = this._smudgeWork.getContext("2d");
    wctx.save();
    wctx.globalAlpha = 0.35 + 0.6 * strength;
    wctx.drawImage(stamp, x - d / 2, y - d / 2);
    wctx.restore();

    withSelectionClip(layers, selection, function (ctx) {
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.6 * strength;
      ctx.drawImage(stamp, x - d / 2, y - d / 2);
      ctx.restore();
    });
    this._smudgePrev = { x: x, y: y };
  };

  Tools.prototype.sample = function (layers, x, y) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= layers.w || y >= layers.h) return null;
    var c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    var ctx = c.getContext("2d");
    if (layers.bgVisible && layers.bg) ctx.drawImage(layers.bg, -x, -y);
    if (layers.retouchVisible && layers.retouch) ctx.drawImage(layers.retouch, -x, -y);
    var d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] < 8) return { r: d[0], g: d[1], b: d[2], a: d[3], empty: true };
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  };

  Tools.prototype.fill = function (layers, selection, x, y) {
    x = Math.round(x);
    y = Math.round(y);
    var w = layers.w, h = layers.h;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    if (selection && selection.has() && !selection.contains(x, y)) return;
    var composite = layers.getCompositeImageData();
    var src = composite.data;
    var i0 = (y * w + x) * 4;
    var Color = global.DN.Color;
    var seed = Color.rgbToLab(src[i0], src[i0 + 1], src[i0 + 2]);
    var T = this.fillTolerance;
    var selMask = selection && selection.has() ? selection.mask : null;
    var dest = new Uint8ClampedArray(w * h * 4);
    var cr = this.color.r, cg = this.color.g, cb = this.color.b;
    var op = this.opacity;
    var written = 0;

    function match(ix, iy) {
      var o = (iy * w + ix) * 4;
      var lab = Color.rgbToLab(src[o], src[o + 1], src[o + 2]);
      return Color.labDist(lab, seed) <= T;
    }
    function paint(ix, iy) {
      var idx = iy * w + ix;
      if (selMask && !selMask[idx]) return;
      var a = op;
      if (selMask) a *= selMask[idx] / 255;
      var o = idx * 4;
      dest[o] = cr;
      dest[o + 1] = cg;
      dest[o + 2] = cb;
      dest[o + 3] = Math.round(a * 255);
      written++;
    }

    if (this.fillContiguous) {
      var seen = new Uint8Array(w * h);
      var stack = [x, y];
      seen[y * w + x] = 1;
      var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
      while (stack.length) {
        var cy = stack.pop(), cx = stack.pop();
        if (!match(cx, cy)) continue;
        paint(cx, cy);
        for (var a = 0; a < 8; a += 2) {
          var nx = cx + dirs[a], ny = cy + dirs[a + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var ni = ny * w + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          stack.push(nx, ny);
        }
      }
    } else {
      for (var iy = 0; iy < h; iy++) {
        for (var ix = 0; ix < w; ix++) {
          if (match(ix, iy)) paint(ix, iy);
        }
      }
    }
    if (!written) return false;
    var tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d").putImageData(new ImageData(dest, w, h), 0, 0);
    layers.retouch.getContext("2d").drawImage(tmp, 0, 0);
    return true;
  };

  global.DN = global.DN || {};
  global.DN.Tools = Tools;
})(typeof window !== "undefined" ? window : self);
