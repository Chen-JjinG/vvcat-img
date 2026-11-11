/* Classic worker (no modules) so static hosts and most browsers can load it. */
importScripts("denoise-core.js");

self.onmessage = function (e) {
  var msg = e.data || {};
  var id = msg.id;
  try {
    var data = new Uint8ClampedArray(msg.buffer);
    var mask = null;
    if (msg.maskBuffer) mask = new Uint8Array(msg.maskBuffer);
    var result = DenoiseCore.denoise(
      { data: data, width: msg.width, height: msg.height },
      {
        strength: msg.strength,
        preserveEdges: msg.preserveEdges,
        flatFill: msg.flatFill,
        mask: mask,
        onProgress: function (p) {
          self.postMessage({ id: id, type: "progress", progress: p });
        },
      }
    );
    self.postMessage(
      {
        id: id,
        type: "done",
        buffer: result.data.buffer,
        width: result.width,
        height: result.height,
      },
      [result.data.buffer]
    );
  } catch (err) {
    self.postMessage({
      id: id,
      type: "error",
      message: (err && err.message) || String(err),
    });
  }
};
