// DVB subtitles, EN 300 743: page, region, CLUT and object segments,
// and 2-bit, 4-bit and 8-bit pixel strings. One display set is rendered
// when the end-of-display-set segment arrives. A picture is cropped to the
// pixels that are actually painted, which for a subtitle is a thin band,
// and stored as RGBA so a report stays small.

import { createBits } from "./bits.js";

const MAX_PAGE_W = 1920;
const MAX_PAGE_H = 1080;
const MAX_PIXELS = 8 * 1024 * 1024;
const MAX_SETS = 24;

function ycbcr(y, cb, cr, a) {
  const C = cb - 128;
  const R = cr - 128;
  const r = Math.max(0, Math.min(255, Math.round(y + 1.402 * R)));
  const g = Math.max(0, Math.min(255, Math.round(y - 0.344136 * C - 0.714136 * R)));
  const b = Math.max(0, Math.min(255, Math.round(y + 1.772 * C)));
  return [r, g, b, a];
}

function putPix(row, x, width, color, run) {
  for (let k = 0; k < run; k++) {
    if (x >= 0 && x < width) row[x] = color;
    x += 1;
  }
  return x;
}

// Pixel strings (EN 300 743 7.2.2 / 7.2.3). Each line is its own bit string:
// the reader fills the region width, then consumes one trailing field (6 bits
// for a 2-bit string, 8 for 4-bit and 8-bit) and rounds up to the next byte.
// That trailing field is what keeps the following line aligned; a decoder
// that skips it reads the next data_type from the middle of a run and then
// decodes the rest of the object as blanks. Each reader below takes the
// object bytes and a byte offset, and returns the bytes it used.

function lineReader2(data) {
  const br = createBits(data);
  const nbits = data.length * 8;
  return {
    left() { return nbits - br.pos(); },
    read(width, row) {
      let x = 0;
      let pixels = 0;
      while (br.left() > 0 && pixels < width) {
        const a = br.u(2);
        if (a) {
          if (x < width) row[x] = a;
          x += 1;
          pixels += 1;
          continue;
        }
        if (br.left() < 1) break;
        if (br.u(1) === 1) {
          if (br.left() < 5) break;
          const run = br.u(3) + 3;
          const color = br.u(2);
          x = putPix(row, x, width, color, run);
          pixels += run;
          continue;
        }
        if (br.left() < 1) break;
        if (br.u(1) === 1) {
          if (x < width) row[x] = 0;
          x += 1;
          pixels += 1;
          continue;
        }
        if (br.left() < 2) break;
        const s3 = br.u(2);
        if (s3 === 0) return (br.pos() + 7) >> 3; // end of string
        if (s3 === 1) {
          x = putPix(row, x, width, 0, 2);
          pixels += 2;
        } else if (s3 === 2) {
          if (br.left() < 6) break;
          const run = br.u(4) + 12;
          const color = br.u(2);
          x = putPix(row, x, width, color, run);
          pixels += run;
        } else {
          if (br.left() < 10) break;
          const run = br.u(8) + 29;
          const color = br.u(2);
          x = putPix(row, x, width, color, run);
          pixels += run;
        }
      }
      if (br.left() >= 6) br.u(6);
      return (br.pos() + 7) >> 3;
    },
  };
}

