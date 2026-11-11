(function (global) {
  "use strict";

  function Viewport() {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.minScale = 0.05;
    this.maxScale = 32;
  }

  Viewport.prototype.fit = function (imgW, imgH, viewW, viewH, pad) {
    pad = pad == null ? 48 : pad;
    var sx = (viewW - pad * 2) / imgW;
    var sy = (viewH - pad * 2) / imgH;
    var s = Math.min(sx, sy, 1);
    if (!isFinite(s) || s <= 0) s = 1;
    this.scale = s;
    this.x = (viewW - imgW * s) / 2;
    this.y = (viewH - imgH * s) / 2;
  };

  Viewport.prototype.centerAt = function (imgW, imgH, viewW, viewH, scale) {
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, scale));
    this.x = (viewW - imgW * this.scale) / 2;
    this.y = (viewH - imgH * this.scale) / 2;
  };

  Viewport.prototype.screenToImage = function (sx, sy) {
    return {
      x: (sx - this.x) / this.scale,
      y: (sy - this.y) / this.scale,
    };
  };

  Viewport.prototype.imageToScreen = function (ix, iy) {
    return {
      x: ix * this.scale + this.x,
      y: iy * this.scale + this.y,
    };
  };

  Viewport.prototype.zoomAt = function (sx, sy, factor) {
    var pt = this.screenToImage(sx, sy);
    var next = this.scale * factor;
    next = Math.max(this.minScale, Math.min(this.maxScale, next));
    this.scale = next;
    this.x = sx - pt.x * this.scale;
    this.y = sy - pt.y * this.scale;
  };

  Viewport.prototype.pan = function (dx, dy) {
    this.x += dx;
    this.y += dy;
  };

  Viewport.prototype.apply = function (ctx) {
    ctx.setTransform(this.scale, 0, 0, this.scale, this.x, this.y);
  };

  global.DN = global.DN || {};
  global.DN.Viewport = Viewport;
})(typeof window !== "undefined" ? window : self);
