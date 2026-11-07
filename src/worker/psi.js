// PSI/SI reassembly and a small tree: PAT, PMT, SDT, NIT, EIT.
// Sections that span packets are joined. The TR 101 290 checks use a
// separate one-packet section parse.

import { crc32Mpeg } from "./crc.js";
import { decodeDvbText } from "./dvbtext.js";
import { shortKind, streamName } from "./stream-type.js";
import { payloadBytes, readPid } from "./tsutil.js";

function text(bytes) {
  return decodeDvbText(bytes);
}

function u16(body, i) {
  return (body[i] << 8) | body[i + 1];
}

function descriptors(bytes) {
  const out = [];
  let i = 0;
  while (i + 2 <= bytes.length) {
    const tag = bytes[i];
    const len = bytes[i + 1];
    if (i + 2 + len > bytes.length) break;
    const body = bytes.subarray(i + 2, i + 2 + len);
    out.push(describe(tag, body));
    i += 2 + len;
  }
  return out;
}

function describe(tag, body) {
  const base = { tag, length: body.length };
  if (tag === 0x0A && body.length >= 3) {
    return { ...base, name: "ISO_639_language", text: text(body.subarray(0, 3)) };
  }
  if (tag === 0x40) return { ...base, name: "network_name", text: text(body) };
  if (tag === 0x48 && body.length >= 2) {
    const provLen = body[1];
    const nameAt = 2 + provLen;
    const nameLen = nameAt < body.length ? body[nameAt] : 0;
    return {
      ...base,
      name: "service",
      provider: text(body.subarray(2, 2 + provLen)),
      text: text(body.subarray(nameAt + 1, nameAt + 1 + nameLen)),
    };
  }
  if (tag === 0x4D && body.length >= 4) {
    const nameLen = body[3];
    const name = text(body.subarray(4, 4 + nameLen));
    return { ...base, name: "short_event", text: name, language: text(body.subarray(0, 3)) };
  }
  if (tag === 0x52 && body.length >= 1) {
    return { ...base, name: "stream_identifier", text: String(body[0]) };
  }
  if (tag === 0x02 && body.length >= 3) {
    return { ...base, name: "video_stream", text: "frame rate 0x" + body[0].toString(16) };
  }
  if (tag === 0x05 && body.length >= 4) {
    return { ...base, name: "registration", text: text(body.subarray(0, 4)) };
  }
  if (tag === 0x09 && body.length >= 4) {
    const ca = (body[0] << 8) | body[1];
    const pid = ((body[2] & 0x1F) << 8) | body[3];
    return { ...base, name: "CA", text: "system " + ca + " PID " + pid };
  }
  if (tag === 0x0E && body.length >= 3) {
    return { ...base, name: "maximum_bitrate", text: String(((body[0] & 0x3F) << 16) | (body[1] << 8) | body[2]) };
  }
  if (tag === 0x28 && body.length >= 4) {
    return {
      ...base,
      name: "AVC_video",
      profile: body[0],
      constraint: body[1],
      level: body[2],
      text: "profile " + body[0] + " level " + body[2],
    };
  }
  if (tag === 0x2A && body.length >= 2) {
    const flag = (body[0] >> 7) & 1;
    const timing = body[0] & 1;
    return {
      ...base,
      name: "AVC_timing_and_HRD",
      hrdManagementValid: flag,
      pictureAndTiming: timing,
      text: flag ? "HRD-managed" : "leak method",
    };
  }
  if (tag === 0x41 && body.length >= 3) {
    const names = [];
    for (let i = 0; i + 3 <= body.length; i += 3) {
      names.push(String((body[i] << 8) | body[i + 1]));
    }
    return { ...base, name: "service_list", text: names.join(", ") };
  }
  if (tag === 0x43 && body.length >= 11) {
    return { ...base, name: "satellite_delivery", text: text(body.subarray(0, 8)) };
  }
  if (tag === 0x44 && body.length >= 11) {
    return { ...base, name: "cable_delivery", text: text(body.subarray(0, 8)) };
  }
  if (tag === 0x4A && body.length >= 7) {
    return { ...base, name: "linkage", text: "ts " + u16(body, 0) + " service " + u16(body, 4) };
  }
  if (tag === 0x50 && body.length >= 6) {
    return { ...base, name: "component", text: text(body.subarray(0, 3)) + " " + text(body.subarray(4)) };
  }
  if (tag === 0x54 && body.length >= 2) {
    const nibbles = [];
    for (let i = 0; i + 1 < body.length; i += 2) nibbles.push(body[i].toString(16));
    return { ...base, name: "content", text: nibbles.join(",") };
  }
  if (tag === 0x55 && body.length >= 4) {
    return { ...base, name: "parental_rating", text: text(body.subarray(0, 3)) + " " + body[3] };
  }
  if (tag === 0x56) {
    const parts = [];
    const pages = [];
    for (let i = 0; i + 5 <= body.length; i += 5) {
      const language = text(body.subarray(i, i + 3));
      const type = body[i + 3] >> 3;
      const magazine = body[i + 3] & 7;
      // teletext_page_number is two BCD digits, so 0x91 is page 91.
      const tens = (body[i + 4] >> 4) & 0x0F;
      const units = body[i + 4] & 0x0F;
      const page = (magazine === 0 ? 8 : magazine) * 100 + tens * 10 + units;
      parts.push(language + " " + page);
      // A language entry can also be an index or program page; the subtitle
      // pages are the ones telxcc is asked for, and the type says which is which.
      pages.push({ language, page, type });
    }
    return { ...base, name: "teletext", text: parts.join("; ") || "teletext", pages };
  }
  if (tag === 0x59) {
    const parts = [];
    for (let i = 0; i + 8 <= body.length; i += 8) {
      parts.push(text(body.subarray(i, i + 3)) + " type " + body[i + 3]);
    }
    return { ...base, name: "subtitling", text: parts.join("; ") || "subtitle" };
  }
  if (tag === 0x5A && body.length >= 2) {
    return { ...base, name: "terrestrial_delivery", text: "centre " + u16(body, 0) };
  }
  if (tag === 0x6A) return { ...base, name: "AC-3", text: "AC-3" };
  if (tag === 0x7A) return { ...base, name: "enhanced_AC-3", text: "E-AC-3" };
  if (tag === 0x7C) return { ...base, name: "AAC", text: "AAC" };
  if (tag === 0x83) {
    const parts = [];
    for (let i = 0; i + 4 <= body.length; i += 4) {
      const lcn = ((body[i + 2] & 0x03) << 8) | body[i + 3];
      parts.push(u16(body, i) + ":" + lcn);
    }
    return { ...base, name: "logical_channel", text: parts.join(", ") };
  }
  return { ...base, name: "descriptor_0x" + tag.toString(16), text: "" };
}

