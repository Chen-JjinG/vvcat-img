(function (global) {
  "use strict";

  function cloneImageData(id) {
    if (!id) return null;
    var cpy = new ImageData(id.width, id.height);
    cpy.data.set(id.data);
    return cpy;
  }

  function cloneMask(mask) {
    if (!mask) return null;
    var c = new Uint8Array(mask.length);
    c.set(mask);
    return c;
  }

  function History(maxSteps) {
    this.maxSteps = maxSteps || 30;
    this.stack = [];
    this.index = -1;
  }

  History.prototype.push = function (label, snap) {
    if (this.index < this.stack.length - 1) {
      this.stack.length = this.index + 1;
    }
    var layers = null;
    if (snap.layers) {
      layers = snap.layers.map(function (layer) {
        return {
          id: layer.id,
          name: layer.name,
          kind: layer.kind,
          visible: layer.visible,
          data: cloneImageData(layer.data),
        };
      });
    }
    this.stack.push({
      label: label || "编辑",
      layers: layers,
      seq: snap.seq || 1,
      activeId: snap.activeId || 0,
      bg: cloneImageData(snap.bg),
      retouch: cloneImageData(snap.retouch),
      selection: cloneMask(snap.selection),
      selW: snap.selW || 0,
      selH: snap.selH || 0,
    });
    if (this.stack.length > this.maxSteps) {
      this.stack.shift();
    } else {
      this.index++;
    }
  };

  History.prototype.canUndo = function () {
    return this.index > 0;
  };
  History.prototype.canRedo = function () {
    return this.index >= 0 && this.index < this.stack.length - 1;
  };
  History.prototype.undo = function () {
    if (!this.canUndo()) return null;
    this.index--;
    return this.stack[this.index];
  };
  History.prototype.redo = function () {
    if (!this.canRedo()) return null;
    this.index++;
    return this.stack[this.index];
  };
  History.prototype.peek = function () {
    return this.index >= 0 ? this.stack[this.index] : null;
  };
  History.prototype.reset = function () {
    this.stack = [];
    this.index = -1;
  };
  History.prototype.maxForSize = function (w, h) {
    var mp = (w * h) / 1e6;
    if (mp > 8) return 8;
    if (mp > 4) return 12;
    if (mp > 2) return 20;
    return 30;
  };
  History.prototype.setMaxForSize = function (w, h) {
    this.maxSteps = this.maxForSize(w, h);
    while (this.stack.length > this.maxSteps) {
      this.stack.shift();
      this.index--;
    }
    if (this.index < -1) this.index = -1;
  };

  global.DN = global.DN || {};
  global.DN.History = History;
})(typeof window !== "undefined" ? window : self);
