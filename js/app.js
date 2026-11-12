(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var layers = new DN.Layers();
  var viewport = new DN.Viewport();
  var tools = new DN.Tools();
  var selection = new DN.Selection();
  var history = new DN.History(30);

  var viewCanvas = $("view");
  var stage = $("stage");
  var propsEl = $("props");
  var dpr = 1;

  var busy = false;
  var holdCompare = false;
  var splitOn = false;
  var splitPos = 0.5;
  var draggingSplit = false;
  var spaceDown = false;
  var altDown = false;
  var shiftDown = false;
  var panning = false;
  var panLast = null;
  var pointers = new Map();
  var pinch = null;
  var pointerOver = false;
  var cursorImg = { x: 0, y: 0, sx: 0, sy: 0 };
  var tempTool = null;
  var draft = null;
  var antsPhase = 0;
  var lastAnts = 0;
  var needsRender = true;
  var denoiseScope = "auto";
  var worker = null;
  var workerReady = false;
  var jobId = 0;
  var jobCb = {};
  var recentColors = ["#D49A7A", "#F2D3C2", "#2A2A2E", "#F4F1EA", "#C45C4A", "#7A9E7E", "#6B8C9E", "#E8C56B"];
  var hsv = DN.Color.rgbToHsv(212, 154, 122);

  var TOOL_NAMES = {
    auto: "魔法工具",
    lasso: "套索",
    rect: "矩形选区",
    ellipse: "椭圆选区",
    brush: "画笔",
    eraser: "橡皮",
    smudge: "涂抹",
    fill: "油漆桶",
    eyedropper: "吸管",
    hand: "平移",
  };

  /* ---------- worker ---------- */
  function initWorker() {
    try {
      worker = new Worker("js/denoise-worker.js");
      worker.onmessage = function (e) {
        var msg = e.data || {};
        var cb = jobCb[msg.id];
        if (!cb) return;
        if (msg.type === "progress") {
          if (cb.onProgress) cb.onProgress(msg.progress);
        } else if (msg.type === "done") {
          delete jobCb[msg.id];
          cb.resolve({
            data: new Uint8ClampedArray(msg.buffer),
            width: msg.width,
            height: msg.height,
          });
        } else if (msg.type === "error") {
          delete jobCb[msg.id];
          cb.reject(new Error(msg.message || "降噪失败"));
        }
      };
      worker.onerror = function () {
        worker = null;
        workerReady = false;
      };
      workerReady = true;
    } catch (err) {
      worker = null;
      workerReady = false;
    }
  }
  initWorker();

  function runDenoise(imageData, options) {
    return new Promise(function (resolve, reject) {
      var opts = {
        strength: options.strength,
        preserveEdges: options.preserveEdges,
        flatFill: options.flatFill !== false,
        mask: options.mask || null,
        onProgress: options.onProgress || function () {},
      };
      if (worker && workerReady) {
        var id = ++jobId;
        jobCb[id] = { resolve: resolve, reject: reject, onProgress: opts.onProgress };
        var copy = new Uint8ClampedArray(imageData.data);
        var msg = {
          id: id,
          buffer: copy.buffer,
          width: imageData.width,
          height: imageData.height,
          strength: opts.strength,
          preserveEdges: opts.preserveEdges,
          flatFill: opts.flatFill,
        };
        var xfer = [copy.buffer];
        if (opts.mask) {
          var mc = new Uint8Array(opts.mask);
          msg.maskBuffer = mc.buffer;
          xfer.push(mc.buffer);
        }
        try {
          worker.postMessage(msg, xfer);
        } catch (err) {
          delete jobCb[id];
          worker = null;
          workerReady = false;
          fallback();
        }
      } else {
        fallback();
      }
      function fallback() {
        setTimeout(function () {
          try {
            resolve(DenoiseCore.denoise({
              data: imageData.data,
              width: imageData.width,
              height: imageData.height,
            }, opts));
          } catch (err) {
            reject(err);
          }
        }, 30);
      }
    });
  }

  /* ---------- render ---------- */
  function requestDraw() { needsRender = true; }

  function resizeView() {
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    var w = stage.clientWidth;
    var h = stage.clientHeight;
    var cw = Math.max(1, Math.floor(w * dpr));
    var ch = Math.max(1, Math.floor(h * dpr));
    if (viewCanvas.width !== cw || viewCanvas.height !== ch) {
      viewCanvas.width = cw;
      viewCanvas.height = ch;
      viewCanvas.style.width = w + "px";
      viewCanvas.style.height = h + "px";
      requestDraw();
    }
    return { w: w, h: h };
  }

  function drawChecker(ctx, w, h) {
    var s = 12;
    ctx.save();
    ctx.fillStyle = "#1c1c1f";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#232326";
    var x0 = 0, y0 = 0, x, y;
    for (y = y0; y < h; y += s) {
      for (x = x0; x < w; x += s) {
        if (((x / s + y / s) | 0) % 2 === 0) ctx.fillRect(x, y, s, s);
      }
    }
    ctx.restore();
  }

  function render(ts) {
    ts = ts || 0;
    var size = resizeView();
      if (ts - lastAnts > 80) {
      antsPhase = (antsPhase + 1) & 255;
      lastAnts = ts;
      if (selection.has() || (draft && draft.edges && draft.edges.length)) needsRender = true;
    }
    if (!needsRender) {
      requestAnimationFrame(render);
      return;
    }
    needsRender = false;
    flushAutoDraft();
    var ctx = viewCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = "#141416";
    ctx.fillRect(0, 0, size.w, size.h);

    if (!layers.isEmpty()) {
      ctx.save();
      ctx.translate(viewport.x, viewport.y);
      ctx.scale(viewport.scale, viewport.scale);
      ctx.imageSmoothingEnabled = viewport.scale < 1.01;
      ctx.imageSmoothingQuality = "high";

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, layers.w, layers.h);
      ctx.clip();
      drawChecker(ctx, layers.w, layers.h);

      if (holdCompare) {
        ctx.drawImage(layers.original, 0, 0);
      } else if (splitOn) {
        var splitImgX = viewport.screenToImage(splitPos * size.w, 0).x;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, splitImgX, layers.h);
        ctx.clip();
        layers.compositeTo(ctx);
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(splitImgX, 0, layers.w - splitImgX, layers.h);
        ctx.clip();
        ctx.drawImage(layers.original, 0, 0);
        ctx.restore();
      } else {
        layers.compositeTo(ctx);
      }
      ctx.restore();

      if (draft) drawDraft(ctx);
      if (selection.has() && !(draft && draft.kind === "auto" && draft.mode === "replace")) {
        selection.drawAnts(ctx, antsPhase);
      }
      ctx.restore();

      if (splitOn && !holdCompare) {
        var sx = splitPos * size.w;
        ctx.fillStyle = "rgba(244,241,234,.9)";
        ctx.fillRect(sx - 0.5, 0, 1, size.h);
        ctx.beginPath();
        ctx.fillStyle = "#f4f1ea";
        ctx.arc(sx, size.h / 2, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#2a2a2e";
        ctx.font = "9px " + getComputedStyle(document.body).fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("⬡", sx, size.h / 2);
        ctx.fillStyle = "rgba(244,241,234,.7)";
        ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
        ctx.textAlign = "right";
        ctx.fillText("当前", sx - 10, 18);
        ctx.textAlign = "left";
        ctx.fillText("原图", sx + 10, 18);
      }
    }

    drawBrushCursor(ctx);
    requestAnimationFrame(render);
  }

  function drawDraft(ctx) {
    if (!draft) return;
    if (draft.kind === "rect" || draft.kind === "ellipse" || draft.kind === "lasso") {
      ctx.save();
      ctx.strokeStyle = "#f4f1ea";
      ctx.lineWidth = 1 / viewport.scale;
      ctx.setLineDash([4 / viewport.scale, 4 / viewport.scale]);
      ctx.lineDashOffset = -antsPhase / viewport.scale;
      if (draft.kind === "rect") {
        ctx.strokeRect(draft.x0, draft.y0, draft.x1 - draft.x0, draft.y1 - draft.y0);
      } else if (draft.kind === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(
          (draft.x0 + draft.x1) / 2,
          (draft.y0 + draft.y1) / 2,
          Math.abs(draft.x1 - draft.x0) / 2,
          Math.abs(draft.y1 - draft.y0) / 2,
          0, 0, Math.PI * 2
        );
        ctx.stroke();
      } else if (draft.points && draft.points.length) {
        ctx.beginPath();
        ctx.moveTo(draft.points[0].x, draft.points[0].y);
        for (var p = 1; p < draft.points.length; p++) ctx.lineTo(draft.points[p].x, draft.points[p].y);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }
    if (draft.kind === "auto" && draft.edges) selection.drawEdgeAnts(ctx, draft.edges, antsPhase);
  }

  function flushAutoDraft() {
    if (!draft || draft.kind !== "auto" || !draft.dirty) return;
    draft.dirty = false;
    draft.mask = draft.session.ensure(draft.threshold);
    draft.edges = selection.traceEdges(draft.mask, layers.w, layers.h, draft.session.bounds);
  }

  function drawBrushCursor(ctx) {
    var t = effectiveTool();
    if (!pointerOver || layers.isEmpty()) return;
    if (t !== "brush" && t !== "eraser" && t !== "smudge") return;
    if (panning || spaceDown || holdCompare) return;
    var r = (tools.size / 2) * viewport.scale;
    if (r < 2) r = 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cursorImg.sx, cursorImg.sy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- image IO ---------- */
  function hasImage() { return !layers.isEmpty(); }

  function loadFromImage(img, name) {
    layers.loadFromImage(img, name);
    selection.resize(layers.w, layers.h);
    history.reset();
    history.setMaxForSize(layers.w, layers.h);
    commit("打开");
    var size = { w: stage.clientWidth, h: stage.clientHeight };
    viewport.fit(layers.w, layers.h, size.w, size.h, 48);
    $("empty").classList.add("hidden");
    setBusy(false);
    syncUI();
    updateThumbs();
    requestDraw();
    $("statHint").textContent = layers.w * layers.h > 8e6
      ? "图片较大，降噪可能需要一些时间"
      : "图片仅在本地处理";
  }

  function loadFile(file) {
    if (!file) return;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      loadFromImage(img, file.name || "image");
      URL.revokeObjectURL(url);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      window.alert("无法读取该图片。");
    };
    img.src = url;
  }

  function loadDemo() {
    var img = new Image();
    img.onload = function () { loadFromImage(img, "sample"); };
    img.onerror = function () {
      window.alert("无法加载示例图。若你是用 file:// 打开的，请改用本地静态服务器，或直接「打开」图片。");
    };
    img.src = "demo/sample.png";
  }

  function exportPNG() {
    if (!hasImage()) return;
    layers.exportPNG(function (blob) {
      if (!blob) return;
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (layers.fileName || "image") + "-clean.png";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 500);
    });
  }

  /* ---------- history ---------- */
  function commit(label) {
    history.push(label, layers.snapshot(selection.cloneMask(), selection.w, selection.h));
    syncHistory();
  }

  function applySnap(snap) {
    if (!snap) return;
    layers.restoreSnapshot(snap);
    selection.restore(snap);
    syncUI();
    updateThumbs();
    requestDraw();
  }

  function undo() {
    var s = history.undo();
    if (s) applySnap(s);
    syncHistory();
  }
  function redo() {
    var s = history.redo();
    if (s) applySnap(s);
    syncHistory();
  }
  function syncHistory() {
    $("btnUndo").disabled = !hasImage() || !history.canUndo();
    $("btnRedo").disabled = !hasImage() || !history.canRedo();
  }

  /* ---------- tools / props ---------- */
  function effectiveTool() {
    if (tempTool) return tempTool;
    if (spaceDown) return "hand";
    if (altDown && !isSelectTool(tools.name)) return "eyedropper";
    return tools.name;
  }
  function isSelectTool(n) {
    return n === "auto" || n === "lasso" || n === "rect" || n === "ellipse";
  }

  function setTool(name) {
    tools.setTool(name);
    document.querySelectorAll(".tool").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tool") === name);
    });
    renderProps();
    syncCursor();
    syncPaintHint();
    $("statTool").textContent = TOOL_NAMES[name] || name;
    requestDraw();
  }

  function renderProps() {
    var t = tools.name;
    var html = "";
    function slider(id, label, min, max, val, fmt) {
      return (
        '<label class="prop"><span class="label">' + label + "</span>" +
        '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" value="' + val + '">' +
        '<span class="val" id="' + id + 'Val">' + fmt(val) + "</span></label>"
      );
    }
    if (t === "brush" || t === "eraser" || t === "smudge") {
      html += slider("pSize", "大小", 1, 300, Math.round(tools.size), function (v) { return v + "px"; });
      if (t !== "smudge") html += slider("pOpacity", "不透明度", 1, 100, Math.round(tools.opacity * 100), function (v) { return v + "%"; });
      html += slider("pHard", "硬度", 0, 100, Math.round(tools.hardness * 100), function (v) { return v + "%"; });
      if (t === "smudge") html += slider("pSmudge", "力度", 1, 100, Math.round(tools.smudgeStrength * 100), function (v) { return v + "%"; });
    }
    if (t === "fill") {
      html += slider("pTol", "容差", 0, 80, tools.fillTolerance, function (v) { return String(v); });
      html += slider("pOpacity", "不透明度", 1, 100, Math.round(tools.opacity * 100), function (v) { return v + "%"; });
      html +=
        '<div class="prop"><span class="label">填充</span><div class="seg" id="pFillMode" style="width:180px">' +
        '<button type="button" data-v="1"' + (tools.fillContiguous ? ' class="on"' : "") + ">相邻</button>" +
        '<button type="button" data-v="0"' + (!tools.fillContiguous ? ' class="on"' : "") + ">相似色</button></div></div>";
    }
    if (t === "auto") {
      html += slider("pSelT", "容差", 1, 80, tools.selectThreshold, function (v) { return String(v); });
      html += '<span class="prop" style="color:var(--muted)">点按即可圈选，左右拖动调整容差</span>';
    }
    if (t === "brush" || t === "fill" || t === "eyedropper") {
      html += '<button class="color-well" id="pColor" title="颜色" aria-label="颜色"></button>';
    }
    if (t === "lasso" || t === "rect" || t === "ellipse") {
      html += '<span class="prop" style="color:var(--muted)">拖动绘制选区 · Shift 相加 · Alt 相减</span>';
    }
    if (t === "hand") {
      html += '<span class="prop" style="color:var(--muted)">拖动平移画布，滚轮缩放</span>';
    }
    propsEl.innerHTML = html;
    if ($("pColor")) $("pColor").style.background = DN.Color.css(tools.color.r, tools.color.g, tools.color.b);
    bindPropEvents();
  }

  function bindPropEvents() {
    function bindRange(id, fn, fmt) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("input", function () {
        fn(Number(el.value));
        if ($(id + "Val")) $(id + "Val").textContent = fmt(Number(el.value));
        requestDraw();
      });
    }
    bindRange("pSize", function (v) { tools.size = v; }, function (v) { return v + "px"; });
    bindRange("pOpacity", function (v) { tools.opacity = v / 100; }, function (v) { return v + "%"; });
    bindRange("pHard", function (v) { tools.hardness = v / 100; }, function (v) { return v + "%"; });
    bindRange("pSmudge", function (v) { tools.smudgeStrength = v / 100; }, function (v) { return v + "%"; });
    bindRange("pTol", function (v) { tools.fillTolerance = v; }, function (v) { return String(v); });
    bindRange("pSelT", function (v) { tools.selectThreshold = v; }, function (v) { return String(v); });
    var fm = $("pFillMode");
    if (fm) {
      fm.querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () {
          tools.fillContiguous = b.getAttribute("data-v") === "1";
          fm.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
        });
      });
    }
    if ($("pColor")) $("pColor").addEventListener("click", function (e) {
      e.stopPropagation();
      openColorPopover($("pColor"));
    });
  }

  function setColor(r, g, b, record) {
    tools.setColor(r, g, b);
    hsv = DN.Color.rgbToHsv(r, g, b);
    var hex = DN.Color.toHex(r, g, b);
    if ($("pColor")) $("pColor").style.background = hex;
    if ($("hexInput")) $("hexInput").value = hex;
    if (record) {
      if (recentColors[0] !== hex) {
        recentColors.unshift(hex);
        if (recentColors.length > 10) recentColors.pop();
        renderSwatches();
      }
    }
    syncPicker();
  }

  /* ---------- color popover ---------- */
  var pop = $("colorPopover");
  function openColorPopover(anchor) {
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 240) + "px";
    pop.style.top = r.bottom + 8 + "px";
    pop.classList.add("show");
    syncPicker();
  }
  function closeColorPopover() { pop.classList.remove("show"); }

  function syncPicker() {
    $("svBox").style.background = "hsl(" + hsv.h + ",100%,50%)";
    $("svKnob").style.left = hsv.s * 100 + "%";
    $("svKnob").style.top = (1 - hsv.v) * 100 + "%";
    $("hueRange").value = String(Math.round(hsv.h));
    $("hexInput").value = DN.Color.toHex(tools.color.r, tools.color.g, tools.color.b);
  }
  function applyHsv() {
    var rgb = DN.Color.hsvToRgb(hsv.h, hsv.s, hsv.v);
    setColor(rgb.r, rgb.g, rgb.b, false);
  }
  function renderSwatches() {
    var box = $("swatches");
    box.innerHTML = "";
    recentColors.forEach(function (hex) {
      var b = document.createElement("button");
      b.style.background = hex;
      b.title = hex;
      b.addEventListener("click", function () {
        var p = DN.Color.parseHex(hex);
        if (p) setColor(p.r, p.g, p.b, true);
      });
      box.appendChild(b);
    });
  }
  renderSwatches();

  $("svBox").addEventListener("pointerdown", function (e) {
    $("svBox").setPointerCapture(e.pointerId);
    svMove(e);
  });
  $("svBox").addEventListener("pointermove", function (e) {
    if (e.buttons) svMove(e);
  });
  function svMove(e) {
    var r = $("svBox").getBoundingClientRect();
    hsv.s = DN.Color.clamp((e.clientX - r.left) / r.width, 0, 1);
    hsv.v = DN.Color.clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    applyHsv();
    syncPicker();
  }
  $("hueRange").addEventListener("input", function () {
    hsv.h = Number($("hueRange").value);
    applyHsv();
    syncPicker();
  });
  $("hexInput").addEventListener("change", function () {
    var p = DN.Color.parseHex($("hexInput").value);
    if (p) setColor(p.r, p.g, p.b, true);
  });

  /* ---------- pointer / view ---------- */
  function stagePos(ev) {
    var r = stage.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function imgPos(ev) {
    var s = stagePos(ev);
    var p = viewport.screenToImage(s.x, s.y);
    return { x: p.x, y: p.y, sx: s.x, sy: s.y };
  }

  function syncCursor() {
    stage.classList.remove("grab", "grabbing", "cross", "hide-cursor");
    var t = effectiveTool();
    if (t === "hand") stage.classList.add(panning ? "grabbing" : "grab");
    else if (t === "brush" || t === "eraser" || t === "smudge") stage.classList.add("hide-cursor");
    else if (t !== "eyedropper") stage.classList.add("cross");
  }

  function updateLoupe(ix, iy, sx, sy) {
    var loupe = $("loupe");
    if (effectiveTool() !== "eyedropper" || !hasImage()) {
      loupe.classList.remove("show");
      return;
    }
    var sample = tools.sample(layers, ix, iy);
    var mag = 8;
    var lc = $("loupeCanvas");
    var lctx = lc.getContext("2d");
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = "#000";
    lctx.fillRect(0, 0, 92, 92);
    var src = 92 / mag;
    lctx.drawImage(
      layers.flattenCanvas(),
      ix - src / 2, iy - src / 2, src, src,
      0, 0, 92, 92
    );
    lctx.strokeStyle = "rgba(255,255,255,.8)";
    lctx.strokeRect(45, 45, 2, 2);
    if (sample && !sample.empty) {
      $("loupeChip").textContent = DN.Color.toHex(sample.r, sample.g, sample.b);
    } else {
      $("loupeChip").textContent = "";
    }
    loupe.style.left = sx + 18 + "px";
    loupe.style.top = sy - 110 + "px";
    loupe.classList.add("show");
  }
  function hideLoupe() { $("loupe").classList.remove("show"); }

  stage.addEventListener("wheel", function (e) {
    if (!hasImage()) return;
    e.preventDefault();
    var s = stagePos(e);
    var factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    if (e.ctrlKey) factor = Math.exp(-e.deltaY * 0.01);
    viewport.zoomAt(s.x, s.y, factor);
    syncZoom();
    requestDraw();
  }, { passive: false });

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("pointerenter", function () { pointerOver = true; requestDraw(); });
  stage.addEventListener("pointerleave", function () {
    pointerOver = false;
    hideLoupe();
    requestDraw();
  });
  stage.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  function onDown(e) {
    if (!hasImage() || busy) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      startPinch();
      return;
    }
    var p = imgPos(e);
    cursorImg = p;
    if (splitOn && Math.abs(p.sx - splitPos * stage.clientWidth) < 8) {
      draggingSplit = true;
      return;
    }
    var t = effectiveTool();
    if (t === "hand" || e.button === 1 || spaceDown) {
      panning = true;
      panLast = { x: e.clientX, y: e.clientY };
      syncCursor();
      return;
    }
    if (t === "eyedropper") {
      var s = tools.sample(layers, p.x, p.y);
      if (s && !s.empty) setColor(s.r, s.g, s.b, true);
      updateLoupe(p.x, p.y, p.sx, p.sy);
      return;
    }
    if (t === "fill") {
      if (selection.has() && !selection.contains(p.x, p.y)) {
        $("statHint").textContent = "油漆桶仅在选区内填充";
        return;
      }
      if (tools.fill(layers, selection, p.x, p.y)) {
        commit("油漆桶");
        updateThumbs();
        requestDraw();
      }
      syncPaintHint();
      return;
    }
    if (t === "brush" || t === "eraser" || t === "smudge") {
      tools.beginStroke(p.x, p.y, e, layers, selection);
      requestDraw();
      return;
    }
    if (isSelectTool(t)) {
      var mode = shiftDown ? "add" : altDown ? "subtract" : "replace";
      if (t === "auto") {
        var ix = Math.round(p.x), iy = Math.round(p.y);
        if (ix < 0 || iy < 0 || ix >= layers.w || iy >= layers.h) return;
        var th = tools.selectThreshold;
        var session = new DN.AutoSession(layers.getCompositeImageData(), layers.w, layers.h, ix, iy);
        var mask = session.ensure(th);
        draft = {
          kind: "auto",
          x0: ix, y0: iy, sx: p.sx,
          threshold: th,
          mode: mode,
          session: session,
          mask: mask,
          edges: selection.traceEdges(mask, layers.w, layers.h, session.bounds),
          dirty: false,
        };
        requestDraw();
      } else if (t === "lasso") {
        draft = { kind: "lasso", points: [{ x: p.x, y: p.y }], mode: mode };
      } else {
        draft = { kind: t, x0: p.x, y0: p.y, x1: p.x, y1: p.y, mode: mode };
      }
      requestDraw();
    }
  }

  function onMove(e) {
    var p = imgPos(e);
    cursorImg = p;
    pointerOver = true;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      movePinch();
      requestDraw();
      return;
    }
    if (draggingSplit) {
      splitPos = DN.Color.clamp(p.sx / Math.max(1, stage.clientWidth), 0.02, 0.98);
      requestDraw();
      return;
    }
    if (panning && panLast) {
      viewport.pan(e.clientX - panLast.x, e.clientY - panLast.y);
      panLast = { x: e.clientX, y: e.clientY };
      requestDraw();
      return;
    }
    var t = effectiveTool();
    if (t === "eyedropper" && hasImage()) {
      if (e.buttons) {
        var s = tools.sample(layers, p.x, p.y);
        if (s && !s.empty) setColor(s.r, s.g, s.b, false);
      }
      updateLoupe(p.x, p.y, p.sx, p.sy);
      requestDraw();
      return;
    } else {
      hideLoupe();
    }
    if (draft) {
      if (draft.kind === "auto") {
        var dx = p.sx - draft.sx;
        var next = DN.Color.clamp(tools.selectThreshold + dx / 4, 1, 120);
        if (Math.abs(next - draft.threshold) >= 0.5) {
          draft.threshold = next;
          draft.dirty = true;
        }
        if ($("pSelT")) {
          $("pSelT").value = String(Math.round(draft.threshold));
          if ($("pSelTVal")) $("pSelTVal").textContent = String(Math.round(draft.threshold));
        }
      } else if (draft.kind === "lasso") {
        var last = draft.points[draft.points.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1.2) {
          draft.points.push({ x: p.x, y: p.y });
        }
      } else {
        draft.x1 = p.x;
        draft.y1 = p.y;
      }
      requestDraw();
      return;
    }
    if ((t === "brush" || t === "eraser" || t === "smudge") && tools._stroke) {
      tools.moveStroke(p.x, p.y, e, layers, selection);
      requestDraw();
      return;
    }
    requestDraw();
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (draggingSplit) { draggingSplit = false; return; }
    if (panning) { panning = false; panLast = null; syncCursor(); return; }
    var t = effectiveTool();
    if (t === "eyedropper") {
      var p = imgPos(e);
      var s = tools.sample(layers, p.x, p.y);
      if (s && !s.empty) setColor(s.r, s.g, s.b, true);
    }
    if (tools._stroke) {
      tools.endStroke();
      commit(TOOL_NAMES[tools.name] || "笔触");
      updateThumbs();
      requestDraw();
    }
    if (draft) {
      var mask = null;
      if (draft.kind === "auto") {
        mask = draft.mask;
        tools.selectThreshold = Math.round(draft.threshold);
      } else if (draft.kind === "lasso") mask = selection.fromLasso(draft.points);
      else if (draft.kind === "rect") mask = selection.fromRect(draft.x0, draft.y0, draft.x1, draft.y1);
      else if (draft.kind === "ellipse") mask = selection.fromEllipse(draft.x0, draft.y0, draft.x1, draft.y1);
      if (mask) {
        selection.commitMask(mask, draft.mode);
        commit("选区");
      }
      draft = null;
      syncSelButtons();
      requestDraw();
    }
  }

  function startPinch() {
    var pts = Array.from(pointers.values());
    if (pts.length < 2) return;
    var r = stage.getBoundingClientRect();
    pinch = {
      dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
      midX: (pts[0].x + pts[1].x) / 2 - r.left,
      midY: (pts[0].y + pts[1].y) / 2 - r.top,
      scale: viewport.scale,
      x: viewport.x,
      y: viewport.y,
    };
  }
  function movePinch() {
    var pts = Array.from(pointers.values());
    if (pts.length < 2 || !pinch) return;
    var r = stage.getBoundingClientRect();
    var dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    var midX = (pts[0].x + pts[1].x) / 2 - r.left;
    var midY = (pts[0].y + pts[1].y) / 2 - r.top;
    var factor = dist / Math.max(1, pinch.dist);
    viewport.x = pinch.x;
    viewport.y = pinch.y;
    viewport.scale = pinch.scale;
    viewport.zoomAt(pinch.midX, pinch.midY, factor);
    viewport.pan(midX - pinch.midX, midY - pinch.midY);
    syncZoom();
  }

  /* ---------- denoise ---------- */
  function setBusy(v) {
    busy = v;
    $("btnDenoise").disabled = v || !hasImage();
  }
  function showProgress(p, text) {
    var el = $("progress");
    if (p == null) { el.classList.remove("show"); return; }
    el.classList.add("show");
    $("progressText").textContent = text || "正在降噪…";
    $("progressBar").style.width = Math.round(p * 100) + "%";
  }

  function currentScopeUsesSelection() {
    if (denoiseScope === "all") return false;
    if (denoiseScope === "selection") return true;
    return selection.has();
  }

  async function applyDenoise() {
    if (!hasImage() || busy) return;
    if (denoiseScope === "selection" && !selection.has()) {
      $("statHint").textContent = "没有选区，请先选择区域或改用「整张图」";
      return;
    }
    setBusy(true);
    showProgress(0.02, workerReady ? "正在降噪…" : "正在主线程降噪…");
    try {
      var bg = layers.getBgData();
      var mask = currentScopeUsesSelection() ? selection.getMask() : null;
      var result = await runDenoise(bg, {
        strength: Number($("sStrength").value) / 100,
        preserveEdges: Number($("sPreserve").value) / 100,
        flatFill: !$("sFlatFill") || $("sFlatFill").checked,
        mask: mask,
        onProgress: function (p) { showProgress(p); },
      });
      var out = new ImageData(new Uint8ClampedArray(result.data), result.width, result.height);
      layers.setBgData(out);
      commit("一键降噪");
      updateThumbs();
      requestDraw();
      $("statHint").textContent = "降噪完成，可用画笔继续修饰，或按住「对比原图」查看差别";
    } catch (err) {
      console.error(err);
      window.alert("降噪失败：" + ((err && err.message) || err) +
        "\n若你通过 file:// 打开，请改用本地静态服务器后再试。");
    } finally {
      setBusy(false);
      showProgress(null);
    }
  }

  /* ---------- UI wiring ---------- */
  function syncZoom() {
    $("btnZoomLabel").textContent = Math.round(viewport.scale * 100) + "%";
    $("statZoom").textContent = Math.round(viewport.scale * 100) + "%";
  }
  function syncSelButtons() {
    var on = hasImage();
    var has = on && selection.has();
    $("btnDeselect").disabled = !has;
    $("btnInvert").disabled = !on;
    $("btnExpand").disabled = !has;
    $("btnContract").disabled = !has;
    $("btnFeather").disabled = !has;
    $("statSel").textContent = has ? "已有选区" : "无选区";
    syncPaintHint();
  }
  var PAINT_HINTS = {
    "画笔仅在选区内绘制": 1,
    "橡皮仅在选区内绘制": 1,
    "涂抹仅在选区内绘制": 1,
    "油漆桶仅在选区内填充": 1,
    "当前图层已隐藏，绘制不会显示": 1,
  };
  function syncPaintHint() {
    if (!hasImage()) return;
    var t = tools.name;
    var layer = layers.activeLayer();
    var painting = t === "brush" || t === "eraser" || t === "smudge" || t === "fill";
    var hint = "";
    if (layer && !layer.visible && painting) hint = "当前图层已隐藏，绘制不会显示";
    else if (selection.has() && t === "brush") hint = "画笔仅在选区内绘制";
    else if (selection.has() && t === "eraser") hint = "橡皮仅在选区内绘制";
    else if (selection.has() && t === "smudge") hint = "涂抹仅在选区内绘制";
    else if (selection.has() && t === "fill") hint = "油漆桶仅在选区内填充";
    var el = $("statHint");
    if (hint) el.textContent = hint;
    else if (PAINT_HINTS[el.textContent]) el.textContent = "图片仅在本地处理";
  }
  function syncUI() {
    var on = hasImage();
    $("btnDenoise").disabled = !on || busy;
    $("btnExport").disabled = !on;
    $("btnReset").disabled = !on;
    $("btnCompare").disabled = !on;
    if ($("btnNewLayer")) $("btnNewLayer").disabled = !on;
    $("statSize").textContent = on ? layers.w + " × " + layers.h : "未打开图片";
    syncZoom();
    syncHistory();
    syncSelButtons();
    syncCursor();
  }

  var EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 12S6.5 5.5 12 5.5 21.5 12 21.5 12 17.5 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
  function updateThumbs() {
    var list = $("layerList");
    if (!list) return;
    list.innerHTML = "";
    if (layers.isEmpty()) return;
    var sc = Math.min(32 / layers.w, 32 / layers.h);
    var dw = layers.w * sc, dh = layers.h * sc;
    layers.stack.forEach(function (layer) {
      var row = document.createElement("div");
      row.className = "layer" + (layer.id === layers.activeId ? " active" : "");
      row.dataset.id = String(layer.id);
      var eye = document.createElement("button");
      eye.type = "button";
      eye.className = "eye" + (layer.visible ? "" : " off");
      eye.title = "显示/隐藏";
      eye.setAttribute("aria-label", (layer.visible ? "隐藏" : "显示") + layer.name);
      eye.innerHTML = EYE_SVG;
      var thumb = document.createElement("div");
      thumb.className = "thumb";
      var c = document.createElement("canvas");
      c.width = 32; c.height = 32;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, 32, 32);
      ctx.drawImage(layer.canvas, (32 - dw) / 2, (32 - dh) / 2, dw, dh);
      thumb.appendChild(c);
      var name = document.createElement("div");
      name.className = "name";
      name.textContent = layer.name;
      row.appendChild(eye);
      row.appendChild(thumb);
      row.appendChild(name);
      if (layers.canDelete(layer.id)) {
        var del = document.createElement("button");
        del.type = "button";
        del.className = "layer-del";
        del.title = "删除图层";
        del.setAttribute("aria-label", "删除" + layer.name);
        del.textContent = "×";
        row.appendChild(del);
      }
      list.appendChild(row);
    });
  }

  document.querySelectorAll(".tool").forEach(function (btn) {
    btn.addEventListener("click", function () { setTool(btn.getAttribute("data-tool")); });
  });

  $("btnUndo").addEventListener("click", undo);
  $("btnRedo").addEventListener("click", redo);
  $("btnZoomIn").addEventListener("click", function () {
    var r = stage.getBoundingClientRect();
    viewport.zoomAt(r.width / 2, r.height / 2, 1.25);
    syncZoom(); requestDraw();
  });
  $("btnZoomOut").addEventListener("click", function () {
    var r = stage.getBoundingClientRect();
    viewport.zoomAt(r.width / 2, r.height / 2, 0.8);
    syncZoom(); requestDraw();
  });
  $("btnFit").addEventListener("click", function () {
    if (!hasImage()) return;
    viewport.fit(layers.w, layers.h, stage.clientWidth, stage.clientHeight, 48);
    syncZoom(); requestDraw();
  });
  $("btnOneToOne").addEventListener("click", function () {
    if (!hasImage()) return;
    viewport.centerAt(layers.w, layers.h, stage.clientWidth, stage.clientHeight, 1);
    syncZoom(); requestDraw();
  });
  $("btnZoomLabel").addEventListener("click", function () { $("btnFit").click(); });

  function setCompare(v) {
    holdCompare = v && hasImage();
    requestDraw();
  }
  $("btnCompare").addEventListener("pointerdown", function (e) { e.preventDefault(); setCompare(true); });
  $("btnCompare").addEventListener("pointerup", function () { setCompare(false); });
  $("btnCompare").addEventListener("pointerleave", function () { setCompare(false); });
  $("btnSplit").addEventListener("click", function () {
    splitOn = !splitOn;
    $("btnSplit").setAttribute("aria-pressed", splitOn ? "true" : "false");
    $("btnSplit").classList.toggle("active", splitOn);
    requestDraw();
  });
  $("btnReset").addEventListener("click", function () {
    if (!hasImage()) return;
    layers.resetToOriginal();
    commit("恢复原图");
    updateThumbs();
    requestDraw();
  });

  function openPicker() { $("fileInput").click(); }
  $("btnOpen").addEventListener("click", openPicker);
  $("btnOpen2").addEventListener("click", openPicker);
  $("btnDemo").addEventListener("click", loadDemo);
  $("btnDemo2").addEventListener("click", loadDemo);
  $("btnExport").addEventListener("click", exportPNG);
  $("fileInput").addEventListener("change", function () {
    if (this.files && this.files[0]) loadFile(this.files[0]);
    this.value = "";
  });

  window.addEventListener("dragover", function (e) {
    if (Array.from(e.dataTransfer.types || []).indexOf("Files") >= 0) {
      e.preventDefault();
      document.body.classList.add("drag-over");
    }
  });
  window.addEventListener("dragleave", function (e) {
    if (e.target === document.body || e.relatedTarget == null) document.body.classList.remove("drag-over");
  });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    document.body.classList.remove("drag-over");
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.indexOf("image/") === 0) loadFile(f);
  });

  $("btnDenoise").addEventListener("click", applyDenoise);
  $("sStrength").addEventListener("input", function () {
    $("sStrengthVal").textContent = $("sStrength").value + "%";
  });
  $("sPreserve").addEventListener("input", function () {
    $("sPreserveVal").textContent = $("sPreserve").value + "%";
  });
  $("denoiseScope").querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function () {
      denoiseScope = b.getAttribute("data-scope");
      $("denoiseScope").querySelectorAll("button").forEach(function (x) {
        x.classList.toggle("on", x === b);
      });
    });
  });

  $("btnDeselect").addEventListener("click", function () {
    if (!selection.has()) return;
    selection.clear();
    commit("取消选区");
    syncSelButtons();
    requestDraw();
  });
  $("btnInvert").addEventListener("click", function () {
    if (!hasImage()) return;
    selection.invert();
    commit("反选");
    syncSelButtons();
    requestDraw();
  });
  $("btnExpand").addEventListener("click", function () {
    selection.expand(4);
    commit("扩展选区");
    syncSelButtons();
    requestDraw();
  });
  $("btnContract").addEventListener("click", function () {
    selection.contract(4);
    commit("收缩选区");
    syncSelButtons();
    requestDraw();
  });
  $("btnFeather").addEventListener("click", function () {
    selection.feather(6);
    commit("羽化选区");
    syncSelButtons();
    requestDraw();
  });

  $("btnNewLayer").addEventListener("click", function () {
    if (!hasImage()) return;
    layers.addLayer();
    commit("新建图层");
    updateThumbs();
    syncPaintHint();
    requestDraw();
  });
  $("layerList").addEventListener("click", function (e) {
    var row = e.target.closest(".layer");
    if (!row) return;
    var id = Number(row.dataset.id);
    if (e.target.closest(".eye")) {
      layers.toggleVisible(id);
      commit("图层可见性");
      updateThumbs();
      syncPaintHint();
      requestDraw();
      return;
    }
    if (e.target.closest(".layer-del")) {
      if (!layers.removeLayer(id)) return;
      commit("删除图层");
      updateThumbs();
      syncPaintHint();
      requestDraw();
      return;
    }
    layers.setActive(id);
    updateThumbs();
    syncPaintHint();
  });

  $("btnHelp").addEventListener("click", function () { $("helpModal").classList.add("show"); });
  $("btnHelpClose").addEventListener("click", function () { $("helpModal").classList.remove("show"); });
  $("helpModal").addEventListener("click", function (e) {
    if (e.target === $("helpModal")) $("helpModal").classList.remove("show");
  });

  document.addEventListener("click", function (e) {
    if (!pop.contains(e.target) && e.target.id !== "pColor") closeColorPopover();
  });

  window.addEventListener("keydown", function (e) {
    var meta = e.metaKey || e.ctrlKey;
    var key = e.key;
    if (key === " " ) {
      if (e.repeat) return;
      if (document.activeElement && document.activeElement.tagName === "INPUT") return;
      spaceDown = true;
      syncCursor();
      e.preventDefault();
      return;
    }
    if (key === "Alt") { altDown = true; syncCursor(); }
    if (key === "Shift") shiftDown = true;
    if (key === "`" || key === "·" || key === "Dead") { setCompare(true); e.preventDefault(); }
    if (key === "Escape") {
      closeColorPopover();
      $("helpModal").classList.remove("show");
      draft = null;
      requestDraw();
      return;
    }
    if (key === "?" || (key === "/" && e.shiftKey)) {
      $("helpModal").classList.toggle("show");
      e.preventDefault();
      return;
    }
    if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) {
      if (!(meta && (key === "z" || key === "Z"))) return;
    }
    if (meta && (key === "z" || key === "Z")) {
      if (e.shiftKey) redo(); else undo();
      e.preventDefault();
      return;
    }
    if (meta && (key === "y" || key === "Y")) { redo(); e.preventDefault(); return; }
    if (meta && (key === "d" || key === "D")) { $("btnDeselect").click(); e.preventDefault(); return; }
    if (meta && (key === "i" || key === "I")) { $("btnInvert").click(); e.preventDefault(); return; }
    if (meta && key === "0") { $("btnFit").click(); e.preventDefault(); return; }
    if (meta && key === "1") { $("btnOneToOne").click(); e.preventDefault(); return; }
    if (meta && (key === "s" || key === "S")) { exportPNG(); e.preventDefault(); return; }
    if (meta && (key === "o" || key === "O")) { openPicker(); e.preventDefault(); return; }
    if (busy || !key) return;
    if (e.altKey && key.length === 1) return;
    switch (key) {
      case "b": case "B": setTool("brush"); break;
      case "e": case "E": setTool("eraser"); break;
      case "g": case "G": setTool("fill"); break;
      case "i": case "I": if (!meta) setTool("eyedropper"); break;
      case "u": case "U": setTool("smudge"); break;
      case "h": case "H": setTool("hand"); break;
      case "s": case "S": if (!meta) setTool("auto"); break;
      case "l": case "L": setTool("lasso"); break;
      case "m": case "M": setTool(e.shiftKey ? "ellipse" : "rect"); break;
      case "[": tools.size = Math.max(1, Math.round(tools.size / 1.15)); renderProps(); requestDraw(); break;
      case "]": tools.size = Math.min(300, Math.round(tools.size * 1.15) || 1); renderProps(); requestDraw(); break;
      case "{": tools.hardness = Math.max(0, tools.hardness - 0.08); renderProps(); requestDraw(); break;
      case "}": tools.hardness = Math.min(1, tools.hardness + 0.08); renderProps(); requestDraw(); break;
    }
  });
  window.addEventListener("keyup", function (e) {
    if (e.key === " ") { spaceDown = false; syncCursor(); }
    if (e.key === "Alt") { altDown = false; hideLoupe(); syncCursor(); }
    if (e.key === "Shift") shiftDown = false;
    if (e.key === "`" || e.key === "·" || e.key === "Dead") setCompare(false);
  });
  window.addEventListener("blur", function () {
    spaceDown = altDown = shiftDown = false;
    setCompare(false);
    hideLoupe();
    syncCursor();
  });

  window.addEventListener("resize", function () { resizeView(); requestDraw(); });

  /* boot */
  renderProps();
  setTool("auto");
  syncUI();
  if (window.VvcatCompanion) {
    window.VvcatCompanion.mount($("catCompanion"), {
      header: document.querySelector(".topbar"),
      footer: document.querySelector(".status"),
      storageKey: "vvcatImgCatCompanionPos",
    });
  }
  requestAnimationFrame(render);
  if (/[?&#]demo\b/.test(location.search + location.hash)) {
    loadDemo();
  }
})();