function bcd(n) {
  return ((n >> 4) & 0xF) * 10 + (n & 0xF);
}

export function mjdToDate(mjd) {
  const yp = Math.floor((mjd - 15078.2) / 365.25);
  const mp = Math.floor((mjd - 14956.1 - Math.floor(yp * 365.25)) / 30.6001);
  const k = mp === 14 || mp === 15 ? 1 : 0;
  const year = yp + k + 1900;
  const month = mp - 1 - k * 12;
  const day = mjd - 14956 - Math.floor(yp * 365.25) - Math.floor(mp * 30.6001);
  return { year, month, day };
}

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

function parseEitEvents(body) {
  const events = [];
  let i = 6;
  while (i + 12 <= body.length) {
    const eventId = (body[i] << 8) | body[i + 1];
    const mjd = (body[i + 2] << 8) | body[i + 3];
    const date = mjdToDate(mjd);
    const start = date.year + "-" + pad(date.month) + "-" + pad(date.day)
      + " " + pad(bcd(body[i + 4])) + ":" + pad(bcd(body[i + 5])) + ":" + pad(bcd(body[i + 6]));
    const duration = pad(bcd(body[i + 7])) + ":" + pad(bcd(body[i + 8])) + ":" + pad(bcd(body[i + 9]));
    const word = (body[i + 10] << 8) | body[i + 11];
    const running = word >> 13;
    const dlen = word & 0x0FFF;
    const desc = descriptors(body.subarray(i + 12, i + 12 + dlen));
    const named = desc.find((d) => d.name === "short_event");
    events.push({
      eventId, start, duration, running,
      name: named ? named.text : "",
    });
    i += 12 + dlen;
    if (events.length >= 400) break;
  }
  return events;
}