function lineReader4(data) {
  const br = createBits(data);
  const nbits = data.length * 8;
  return {
    left() { return nbits - br.pos(); },
    read(width, row) {
      let x = 0;
      let pixels = 0;
      while (br.left() > 0 && pixels < width) {
        const a = br.u(4);
        if (a) {
          if (x < width) row[x] = a;
          x += 1;
          pixels += 1;
          continue;
        }
        if (br.left() < 1) break;
        if (br.u(1) === 0) {
          if (br.left() < 3) break;
          const peek = br.u(3);
          if (peek === 0) return (br.pos() + 7) >> 3; // end of string
          x = putPix(row, x, width, 0, peek + 2);
          pixels += peek + 2;
          continue;
        }
        if (br.left() < 1) break;
        if (br.u(1) === 0) {
          if (br.left() < 6) break;
          const run = br.u(2) + 4;
          const color = br.u(4);
          x = putPix(row, x, width, color, run);
          pixels += run;
          continue;
        }
        if (br.left() < 2) break;
        const s3 = br.u(2);
        if (s3 === 0) {
          x = putPix(row, x, width, 0, 1);
          pixels += 1;
        } else if (s3 === 1) {
          x = putPix(row, x, width, 0, 2);
          pixels += 2;
        } else if (s3 === 2) {
          if (br.left() < 8) break;
          const run = br.u(4) + 9;
          const color = br.u(4);
          x = putPix(row, x, width, color, run);
          pixels += run;
        } else {
          if (br.left() < 12) break;
          const run = br.u(8) + 25;
          const color = br.u(4);
          x = putPix(row, x, width, color, run);
          pixels += run;
        }
      }
      if (br.left() >= 8) br.u(8);
      return (br.pos() + 7) >> 3;
    },
  };
}

function lineReader8(data) {
  const br = createBits(data);
  const nbits = data.length * 8;
  return {
    left() { return nbits - br.pos(); },
    read(width, row) {
      let x = 0;
      let pixels = 0;
      while (br.left() > 0 && pixels < width) {
        const a = br.u(8);
        if (a) {
          if (x < width) row[x] = a;
          x += 1;
          pixels += 1;
          continue;
        }
        if (br.left() < 1) break;
        if (br.u(1) === 0) {
          if (br.left() < 7) break;
          const run = br.u(7);
          if (!run) return (br.pos() + 7) >> 3; // end of string
          x = putPix(row, x, width, 0, run);
          pixels += run;
          continue;
        }
        if (br.left() < 15) break;
        const run = br.u(7);
        const color = br.u(8);
        x = putPix(row, x, width, color, run);
        pixels += run;
      }
      if (br.left() >= 8) br.u(8);
      return (br.pos() + 7) >> 3;
    },
  };
}

// A pixel data block is a run of data_type markers. 0x10, 0x11 and 0x12 carry
// one line of coded pixels; 0x20, 0x21 and 0x22 change the code maps; 0xF0 is
// the end-of-line marker (EN 300 743 7.2.2). 0xF0 does not end the object:
// the next line follows it. A line marker advances the row unless the very
// next byte is 0xF0, which then does the advance itself, so an encoder that
// marks every line and one that never marks them both decode correctly.
function paintField(data, width, height, y0, step, pix) {
  if (!data || !data.length) return;
  let pos = 0;
  let y = y0;
  while (pos < data.length && y < height) {
    const dtype = data[pos];
    if (dtype === 0xf0) {
      pos += 1;
      y += step;
      continue;
    }
    pos += 1;
    const row = pix.subarray(y * width, (y + 1) * width);
    let used = 0;
    if (dtype === 0x10) used = lineReader2(data.subarray(pos)).read(width, row);
    else if (dtype === 0x11) used = lineReader4(data.subarray(pos)).read(width, row);
    else if (dtype === 0x12) used = lineReader8(data.subarray(pos)).read(width, row);
    else if (dtype === 0x20) used = 2;
    else if (dtype === 0x21) used = 4;
    else if (dtype === 0x22) used = 16;
    else { continue; } // not a marker we know: skip the byte
    pos += used;
    if (data[pos] !== 0xf0) y += step;
  }
}

function decodeObject(body) {
  if (body.length < 3) return null;
  const id = (body[0] << 8) | body[1];
  const method = (body[2] >> 2) & 3;
  // Only coded pixel data is decoded. A character or string object points at
  // a font this tool does not carry; the region still shows its background.
  if (method !== 0 || body.length < 7) return { id, method, top: null, bot: null };
  const topLen = (body[3] << 8) | body[4];
  const botLen = (body[5] << 8) | body[6];
  const top = body.subarray(7, Math.min(body.length, 7 + topLen));
  const bot = body.subarray(7 + topLen, Math.min(body.length, 7 + topLen + botLen));
  return { id, method, top, bot };
}

