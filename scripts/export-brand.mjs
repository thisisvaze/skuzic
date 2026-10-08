// Run from the repository root: node scripts/export-brand.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';

// The vector mark is the single source of truth. It sits centred in a 1024
// square, so the app icon is the same art with that square as its viewBox.
const mark = readFileSync('public/brand/skuzic-mark.svg', 'utf8');
const icon = mark.replace(/viewBox="[^"]*"/, 'viewBox="0 0 1024 1024"');

function png(svg, path, width, background) {
  const image = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background,
    font: { loadSystemFonts: false },
  }).render();
  // App icons are RGB with no alpha channel; the inline logo stays transparent.
  const output = background
    ? PNG.sync.write({ width: image.width, height: image.height, data: image.pixels }, { colorType: 2 })
    : image.asPng();
  writeFileSync(path, output);
  console.log(`Exported ${path}`);
}

png(mark, 'ios/Skuzic/Assets.xcassets/SkuzicMark.imageset/mark.png', 736);
png(icon, 'ios/Skuzic/Assets.xcassets/AppIcon.appiconset/icon-1024.png', 1024, '#fcfbf8');
png(icon, 'public/apple-touch-icon.png', 180, '#fcfbf8');
writeFileSync('public/favicon.svg', mark);
