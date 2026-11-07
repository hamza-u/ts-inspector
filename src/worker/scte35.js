// SCTE-35 splice_info_section (table id 0xFC).
// Bit reads use multiplication, not `<<`, so a 33-bit PTS stays exact.

import { crc32Mpeg } from "./crc.js";

const COMMANDS = {
  0x00: "splice_null",
  0x04: "splice_schedule",
  0x05: "splice_insert",
  0x06: "time_signal",
  0x07: "bandwidth_reservation",
  0xFF: "private_command",
};

const SEG_TYPES = {
  0x10: "program start",
  0x11: "program end",
  0x14: "program breakaway",
  0x15: "program resumption",
  0x20: "chapter start",
  0x21: "chapter end",
  0x22: "break start",
  0x23: "break end",
  0x30: "provider advertisement start",
  0x31: "provider advertisement end",
  0x34: "distributor advertisement start",
  0x35: "distributor advertisement end",
  0x40: "unscheduled event start",
  0x41: "unscheduled event end",
};

function reader(bytes, bitStart) {
  let bit = bitStart;
  return {
    read(n) {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byte = bytes[bit >> 3] || 0;
        v = v * 2 + ((byte >> (7 - (bit & 7))) & 1);
        bit += 1;
      }
      return v;
    },
    bytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = this.read(8);
      return out;
    },
  };
}

function readSpliceTime(bits) {
  const specified = bits.read(1);
  if (!specified) {
    bits.read(7);
    return null;
  }
  bits.read(6);
  return bits.read(33);
}

function readBreak(bits) {
  const autoReturn = bits.read(1) === 1;
  bits.read(6);
  return { autoReturn, duration: bits.read(33) };
}

function readCommand(bits, type) {
  const name = COMMANDS[type] || ("command_0x" + type.toString(16));
  if (type === 0x05) {
    const eventId = bits.read(32);
    const cancel = bits.read(1) === 1;
    bits.read(7);
    if (cancel) return { name, eventId, cancel };
    const outOfNetwork = bits.read(1) === 1;
    const programSplice = bits.read(1) === 1;
    const durationFlag = bits.read(1) === 1;
    const immediate = bits.read(1) === 1;
    bits.read(4);
    let pts = null;
    if (programSplice && !immediate) pts = readSpliceTime(bits);
    if (!programSplice) {
      const n = bits.read(8);
      for (let i = 0; i < n; i++) {
        bits.read(8);
        if (!immediate) readSpliceTime(bits);
      }
    }
    const brk = durationFlag ? readBreak(bits) : null;
    const uniqueProgramId = bits.read(16);
    const availNum = bits.read(8);
    const availsExpected = bits.read(8);
    return {
      name, eventId, cancel, outOfNetwork, immediate, pts, uniqueProgramId,
      availNum, availsExpected,
      breakAutoReturn: brk ? brk.autoReturn : null,
      breakDuration: brk ? brk.duration : null,
    };
  }
  if (type === 0x06) {
    return { name, pts: readSpliceTime(bits) };
  }
  return { name };
}

function segmentation(body) {
  const bits = reader(body, 0);
  const identifier = bits.read(32);
  const eventId = bits.read(32);
  const cancel = bits.read(1) === 1;
  bits.read(7);
  if (cancel) return { identifier, eventId, cancel };
  const program = bits.read(1) === 1;
  const durFlag = bits.read(1) === 1;
  const notRestricted = bits.read(1) === 1;
  bits.read(5);
  if (!program) {
    const n = bits.read(8);
    for (let i = 0; i < n; i++) {
      bits.read(8);
      bits.read(7);
      bits.read(33);
    }
  }
  const duration = durFlag ? bits.read(40) : null;
  const upidType = bits.read(8);
  const upidLen = bits.read(8);
  const upidBytes = bits.bytes(upidLen);
  let upid = "";
  for (let i = 0; i < upidBytes.length; i++) {
    const c = upidBytes[i];
    upid += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : "";
  }
  const typeId = bits.read(8);
  const segmentNum = bits.read(8);
  const segmentsExpected = bits.read(8);
  return {
    identifier, eventId, cancel, duration, upidType, upid, typeId,
    typeName: SEG_TYPES[typeId] || ("type 0x" + typeId.toString(16)),
    segmentNum, segmentsExpected, notRestricted,
  };
}

function parseDescriptors(bytes) {
  const out = [];
  let i = 0;
  while (i + 2 <= bytes.length) {
    const tag = bytes[i];
    const len = bytes[i + 1];
    if (i + 2 + len > bytes.length) break;
    const body = bytes.subarray(i + 2, i + 2 + len);
    if (tag === 0x02) out.push({ tag, segmentation: segmentation(body) });
    else out.push({ tag, length: len });
    i += 2 + len;
  }
  return out;
}

export function decodeScte35(section) {
  if (!section || section[0] !== 0xFC || section.length < 3) return null;
  const length = ((section[1] & 0x0F) << 8) | section[2];
  const total = 3 + length;
  if (section.length < total || length < 4) return null;
  const sec = section.subarray(0, total);
  if (crc32Mpeg(sec) !== 0) return { crcOk: false };
  const bits = reader(sec, 24);
  const protocol = bits.read(8);
  const encrypted = bits.read(1) === 1;
  bits.read(6);
  const ptsAdjustment = bits.read(33);
  bits.read(8);
  const tier = bits.read(12);
  const cmdLen = bits.read(12);
  const cmdType = bits.read(8);
  const command = readCommand(bits, cmdType);
  if (cmdLen !== 0xFFF) {
    // command reader consumed the command; length is a cross-check only
  }
  const descLen = bits.read(16);
  const descBytes = bits.bytes(descLen);
  return {
    crcOk: true,
    protocol,
    encrypted,
    ptsAdjustment,
    tier,
    commandLength: cmdLen,
    command,
    descriptors: parseDescriptors(descBytes),
  };
}

export function createScte() {
  const events = [];
  return {
    add(section, pid, packetIndex, t) {
      if (events.length >= 500) return;
      const decoded = decodeScte35(section);
      if (!decoded) return;
      // The section bytes travel with the event so a cross-check can hand the
      // exact same input to another parser and compare field by field.
      events.push({
        pid,
        packetIndex,
        t: t || 0,
        ...decoded,
        section: decoded.crcOk === false ? undefined : hexOf(section),
      });
    },
    events() {
      return events;
    },
  };
}

function hexOf(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return out;
}

export { COMMANDS, SEG_TYPES };