function parseClut(body) {
  if (body.length < 2) return null;
  const id = body[0];
  const entries = [];
  let i = 2;
  while (i + 2 <= body.length) {
    const entryId = body[i];
    const flags = body[i + 1];
    i += 2;
    // EN 300 743 7.2.5: entry_is_full_range_flag is the low bit. A full
    // range entry carries Y, Cr and Cb as 8-bit values and an 8-bit T; a
    // limited range entry packs Y, Cr, Cb and T into two bytes.
    const full = (flags & 0x01) !== 0;
    let y = 0;
    let cb = 128;
    let cr = 128;
    let t = 0;
    if (full) {
      if (i + 4 > body.length) break;
      y = body[i];
      cr = body[i + 1];
      cb = body[i + 2];
      t = body[i + 3];
      i += 4;
    } else {
      if (i + 2 > body.length) break;
      y = (body[i] >> 2) << 2;
      cr = (((body[i] & 3) << 2) | (body[i + 1] >> 6)) << 4;
      cb = ((body[i + 1] >> 2) & 0xF) << 4;
      t = body[i + 1] & 3;
      i += 2;
    }
    // A Y of 0 marks the entry as fully transparent, and T is stored as
    // alpha in the inverted sense (FFmpeg does the same). Without this the
    // region fill colour paints a solid block over the video.
    const alpha = y === 0 ? 0 : 255 - t;
    entries.push({ id: entryId, flags, rgba: ycbcr(y, cb, cr, alpha) });
  }
  return { id, entries };
}

function parsePage(body) {
  if (body.length < 2) return null;
  const regions = [];
  let i = 2;
  while (i + 6 <= body.length) {
    regions.push({
      id: body[i],
      x: (body[i + 2] << 8) | body[i + 3],
      y: (body[i + 4] << 8) | body[i + 5],
    });
    i += 6;
  }
  return { state: (body[1] >> 2) & 3, regions };
}

function parseRegion(body) {
  if (body.length < 10) return null;
  const objects = [];
  let i = 10;
  while (i + 6 <= body.length) {
    const oid = (body[i] << 8) | body[i + 1];
    const type = (body[i + 2] >> 6) & 3;
    const x = ((body[i + 2] & 0x0F) << 8) | body[i + 3];
    const y = ((body[i + 4] & 0x0F) << 8) | body[i + 5];
    i += 6;
    // A type 1 object carries a foreground pixel code, a type 2 object also
    // a background pixel code (EN 300 743 7.2.4).
    let fore = null;
    let back = null;
    if (type === 1 || type === 2) {
      if (i + 1 > body.length) break;
      fore = body[i];
      i += 1;
    }
    if (type === 2) {
      if (i + 1 > body.length) break;
      back = body[i];
      i += 1;
    }
    objects.push({ id: oid, x, y, type, fore, back });
  }
  return {
    id: body[0],
    w: (body[2] << 8) | body[3],
    h: (body[4] << 8) | body[5],
    clut: body[7],
    objects,
  };
}

