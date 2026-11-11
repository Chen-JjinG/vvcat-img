#!/usr/bin/env node
/**
 * Load a PNG via a tiny Python helper, run DenoiseCore, write a PNG.
 * Usage: node scripts/run-denoise.js <in.png> <out.png> [strength] [preserve] [flatFill]
 */
var fs = require("fs");
var path = require("path");
var { execFileSync } = require("child_process");
var { denoise } = require("../js/denoise-core.js");

var inp = process.argv[2];
var out = process.argv[3];
if (!inp || !out) {
  console.error("usage: node scripts/run-denoise.js <in.png> <out.png> [strength] [preserve] [flatFill]");
  process.exit(1);
}
var strength = process.argv[4] != null ? Number(process.argv[4]) : 0.9;
var preserve = process.argv[5] != null ? Number(process.argv[5]) : 0.88;
var flatFill = process.argv[6] == null ? true : process.argv[6] !== "0" && process.argv[6] !== "false";

var tmp = "/tmp/denoise-run-" + process.pid;
var pyDump = [
  "from PIL import Image",
  "import sys, numpy as np",
  "im = Image.open(sys.argv[1]).convert('RGBA')",
  "arr = np.array(im)",
  "open(sys.argv[2]+'.meta','w').write('%d %d'% (arr.shape[1], arr.shape[0]))",
  "arr.tofile(sys.argv[2]+'.rgba')",
].join("\n");
execFileSync("python3", ["-c", pyDump, inp, tmp], { stdio: "inherit" });
var wh = fs.readFileSync(tmp + ".meta", "utf8").trim().split(/\s+/).map(Number);
var w = wh[0], h = wh[1];
var buf = fs.readFileSync(tmp + ".rgba");
var data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
console.log("input", inp, w + "x" + h, "strength", strength, "preserve", preserve, "flatFill", flatFill);
var t0 = Date.now();
var result = denoise(
  { data: data, width: w, height: h },
  { strength: strength, preserveEdges: preserve, flatFill: flatFill }
);
console.log("done in", Date.now() - t0, "ms");
fs.writeFileSync(tmp + "-out.rgba", Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength));
var pyWrap = [
  "from PIL import Image",
  "import sys, numpy as np",
  "w,h=map(int,open(sys.argv[1]).read().split())",
  "arr=np.fromfile(sys.argv[2],dtype=np.uint8).reshape(h,w,4)",
  "Image.fromarray(arr,'RGBA').save(sys.argv[3])",
].join("\n");
execFileSync("python3", ["-c", pyWrap, tmp + ".meta", tmp + "-out.rgba", out], { stdio: "inherit" });
console.log("wrote", out);
