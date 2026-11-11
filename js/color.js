(function (global) {
  "use strict";
  var LIN = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function rgbToLab(r, g, b) {
    var R = LIN[r & 255],
      G = LIN[g & 255],
      B = LIN[b & 255];
    var x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
    var y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
    var z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
    var fx = x > 0.008856 ? Math.cbrt(x) : 7.787037 * x + 16 / 116;
    var fy = y > 0.008856 ? Math.cbrt(y) : 7.787037 * y + 16 / 116;
    var fz = z > 0.008856 ? Math.cbrt(z) : 7.787037 * z + 16 / 116;
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  function labDist(a, b) {
    var dL = a.L - b.L,
      da = a.a - b.a,
      db = a.b - b.b;
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    var h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: h, s: max === 0 ? 0 : d / max, v: max };
  }

  function hsvToRgb(h, s, v) {
    var c = v * s,
      x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
      m = v - c;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  function toHex(r, g, b) {
    function h(v) {
      v = clamp(Math.round(v), 0, 255);
      return (v < 16 ? "0" : "") + v.toString(16);
    }
    return ("#" + h(r) + h(g) + h(b)).toUpperCase();
  }

  function parseHex(str) {
    if (!str) return null;
    str = str.trim().replace(/^#/, "");
    if (str.length === 3)
      str = str[0] + str[0] + str[1] + str[1] + str[2] + str[2];
    if (!/^[0-9a-fA-F]{6}$/.test(str)) return null;
    return {
      r: parseInt(str.slice(0, 2), 16),
      g: parseInt(str.slice(2, 4), 16),
      b: parseInt(str.slice(4, 6), 16),
    };
  }

  function css(r, g, b, a) {
    if (a == null || a >= 1) return "rgb(" + r + "," + g + "," + b + ")";
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  global.DN = global.DN || {};
  global.DN.Color = {
    clamp: clamp,
    rgbToLab: rgbToLab,
    labDist: labDist,
    rgbToHsv: rgbToHsv,
    hsvToRgb: hsvToRgb,
    toHex: toHex,
    parseHex: parseHex,
    css: css,
  };
})(typeof window !== "undefined" ? window : self);
