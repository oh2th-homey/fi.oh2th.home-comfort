'use strict';

/**
 * SVG to PNG, offline: resvg compiled to WebAssembly (no native module, no network) with the bundled Inter font
 * (assets/fonts, SIL Open Font License). The WebAssembly module is loaded once per process.
 */

const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const { Resvg, initWasm } = require('@resvg/resvg-wasm');

// Pixel width of the PNG (4:3, as the SVG); text and lines scale with it.
const PNG_WIDTH = 1280;

const FONTS = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf'].map((name) => path.join(__dirname, '..', 'assets', 'fonts', name));

let ready = null;
let fontBuffers = null;

async function init() {
  if (!ready) {
    ready = (async () => {
      // V8 would recompile the resvg WebAssembly with its optimizing compiler: ~120 MB more, over Homey's app memory
      // limit ("Memory Warning Limit Reached"). The baseline code draws an image in under 0.1 s, which is enough.
      // Set before the module is compiled; the app has no other WebAssembly.
      v8.setFlagsFromString('--no-wasm-tier-up');
      v8.setFlagsFromString('--no-wasm-dynamic-tiering');
      await initWasm(await fs.promises.readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
      fontBuffers = await Promise.all(FONTS.map((file) => fs.promises.readFile(file)));
    })();
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

/**
 * @description Render an SVG string to a PNG buffer.
 * @returns {Promise<Buffer>}
 */
async function toPng(svg) {
  await init();
  // resvg objects live in WebAssembly memory: free them, or every image keeps its fonts and pixels there.
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: PNG_WIDTH }, font: { fontBuffers, defaultFontFamily: 'Inter', loadSystemFonts: false } });
  try {
    const rendered = resvg.render();
    try {
      return Buffer.from(rendered.asPng());
    } finally {
      rendered.free();
    }
  } finally {
    resvg.free();
  }
}

module.exports = { toPng };