function parseSection(section) {
  const tableId = section[0];
  const length = ((section[1] & 0x0F) << 8) | section[2];
  if (section.length < 3 + length) return null;
  if (crc32Mpeg(section.subarray(0, 3 + length)) !== 0) return { crc: false, tableId };
  const ext = (section[3] << 8) | section[4];
  const version = (section[5] >> 1) & 0x1F;
  const body = section.subarray(8, 3 + length - 4);
  if (tableId === 0x00) {
    const programs = [];
    let networkPid = null;
    for (let i = 0; i + 4 <= body.length; i += 4) {
      const program = (body[i] << 8) | body[i + 1];
      const pid = ((body[i + 2] & 0x1F) << 8) | body[i + 3];
      if (program === 0) networkPid = pid;
      else programs.push({ program, pid });
    }
    return { crc: true, tableId, ext, version, programs, networkPid };
  }
  if (tableId === 0x02) {
    if (body.length < 4) return { crc: true, tableId };
    const pcrPid = ((body[0] & 0x1F) << 8) | body[1];
    const piLen = ((body[2] & 0x0F) << 8) | body[3];
    const programInfo = descriptors(body.subarray(4, 4 + piLen));
    const streams = [];
    let i = 4 + piLen;
    while (i + 5 <= body.length) {
      const type = body[i];
      const pid = ((body[i + 1] & 0x1F) << 8) | body[i + 2];
      const esLen = ((body[i + 3] & 0x0F) << 8) | body[i + 4];
      const info = descriptors(body.subarray(i + 5, i + 5 + esLen));
      let hrdManagementValid = null;
      for (const d of info) {
        if (d.name === "AVC_timing_and_HRD") hrdManagementValid = d.hrdManagementValid;
      }
      streams.push({
        type, pid, info,
        typeName: streamName(type, info),
        shortKind: shortKind(type, info, pid),
        hrdManagementValid,
        teletext: info.some((d) => d.name === "teletext"),
        subtitle: info.some((d) => d.name === "subtitling"),
      });
      i += 5 + esLen;
    }
    return { crc: true, tableId, program: ext, version, pcrPid, programInfo, streams };
  }
  if (tableId === 0x42 || tableId === 0x46) {
    if (body.length < 3) return { crc: true, tableId };
    const onid = (body[0] << 8) | body[1];
    const services = [];
    let i = 3;
    while (i + 5 <= body.length) {
      const id = (body[i] << 8) | body[i + 1];
      const word = (body[i + 3] << 8) | body[i + 4];
      const dlen = word & 0x0FFF;
      const desc = descriptors(body.subarray(i + 5, i + 5 + dlen));
      const svc = desc.find((d) => d.name === "service");
      services.push({
        id,
        running: word >> 13,
        name: svc ? svc.text : "",
        provider: svc ? svc.provider : "",
      });
      i += 5 + dlen;
    }
    return { crc: true, tableId, tsId: ext, onid, services };
  }
  if (tableId === 0x40 || tableId === 0x41) {
    if (body.length < 2) return { crc: true, tableId };
    const nlen = ((body[0] & 0x0F) << 8) | body[1];
    const nd = descriptors(body.subarray(2, 2 + nlen));
    const named = nd.find((d) => d.name === "network_name");
    let i = 2 + nlen;
    const transports = [];
    if (i + 2 <= body.length) {
      const tlen = ((body[i] & 0x0F) << 8) | body[i + 1];
      i += 2;
      const end = Math.min(body.length, i + tlen);
      while (i + 6 <= end) {
        const tsId = (body[i] << 8) | body[i + 1];
        const onid = (body[i + 2] << 8) | body[i + 3];
        const dlen = ((body[i + 4] & 0x0F) << 8) | body[i + 5];
        transports.push({ tsId, onid });
        i += 6 + dlen;
      }
    }
    return { crc: true, tableId, networkId: ext, name: named ? named.text : "", transports, descriptors: nd };
  }
  if (tableId >= 0x4E && tableId <= 0x6F) {
    return { crc: true, tableId, serviceId: ext, events: parseEitEvents(body) };
  }
  return { crc: true, tableId, ext, version };
}

