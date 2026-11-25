import { Style, Avatar } from '@dicebear/core';
import lorelei from '@dicebear/styles/lorelei.json' with { type: 'json' };
export function create(seed, label) {
  const svg = new Avatar(new Style(lorelei), { seed: String(seed), size: 128 }).toString()
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<metadata[\s\S]*?<\/metadata>/g, '')
    .replace(/\bstyle="mask-type:(alpha|luminance)"/g, 'mask-type="$1"');
  const bytes = new TextEncoder().encode(svg);
  const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  return { src: 'data:image/svg+xml;base64,' + base64, alt: 'Illustrated portrait for ' + String(label || seed),
    generator: 'DiceBear Lorelei', version: 'core10.7.0/styles10.6.0', seed: String(seed), licence: 'CC0-1.0' };
}
