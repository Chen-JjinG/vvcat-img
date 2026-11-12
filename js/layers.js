(function (global) {
  "use strict";

  function makeCanvas(w, h) {
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function Layers() {
    this.w = 0;
    this.h = 0;
    this.bg = null;
    this.retouch = null;
    this.original = null;
    this.bgVisible = true;
    this.retouchVisible = true;
    this.fileName = "image";
  }

  Layers.prototype.isEmpty = function () {
    return !this.bg;
  };

  Layers.prototype.loadFromImage = function (img, name) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    this.w = w;
    this.h = h;
    this.bg = makeCanvas(w, h);
    this.retouch = makeCanvas(w, h);
    this.original = makeCanvas(w, h);
    this.bg.getContext("2d").drawImage(img, 0, 0);
    this.original.getContext("2d").drawImage(img, 0, 0);
    this.bgVisible = true;
    this.retouchVisible = true;
    if (name) this.fileName = String(name).replace(/\.[^.]+$/, "") || "image";
  };

  Layers.prototype.getBgData = function () {
    return this.bg.getContext("2d").getImageData(0, 0, this.w, this.h);
  };
  Layers.prototype.getRetouchData = function () {
    return this.retouch.getContext("2d").getImageData(0, 0, this.w, this.h);
  };
  Layers.prototype.getOriginalData = function () {
    return this.original.getContext("2d").getImageData(0, 0, this.w, this.h);
  };
  Layers.prototype.setBgData = function (id) {
    this.bg.getContext("2d").putImageData(id, 0, 0);
  };
  Layers.prototype.setRetouchData = function (id) {
    this.retouch.getContext("2d").putImageData(id, 0, 0);
  };

  Layers.prototype.restoreSnapshot = function (snap) {
    if (snap.bg) this.setBgData(snap.bg);
    if (snap.retouch) this.setRetouchData(snap.retouch);
  };

  Layers.prototype.snapshot = function (selection, selW, selH) {
    return {
      bg: this.getBgData(),
      retouch: this.getRetouchData(),
      selection: selection,
      selW: selW,
      selH: selH,
    };
  };

  Layers.prototype.resetToOriginal = function () {
    this.bg.getContext("2d").clearRect(0, 0, this.w, this.h);
    this.bg.getContext("2d").drawImage(this.original, 0, 0);
    this.retouch.getContext("2d").clearRect(0, 0, this.w, this.h);
  };

  Layers.prototype.compositeTo = function (ctx) {
    if (this.bgVisible && this.bg) ctx.drawImage(this.bg, 0, 0);
    if (this.retouchVisible && this.retouch) ctx.drawImage(this.retouch, 0, 0);
  };

  Layers.prototype.getCompositeImageData = function () {
    var c = makeCanvas(this.w, this.h);
    var ctx = c.getContext("2d");
    this.compositeTo(ctx);
    return ctx.getImageData(0, 0, this.w, this.h);
  };

  Layers.prototype.flattenCanvas = function () {
    var c = makeCanvas(this.w, this.h);
    this.compositeTo(c.getContext("2d"));
    return c;
  };

  Layers.prototype.exportPNG = function (cb) {
    this.flattenCanvas().toBlob(function (blob) {
      cb(blob);
    }, "image/png");
  };

  global.DN = global.DN || {};
  global.DN.Layers = Layers;
})(typeof window !== "undefined" ? window : self);