export function createPsi() {
  const partial = new Map();
  const watch = new Set([0x0000, 0x0001, 0x0010, 0x0011, 0x0012, 0x0014]);
  const esPids = new Set();
  const tree = {
    pat: null,
    pmts: [],
    sdt: null,
    nit: null,
    eit: [],
    epg: [],
    tdt: null,
    crcErrors: 0,
    sctePids: [],
    badScte: 0,
  };
  const scteSections = [];

  function append(pid, bytes) {
    const prev = partial.get(pid);
    if (!prev || !prev.length) {
      partial.set(pid, bytes.slice());
      return;
    }
    if (prev.length + bytes.length > 8192) {
      partial.set(pid, new Uint8Array(0));
      return;
    }
    const next = new Uint8Array(prev.length + bytes.length);
    next.set(prev, 0);
    next.set(bytes, prev.length);
    partial.set(pid, next);
  }

  function take(pid) {
    const buf = partial.get(pid);
    if (!buf) return [];
    const out = [];
    let i = 0;
    while (i + 3 <= buf.length) {
      if (buf[i] === 0xFF) { i++; continue; }
      const len = ((buf[i + 1] & 0x0F) << 8) | buf[i + 2];
      const total = 3 + len;
      if (len < 1 || total > 4096) {
        partial.set(pid, new Uint8Array(0));
        return out;
      }
      if (i + total > buf.length) break;
      out.push(buf.slice(i, i + total));
      i += total;
    }
    partial.set(pid, buf.slice(i));
    return out;
  }

  function accept(section, pid, packetIndex) {
    if (section[0] === 0xFC) {
      // A section that looks like splice_info_section but fails its CRC is
      // payload noise, not a splice. Check before it reaches the SCTE list.
      const len = ((section[1] & 0x0F) << 8) | section[2];
      const total = 3 + len;
      if (len < 4 || section.length < total || crc32Mpeg(section.subarray(0, total)) !== 0) {
        tree.badScte += 1;
        return;
      }
      scteSections.push({ section: section.slice(0, total), pid, packetIndex });
      return;
    }
    if (section[0] === 0x70 || section[0] === 0x73) {
      const when = takeTime(section);
      if (when) tree.tdt = { tableId: section[0], time: when, packetIndex };
      return;
    }
    const syntax = (section[1] & 0x80) !== 0;
    if (!syntax && section[0] !== 0xFC) return;
    const parsed = parseSection(section);
    if (!parsed) return;
    if (parsed.crc === false) {
      tree.crcErrors += 1;
      return;
    }
    if (parsed.tableId === 0x00) {
      tree.pat = parsed;
      for (const program of parsed.programs) watch.add(program.pid);
      if (parsed.networkPid !== null) watch.add(parsed.networkPid);
    }
    else if (parsed.tableId === 0x02) {
      const rest = tree.pmts.filter((p) => p.program !== parsed.program);
      rest.push(parsed);
      tree.pmts = rest;
      for (const stream of parsed.streams || []) {
        if (stream.type === 0x86) {
          watch.add(stream.pid);
          if (!tree.sctePids.includes(stream.pid)) tree.sctePids.push(stream.pid);
        } else {
          esPids.add(stream.pid);
        }
      }
    } else if (parsed.tableId === 0x42 || parsed.tableId === 0x46) tree.sdt = parsed;
    else if (parsed.tableId === 0x40 || parsed.tableId === 0x41) tree.nit = parsed;
    else if (parsed.events) {
      for (const ev of parsed.events) {
        if (tree.eit.length >= 2000) break;
        const row = { serviceId: parsed.serviceId, tableId: parsed.tableId, ...ev };
        tree.eit.push(row);
        let bucket = tree.epg.find((g) => g.serviceId === parsed.serviceId);
        if (!bucket) {
          bucket = { serviceId: parsed.serviceId, events: [] };
          tree.epg.push(bucket);
        }
        if (bucket.events.length < 400) bucket.events.push(row);
      }
    }
  }

  function takeTime(section) {
    if (section.length < 8) return null;
    const mjd = (section[3] << 8) | section[4];
    const date = mjdToDate(mjd);
    return date.year + "-" + pad(date.month) + "-" + pad(date.day)
      + " " + pad(bcd(section[5])) + ":" + pad(bcd(section[6])) + ":" + pad(bcd(section[7]));
  }

  return {
    push(pkt, packetIndex) {
      const pid = readPid(pkt);
      if (pid === 0x1FFF) return;
      // An elementary stream carries PES, never PSI. Once the PMT has named
      // it, stop looking for sections on it.
      if (esPids.has(pid)) return;
      const pusi = (pkt[1] & 0x40) !== 0;
      if (!watch.has(pid)) {
        if (!pusi) return;
        const peek = payloadBytes(pkt);
        if (!peek || peek.length < 4 || peek[0] > 8) return;
        // 00 00 01 is a PES start code. Reading its second byte as a
        // table_id is how a video PID used to be mistaken for PSI.
        if (peek[0] === 0 && peek[1] === 0 && peek[2] === 1) return;
        const tableId = peek[1 + peek[0]];
        if (tableId !== 0x02 && tableId !== 0xFC && tableId !== 0x00 && tableId !== 0x70 && tableId !== 0x73) return;
        watch.add(pid);
      }
      const payload = payloadBytes(pkt);
      if (!payload || !payload.length) return;
      if (!pusi) {
        append(pid, payload);
      } else {
        const pointer = payload[0];
        if (pointer > payload.length - 1) {
          partial.set(pid, new Uint8Array(0));
          return;
        }
        if (pointer > 0) append(pid, payload.subarray(1, 1 + pointer));
        for (const section of take(pid)) accept(section, pid, packetIndex);
        partial.set(pid, payload.subarray(1 + pointer).slice());
      }
      for (const section of take(pid)) accept(section, pid, packetIndex);
    },
    takeScte() {
      const out = scteSections.splice(0, scteSections.length);
      return out;
    },
    tree() {
      return tree;
    },
  };
}