export function render(page, regions, objects, cluts) {
  if (!page) return null;
  let width = 1;
  let height = 1;
  for (const ref of page.regions) {
    const region = regions.get(ref.id);
    if (!region) continue;
    width = Math.max(width, ref.x + region.w);
    height = Math.max(height, ref.y + region.h);
  }
  width = Math.min(MAX_PAGE_W, Math.max(1, width));
  height = Math.min(MAX_PAGE_H, Math.max(1, height));
  if (width * height > MAX_PIXELS) {
    return { width, height, pixels: null, bbox: null, note: "picture kept as a size only" };
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (const ref of page.regions) {
    const region = regions.get(ref.id);
    if (!region) continue;
    const clut = cluts.get(region.clut) || [];
    const table = new Map();
    for (const e of clut) table.set(e.id, e.rgba);
    if (!table.has(0)) table.set(0, [0, 0, 0, 0]);
    for (const objRef of region.objects) {
      const obj = objects.get(objRef.id);
      if (!obj) continue;
      const pix = new Uint8Array(region.w * region.h);
      if (obj.top && obj.top.length) {
        if (!obj.bot || !obj.bot.length) paintField(obj.top, region.w, region.h, 0, 1, pix);
        else {
          paintField(obj.top, region.w, region.h, 0, 2, pix);
          paintField(obj.bot, region.w, region.h, 1, 2, pix);
        }
      }
      for (let y = 0; y < region.h; y++) {
        const dy = ref.y + objRef.y + y;
        if (dy < 0 || dy >= height) continue;
        for (let x = 0; x < region.w; x++) {
          const dx = ref.x + objRef.x + x;
          if (dx < 0 || dx >= width) continue;
          const idx = pix[y * region.w + x];
          const color = table.get(idx);
          if (!color || color[3] === 0) continue;
          const o = (dy * width + dx) * 4;
          rgba[o] = color[0];
          rgba[o + 1] = color[1];
          rgba[o + 2] = color[2];
          rgba[o + 3] = color[3];
          if (dx < minX) minX = dx;
          if (dx > maxX) maxX = dx;
          if (dy < minY) minY = dy;
          if (dy > maxY) maxY = dy;
        }
      }
    }
  }
  if (maxX < 0) {
    // A display set with nothing painted is a clear, not a subtitle.
    return { width: 0, height: 0, pixels: null, bbox: null, note: "empty display set" };
  }
  // Crop to what is painted. A subtitle is a band a few dozen rows tall, so
  // this drops most of the pixels a full page would cost.
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const crop = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const from = ((minY + y) * width + minX) * 4;
    crop.set(rgba.subarray(from, from + cw * 4), y * cw * 4);
  }
  return {
    width: cw,
    height: ch,
    pixels: Array.from(crop),
    bbox: { x: minX, y: minY },
    pageWidth: width,
    pageHeight: height,
    note: "",
  };
}

export function decodeSubtitlePes(payload) {
  if (!payload || payload.length < 3 || payload[0] !== 0x20) return [];
  const sets = [];
  let page = null;
  const regions = new Map();
  const objects = new Map();
  const cluts = new Map();
  let i = 2;
  while (i + 6 <= payload.length) {
    if (payload[i] === 0xFF) break;
    if (payload[i] !== 0x0F) {
      i += 1;
      continue;
    }
    const type = payload[i + 1];
    const len = (payload[i + 4] << 8) | payload[i + 5];
    if (i + 6 + len > payload.length) break;
    const body = payload.subarray(i + 6, i + 6 + len);
    i += 6 + len;
    if (type === 0x10) {
      const parsed = parsePage(body);
      if (parsed && parsed.state === 1) {
        regions.clear();
        objects.clear();
      }
      page = parsed;
    } else if (type === 0x11) {
      const parsed = parseRegion(body);
      if (parsed) regions.set(parsed.id, parsed);
    } else if (type === 0x12) {
      const parsed = parseClut(body);
      if (parsed) cluts.set(parsed.id, parsed.entries);
    } else if (type === 0x13) {
      const parsed = decodeObject(body);
      if (parsed) objects.set(parsed.id, parsed);
    } else if (type === 0x80) {
      const picture = render(page, regions, objects, cluts);
      if (picture) sets.push(picture);
      if (sets.length >= MAX_SETS) break;
    }
  }
  return sets;
}

export function createDvbSub() {
  const sets = [];
  return {
    push(payload, packetIndex, pts, pid) {
      if (sets.length >= MAX_SETS) return;
      for (const picture of decodeSubtitlePes(payload)) {
        // A display set with nothing painted is a clear, not a caption. It is
        // dropped rather than stored, so the timeline only marks captions a
        // reader can actually see.
        if (!picture.pixels) continue;
        sets.push({ ...picture, packetIndex, pts, pid: pid || 0 });
        if (sets.length >= MAX_SETS) return;
      }
    },
    finish() {
      return sets;
    },
  };
}
