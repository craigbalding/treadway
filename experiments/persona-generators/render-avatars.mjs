// Optional visual check: compare rendered pixels, not SVG metadata/IDs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { Style, Avatar } from '@dicebear/core';
import lorelei from '@dicebear/styles/lorelei.json' with { type: 'json' };

const style = new Style(lorelei);
const svgs = Array.from({ length: 500 }, (_, i) => new Avatar(style, { seed: `sample-persona-${i}`, size: 128 }).toString());
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 620, height: 680 } });
  await page.route('**/*', route => route.abort());
  const result = await page.evaluate(async inputs => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d'); const images = [];
    for (const svg of inputs) {
      const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await image.decode(); ctx.clearRect(0, 0, 128, 128); ctx.drawImage(image, 0, 0, 128, 128);
      images.push(canvas.toDataURL('image/png'));
    }
    return { samples: inputs.length - 1, repeatedControlMatches: images[0] === images.at(-1),
      uniqueRenderedPngs: new Set(images.slice(0, -1)).size };
  }, [...svgs, svgs[0]]);
  assert.equal(result.repeatedControlMatches, true);
  await page.setContent('<style>body{font:14px sans-serif;background:white}main{display:grid;grid-template-columns:repeat(4,140px);gap:8px}figure{margin:0;text-align:center}img{width:128px;height:128px}</style><main>' +
    svgs.slice(0, 16).map((svg, i) => '<figure><img src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '"><figcaption>Sample ' + i + '</figcaption></figure>').join('') + '</main>');
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('./artifacts/avatars.png', import.meta.url).pathname });
  await writeFile(new URL('./artifacts/avatar-pixel-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
