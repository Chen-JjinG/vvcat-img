(function (global) {
  "use strict";

  function makeCanvas(w, h) {
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  var nextDoc = 1;

  function Layers() {
    this.w = 0;
    this.h = 0;
    this.stack = [];
    this.activeId = 0;
    this.original = null;
    this.fileName = "image";
    this._seq = 1;
  }

  function readPixels(canvas, w, h) {
    return canvas.getContext("2d").getImageData(0, 0, w, h);
  }

  Layers.prototype.isEmpty = function () {
    return !this.stack.length || !this.w;
  };

  Layers.prototype._add = function (name, kind, index) {
    var layer = {
      id: nextDoc++,
      name: name,
      kind: kind,
      visible: true,
      canvas: makeCanvas(this.w, this.h),
    };
    if (index == null || index < 0 || index > this.stack.length) this.stack.push(layer);
    else this.stack.splice(index, 0, layer);
    return layer;
  };

  Layers.prototype.loadFromImage = function (img, name) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    this.w = w;
    this.h = h;
    this.stack = [];
    this._seq = 1;
    this.original = makeCanvas(w, h);
    this.original.getContext("2d").drawImage(img, 0, 0);
    var bg = this._add("背景", "bg");
    bg.canvas.getContext("2d").drawImage(img, 0, 0);
    var retouch = this._add("修饰", "retouch", 0);
    this.activeId = retouch.id;
    if (name) this.fileName = String(name).replace(/\.[^.]+$/, "") || "image";
  };

  Layers.prototype.byId = function (id) {
    id = Number(id);
    for (var i = 0; i < this.stack.length; i++) {
      if (this.stack[i].id === id) return this.stack[i];
    }
    return null;
  };

  Layers.prototype.activeLayer = function () {
    return this.byId(this.activeId) || this.stack[0] || null;
  };

  Layers.prototype.activeCanvas = function () {
    var layer = this.activeLayer();
    return layer ? layer.canvas : null;
  };

  Layers.prototype.setActive = function (id) {
    if (this.byId(id)) this.activeId = Number(id);
  };

  Layers.prototype.bgLayer = function () {
    for (var i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].kind === "bg") return this.stack[i];
    }
    return null;
  };

  Layers.prototype.indexOf = function (id) {
    id = Number(id);
    for (var i = 0; i < this.stack.length; i++) if (this.stack[i].id === id) return i;
    return -1;
  };

  /* New transparent layer directly above the active one. */
  Layers.prototype.addLayer = function () {
    if (this.isEmpty()) return null;
    var idx = this.indexOf(this.activeId);
    if (idx < 0) idx = 0;
    var layer = this._add("图层 " + this._seq++, "user", idx);
    this.activeId = layer.id;
    return layer;
  };

  Layers.prototype.canDelete = function (id) {
    var layer = this.byId(id);
    if (!layer || layer.kind === "bg") return false;
    return this.stack.length > 1;
  };

  Layers.prototype.removeLayer = function (id) {
    if (!this.canDelete(id)) return false;
    var idx = this.indexOf(id);
    var removed = this.stack.splice(idx, 1)[0];
    if (this.activeId === removed.id) {
      var next = this.stack[Math.min(idx, this.stack.length - 1)];
      this.activeId = next.id;
    }
    return true;
  };

  Layers.prototype.toggleVisible = function (id) {
    var layer = this.byId(id);
    if (!layer) return;
    layer.visible = !layer.visible;
  };

  Layers.prototype.getBgData = function () {
    var bg = this.bgLayer();
    return readPixels(bg.canvas, this.w, this.h);
  };
  Layers.prototype.setBgData = function (id) {
    var bg = this.bgLayer();
    if (bg) bg.canvas.getContext("2d").putImageData(id, 0, 0);
  };

  Layers.prototype.snapshot = function (selection, selW, selH) {
    var w = this.w, h = this.h;
    return {
      w: w,
      h: h,
      seq: this._seq,
      activeId: this.activeId,
      layers: this.stack.map(function (layer) {
        return {
          id: layer.id,
          name: layer.name,
          kind: layer.kind,
          visible: layer.visible,
          data: readPixels(layer.canvas, w, h),
        };
      }),
      selection: selection,
      selW: selW,
      selH: selH,
    };
  };

  Layers.prototype.restoreSnapshot = function (snap) {
    if (!snap) return;
    var w = this.w, h = this.h;
    if (snap.layers && snap.layers.length) {
      var stack = [];
      for (var i = 0; i < snap.layers.length; i++) {
        var item = snap.layers[i];
        var canvas = makeCanvas(w, h);
        if (item.data) canvas.getContext("2d").putImageData(item.data, 0, 0);
        stack.push({
          id: item.id,
          name: item.name,
          kind: item.kind,
          visible: item.visible !== false,
          canvas: canvas,
        });
      }
      this.stack = stack;
      this.activeId = snap.activeId;
      if (snap.seq) this._seq = snap.seq;
      if (!this.byId(this.activeId) && stack.length) this.activeId = stack[0].id;
      return;
    }
    /* Older snapshots stored only the background and retouch buffers. */
    if (snap.bg) this.setBgData(snap.bg);
  };

  Layers.prototype.resetToOriginal = function () {
    if (!this.original) return;
    var bg = this.bgLayer();
    if (!bg) return;
    var bctx = bg.canvas.getContext("2d");
    bctx.clearRect(0, 0, this.w, this.h);
    bctx.drawImage(this.original, 0, 0);
    bg.visible = true;
    var retouch = {
      id: nextDoc++,
      name: "修饰",
      kind: "retouch",
      visible: true,
      canvas: makeCanvas(this.w, this.h),
    };
    this.stack = [retouch, bg];
    this.activeId = retouch.id;
  };

  Layers.prototype.compositeTo = function (ctx) {
    for (var i = this.stack.length - 1; i >= 0; i--) {
      var layer = this.stack[i];
      if (layer.visible && layer.canvas) ctx.drawImage(layer.canvas, 0, 0);
    }
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

  Layers.prototype.samplePixel = function (x, y) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    var c = makeCanvas(1, 1);
    var ctx = c.getContext("2d");
    for (var i = this.stack.length - 1; i >= 0; i--) {
      var layer = this.stack[i];
      if (layer.visible && layer.canvas) ctx.drawImage(layer.canvas, -x, -y);
    }
    var d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] < 8) return { r: d[0], g: d[1], b: d[2], a: d[3], empty: true };
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  };

  Layers.prototype.exportPNG = function (cb) {
    this.flattenCanvas().toBlob(function (blob) {
      cb(blob);
    }, "image/png");
  };

  global.DN = global.DN || {};
  global.DN.Layers = Layers;
})(typeof window !== "undefined" ? window : self);
