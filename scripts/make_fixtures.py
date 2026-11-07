#!/usr/bin/env python3
"""Write the transport streams the inspector tests read."""

from __future__ import annotations

import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "test" / "fixtures"

PCR_BASE = 5_000_000_000
TICKS_10MS = 270_000


def crc32_mpeg(data: bytes) -> int:
    table = []
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = ((c << 1) ^ 0x04C11DB7) if (c & 0x80000000) else (c << 1)
            c &= 0xFFFFFFFF
        table.append(c)
    c = 0xFFFFFFFF
    for b in data:
        c = ((c << 8) & 0xFFFFFFFF) ^ table[((c >> 24) ^ b) & 0xFF]
    return c


def encode_pcr(pcr: int) -> bytes:
    mod = (1 << 33) * 300
    pcr %= mod
    base = pcr // 300
    ext = pcr % 300
    return bytes((
        (base >> 25) & 0xFF,
        (base >> 17) & 0xFF,
        (base >> 9) & 0xFF,
        (base >> 1) & 0xFF,
        ((base & 1) << 7) | ((ext >> 8) & 1),
        ext & 0xFF,
    ))


def ts_packet(pid, cc, *, pusi=False, tei=False, pcr=None, payload=b"", scrambling=0, discont=False):
    pkt = bytearray(188)
    pkt[0] = 0x47
    pkt[1] = (0x80 if tei else 0) | (0x40 if pusi else 0) | ((pid >> 8) & 0x1F)
    pkt[2] = pid & 0xFF
    has_adapt = pcr is not None or discont
    has_payload = len(payload) > 0 or not has_adapt
    if has_adapt and payload:
        afc = 3
    elif has_adapt:
        afc = 2
    else:
        afc = 1
    pkt[3] = ((scrambling & 3) << 6) | (afc << 4) | (cc & 0xF)
    off = 4
    if afc & 2:
        flags = (0x80 if discont else 0) | (0x10 if pcr is not None else 0)
        body = bytes([flags])
        if pcr is not None:
            body += encode_pcr(pcr)
        if afc == 2:
            body = body + bytes(183 - len(body))
        pkt[off] = len(body)
        off += 1
        pkt[off:off + len(body)] = body
        off += len(body)
    if payload:
        room = 188 - off
        chunk = payload[:room]
        pkt[off:off + len(chunk)] = chunk
    elif afc == 1:
        pass
    return bytes(pkt)


def psi_section(table_id, table_id_ext, body, version=1):
    syntax = bytes((
        (table_id_ext >> 8) & 0xFF,
        table_id_ext & 0xFF,
        0xC1 | ((version & 0x1F) << 1),
        0x00,
        0x00,
    ))
    length = len(syntax) + len(body) + 4
    raw = bytes((table_id, 0xB0 | ((length >> 8) & 0x0F), length & 0xFF)) + syntax + body
    c = crc32_mpeg(raw)
    sec = raw + c.to_bytes(4, "big")
    if crc32_mpeg(sec) != 0:
        raise SystemExit("crc roundtrip failed")
    return sec


def with_pointer(section: bytes) -> bytes:
    return bytes((0,)) + section


def pat_section(programs):
    body = bytearray()
    for program, pid in programs:
        body += bytes((
            (program >> 8) & 0xFF, program & 0xFF,
            0xE0 | ((pid >> 8) & 0x1F), pid & 0xFF,
        ))
    return psi_section(0x00, 0x0001, bytes(body))


def pmt_section(program, pcr_pid, streams, program_info=b""):
    body = bytearray((
        0xE0 | ((pcr_pid >> 8) & 0x1F), pcr_pid & 0xFF,
        0xF0 | ((len(program_info) >> 8) & 0x0F), len(program_info) & 0xFF,
    ))
    body += program_info
    for stype, pid, info in streams:
        body += bytes((
            stype,
            0xE0 | ((pid >> 8) & 0x1F), pid & 0xFF,
            0xF0 | ((len(info) >> 8) & 0x0F), len(info) & 0xFF,
        ))
        body += info
    return psi_section(0x02, program, bytes(body))


def service_descriptor(name, provider="Local"):
    nb, pb = name.encode(), provider.encode()
    body = bytes((0x01, len(pb))) + pb + bytes((len(nb),)) + nb
    return bytes((0x48, len(body))) + body


def sdt_section(tsid, onid, services):
    body = bytearray(((tsid >> 8) & 0xFF, tsid & 0xFF, 0xFF))
    # original_network_id is the table... SDT body starts with onid, not tsid.
    # table_id_ext is transport_stream_id. Body: onid (2), reserved (1), services.
    body = bytearray((((onid >> 8) & 0xFF), onid & 0xFF, 0xFF))
    for sid, name in services:
        desc = service_descriptor(name)
        body += bytes(((sid >> 8) & 0xFF, sid & 0xFF, 0xFC))
        word = (4 << 13) | len(desc)
        body += bytes(((word >> 8) & 0xFF, word & 0xFF))
        body += desc
    return psi_section(0x42, tsid, bytes(body))


def nit_section(network_id, name, transports):
    nb = name.encode()
    nd = bytes((0x40, len(nb))) + nb
    body = bytearray((0xF0 | ((len(nd) >> 8) & 0x0F), len(nd) & 0xFF))
    body += nd
    loop = bytearray()
    for tsid, onid in transports:
        loop += bytes((
            (tsid >> 8) & 0xFF, tsid & 0xFF,
            (onid >> 8) & 0xFF, onid & 0xFF,
            0xF0, 0x00,
        ))
    body += bytes((0xF0 | ((len(loop) >> 8) & 0x0F), len(loop) & 0xFF))
    body += loop
    return psi_section(0x40, network_id, bytes(body))


def short_event(name):
    nb = name.encode()
    body = b"eng" + bytes((len(nb),)) + nb + bytes((0,))
    return bytes((0x4D, len(body))) + body


def eit_section(service_id, tsid, onid, events):
    body = bytearray((
        (tsid >> 8) & 0xFF, tsid & 0xFF,
        (onid >> 8) & 0xFF, onid & 0xFF,
        0x4E, 0x4E,
    ))
    for event_id, name in events:
        desc = short_event(name)
        body += bytes(((event_id >> 8) & 0xFF, event_id & 0xFF))
        # 2024-06-01 12:00:00, duration 00:30:00. MJD 60462 is 2024-06-01.
        body += bytes((0xEC, 0x2E, 0x12, 0x00, 0x00))
        body += bytes((0x00, 0x30, 0x00))
        word = (4 << 13) | len(desc)
        body += bytes(((word >> 8) & 0xFF, word & 0xFF))
        body += desc
    return psi_section(0x4E, service_id, bytes(body))


class Bits:
    def __init__(self):
        self.v = []

    def w(self, value, n):
        for shift in range(n - 1, -1, -1):
            self.v.append((value >> shift) & 1)

    def ue(self, value):
        v = value + 1
        n = v.bit_length()
        if n > 1:
            self.w(0, n - 1)
        self.w(v, n)

    def trail(self):
        self.w(1, 1)
        while len(self.v) % 8:
            self.w(0, 1)

    def bytes(self):
        if len(self.v) % 8:
            raise SystemExit("bit writer not byte aligned (%d)" % len(self.v))
        out = bytearray()
        for i in range(0, len(self.v), 8):
            x = 0
            for bit in self.v[i:i + 8]:
                x = (x << 1) | bit
            out.append(x)
        return bytes(out)


def segmentation_descriptor(type_id=0x30, event_id=0x10):
    b = Bits()
    b.w(0x43554549, 32)
    b.w(event_id, 32)
    b.w(0, 1)
    b.w(0x7F, 7)
    b.w(1, 1)
    b.w(1, 1)
    b.w(1, 1)
    b.w(0x1F, 5)
    b.w(900000, 40)
    b.w(0x01, 8)
    b.w(3, 8)
    b.w(0x414431, 24)
    b.w(type_id, 8)
    b.w(1, 8)
    b.w(1, 8)
    body = b.bytes()
    return bytes((0x02, len(body))) + body


def scte_section(command_type, command, descriptors=b""):
    b = Bits()
    b.w(0, 8)
    b.w(0, 1)
    b.w(0, 6)
    b.w(0, 33)
    b.w(0, 8)
    b.w(0xFFF, 12)
    b.w(len(command), 12)
    b.w(command_type, 8)
    raw = b.bytes() + command
    raw += bytes(((len(descriptors) >> 8) & 0xFF, len(descriptors) & 0xFF)) + descriptors
    length = len(raw) + 4
    blob = bytes((0xFC, (length >> 8) & 0x0F, length & 0xFF)) + raw
    return blob + crc32_mpeg(blob).to_bytes(4, "big")


def cue_section(type_id, event_id=0x10):
    b = Bits()
    b.w(event_id, 32)
    b.w(0, 1)
    b.w(0x7F, 7)
    b.w(1, 1)
    b.w(1, 1)
    b.w(1, 1)
    b.w(0, 1)
    b.w(0xF, 4)
    b.w(1, 1)
    b.w(0x3F, 6)
    b.w(900000, 33)
    b.w(1, 1)
    b.w(0x3F, 6)
    b.w(2_700_000, 33)
    b.w(1, 16)
    b.w(1, 8)
    b.w(1, 8)
    cmd = b.bytes()
    return scte_section(0x05, cmd, segmentation_descriptor(type_id, event_id))


def build_cue_pair():
    b = Builder()
    out_section = cue_section(0x30, 0x20)
    in_section = cue_section(0x31, 0x21)
    for i in range(80):
        slot = i % 20
        if i == 20:
            b.add(0x01F4, with_pointer(out_section), pusi=True)
        elif i == 60:
            b.add(0x01F4, with_pointer(in_section), pusi=True)
        elif slot == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif slot == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("cue_pair.ts", b.pkts)


def splice_insert(event_id=0x12345678, pts=900000, duration=2_700_000):
    b = Bits()
    b.w(event_id, 32)
    b.w(0, 1)
    b.w(0x7F, 7)
    b.w(1, 1)
    b.w(1, 1)
    b.w(1, 1)
    b.w(0, 1)
    b.w(0xF, 4)
    b.w(1, 1)
    b.w(0x3F, 6)
    b.w(pts, 33)
    b.w(1, 1)
    b.w(0x3F, 6)
    b.w(duration, 33)
    b.w(1, 16)
    b.w(1, 8)
    b.w(1, 8)
    cmd = b.bytes()
    return scte_section(0x05, cmd, segmentation_descriptor())


def pes(stream_id, pts, payload=b"\x00\x11"):
    p = bytearray(5)
    p[0] = 0x20 | (((pts >> 29) & 0x0E)) | 0x01
    p[1] = (pts >> 22) & 0xFF
    p[2] = (((pts >> 15) & 0x7F) << 1) | 1
    p[3] = (pts >> 7) & 0xFF
    p[4] = ((pts & 0x7F) << 1) | 1
    rest = bytes((0x80, 0x80, 5)) + bytes(p) + payload
    return bytes((0, 0, 1, stream_id, (len(rest) >> 8) & 0xFF, len(rest) & 0xFF)) + rest


LANG = bytes((0x0A, 4, ord("e"), ord("n"), ord("g"), 0))

PAT = pat_section([(1, 0x100)])
PMT = pmt_section(1, 0x101, [
    (0x1B, 0x101, b""),
    (0x0F, 0x102, LANG),
    (0x86, 0x1F4, b""),
])
SDT = sdt_section(1, 0x1234, [(1, "Inspector")])
NIT = nit_section(0x2200, "TestNet", [(1, 0x1234)])
EIT = eit_section(1, 1, 0x1234, [(7, "News")])
SCTE = splice_insert()


class Builder:
    def __init__(self):
        self.cc = {}
        self.pkts = []
        self.extra = 0

    def pcr_value(self, index):
        return PCR_BASE + index * TICKS_10MS + self.extra

    def add(self, pid, payload, *, pusi=False, tei=False, pcr=True, consume_cc=True, scrambling=0, discont=False):
        cc = self.cc.get(pid, 0)
        if consume_cc and pid != 0x1FFF and not tei:
            self.cc[pid] = (cc + 1) & 0xF
        index = len(self.pkts)
        raw = None if not pcr or pid == 0x1FFF else self.pcr_value(index)
        self.pkts.append(ts_packet(
            pid, cc, pusi=pusi, tei=tei, pcr=raw, payload=payload, scrambling=scrambling,
            discont=discont,
        ))


def write(name, packets):
    path = OUT / name
    path.write_bytes(b"".join(packets))
    print("wrote %s (%d packets)" % (path.name, len(packets)))


def build_ok():
    b = Builder()
    for i in range(400):
        slot = i % 40
        if slot == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif slot == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        elif slot == 2:
            b.add(0x0011, with_pointer(SDT), pusi=True)
        elif slot == 3:
            b.add(0x0010, with_pointer(NIT), pusi=True)
        elif slot == 4:
            b.add(0x0012, with_pointer(EIT), pusi=True)
        elif slot == 5:
            b.add(0x01F4, with_pointer(SCTE), pusi=True)
        elif slot % 5 == 0:
            b.add(0x0102, pes(0xC0, i * 900 + 9000), pusi=True)
        elif slot % 7 == 0:
            b.add(0x1FFF, b"", pcr=False)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("ok.ts", b.pkts)


def build_cc_gap():
    b = Builder()
    seen_video = 0
    for i in range(80):
        if i % 10 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 10 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        else:
            seen_video += 1
            if seen_video == 8:
                b.cc[0x101] = (b.cc.get(0x101, 0) + 1) & 0xF
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("cc_gap.ts", b.pkts)


def build_pat_gap():
    b = Builder()
    for i in range(150):
        if i == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 15 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        elif i % 2 == 0:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
        else:
            b.add(0x0102, pes(0xC0, i * 900 + 9000), pusi=True)
    write("pat_gap.ts", b.pkts)


def build_pcr_gap():
    b = Builder()
    for i in range(250):
        if i == 80:
            b.extra += 40 * 27_000
        if i == 160:
            b.extra += 140 * 27_000
        if i % 12 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 12 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("pcr_gap.ts", b.pkts)


def build_tei():
    b = Builder()
    for i in range(40):
        if i % 8 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 8 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        elif i == 22:
            b.add(0x0101, pes(0xE0, i * 900), pusi=True, tei=True)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("tei.ts", b.pkts)


def build_crc():
    b = Builder()
    bad = bytearray(with_pointer(PAT))
    bad[5] ^= 0xFF
    for i in range(60):
        if i == 20:
            b.add(0x0000, bytes(bad), pusi=True)
        elif i % 10 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 10 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("crc.ts", b.pkts)


def build_pts_gap():
    b = Builder()
    for i in range(130):
        if i % 20 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 20 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        elif i == 6:
            b.add(0x0101, pes(0xE0, 9000), pusi=True)
        else:
            b.add(0x0101, b"\x00\x01", pusi=False)
    write("pts_gap.ts", b.pkts)


def build_pid_silence():
    b = Builder()
    for i in range(630):
        if i % 20 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 20 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        elif i == 6:
            b.add(0x0101, pes(0xE0, 9000), pusi=True)
        else:
            b.add(0x0102, pes(0xC0, i * 900 + 9000), pusi=True)
    write("pid_silence.ts", b.pkts)


def build_pcr_wrap():
    b = Builder()
    mod = (1 << 33) * 300
    # 10 ms before the rollover, then 10 ms after it, then two more steps.
    values = [mod - TICKS_10MS, TICKS_10MS, TICKS_10MS * 2, TICKS_10MS * 3]
    for i, raw in enumerate(values):
        payload = with_pointer(PAT) if i == 0 else pes(0xE0, 9000)
        pid = 0x0000 if i == 0 else 0x0101
        cc = b.cc.get(pid, 0)
        b.cc[pid] = (cc + 1) & 0xF
        b.pkts.append(ts_packet(pid, cc, pusi=True, pcr=raw, payload=payload))
    write("pcr_wrap.ts", b.pkts)


def pes_dts(stream_id, pts, dts, payload):
    def stamp(value, marker):
        p = bytearray(5)
        p[0] = marker | ((value >> 29) & 0x0E) | 0x01
        p[1] = (value >> 22) & 0xFF
        p[2] = (((value >> 15) & 0x7F) << 1) | 1
        p[3] = (value >> 7) & 0xFF
        p[4] = ((value & 0x7F) << 1) | 1
        return bytes(p)
    rest = bytes((0x80, 0xC0, 10)) + stamp(pts, 0x30) + stamp(dts, 0x10) + payload
    return bytes((0, 0, 1, stream_id, (len(rest) >> 8) & 0xFF, len(rest) & 0xFF)) + rest


def epb(data: bytes) -> bytes:
    out = bytearray()
    zeros = 0
    for b in data:
        if zeros >= 2 and b <= 3:
            out.append(3)
            zeros = 0
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
    return bytes(out)


def nal_unit(nal_type, rbsp, ref=3):
    return b"\x00\x00\x00\x01" + bytes((((ref & 3) << 5) | (nal_type & 0x1F),)) + epb(rbsp)


def hrd_rbsp(b, bitrate=400_000, cpb=200_000, cbr=1, length=16):
    b.ue(0)
    b.w(0, 4)
    b.w(0, 4)
    b.ue((bitrate >> 6) - 1)
    b.ue((cpb >> 4) - 1)
    b.w(cbr, 1)
    b.w(length - 1, 5)
    b.w(length - 1, 5)
    b.w(length - 1, 5)
    b.w(0, 5)


def sps_rbsp(profile=77, level=10, bitrate=400_000, cpb=200_000, low_delay=0):
    b = Bits()
    b.w(profile, 8)
    b.w(0, 8)
    b.w(level, 8)
    b.ue(0)
    if profile == 100:
        b.ue(1)
        b.ue(0)
        b.ue(0)
        b.w(0, 1)
        b.w(1, 1)
        for i in range(8):
            b.w(1 if i == 0 else 0, 1)
            if i == 0:
                for _ in range(16):
                    b.ue(0)
    b.ue(0)
    b.ue(2)
    b.ue(1)
    b.w(0, 1)
    b.ue(19)
    b.ue(14)
    b.w(1, 1)
    b.w(1, 1)
    b.w(0, 1)
    b.w(1, 1)
    b.w(0, 1)
    b.w(0, 1)
    b.w(0, 1)
    b.w(0, 1)
    b.w(1, 1)
    b.w(1000, 32)
    b.w(25000, 32)
    b.w(1, 1)
    b.w(1, 1)
    hrd_rbsp(b, bitrate, cpb)
    b.w(0, 1)
    b.w(low_delay, 1)
    b.w(0, 1)
    b.w(0, 1)
    b.trail()
    return b.bytes()


def pps_rbsp():
    b = Bits()
    b.ue(0)
    b.ue(0)
    b.trail()
    return b.bytes()


def aud_rbsp(pic):
    b = Bits()
    b.w(pic & 7, 3)
    b.trail()
    return b.bytes()


def sei_rbsp(messages):
    out = bytearray()
    for typ, payload in messages:
        while typ >= 255:
            out.append(255)
            typ -= 255
        out.append(typ)
        n = len(payload)
        while n >= 255:
            out.append(255)
            n -= 255
        out.append(n)
        out += payload
    out.append(0x80)
    return bytes(out)


def bp_payload(delay, offset=0, length=16):
    b = Bits()
    b.ue(0)
    b.w(delay, length)
    b.w(offset, length)
    b.trail()
    return b.bytes()


def pt_payload(crb, dpb=0, length=16):
    b = Bits()
    b.w(crb, length)
    b.w(dpb, length)
    b.trail()
    return b.bytes()


def slice_rbsp(slice_type, idr, frame_num):
    b = Bits()
    b.ue(0)
    b.ue(slice_type)
    b.ue(0)
    b.w(frame_num & 0xF, 4)
    if idr:
        b.ue(0)
    b.trail()
    return b.bytes()


def access_unit(delay, crb, *, idr=False, slice_type=2, sps=True, filler=0, profile=77, level=10, bitrate=400_000, cpb=200_000):
    parts = [nal_unit(9, aud_rbsp(0 if slice_type in (2, 7) else 1), ref=0)]
    if sps:
        parts.append(nal_unit(7, sps_rbsp(profile, level, bitrate, cpb), ref=3))
    parts.append(nal_unit(8, pps_rbsp(), ref=3))
    messages = []
    if delay is not None:
        messages.append((0, bp_payload(delay)))
    messages.append((1, pt_payload(crb)))
    parts.append(nal_unit(6, sei_rbsp(messages), ref=0))
    parts.append(nal_unit(5 if idr else 1, slice_rbsp(slice_type, idr, crb), ref=3 if idr else 1))
    if filler:
        parts.append(nal_unit(12, b"\xff" * filler, ref=0))
    return b"".join(parts)


def video_packet(b, payload, *, pusi, discont=False):
    pid = 0x101
    cc = b.cc.get(pid, 0)
    b.cc[pid] = (cc + 1) & 0xF
    index = len(b.pkts)
    pcr = b.pcr_value(index)
    flags = 0x10 | (0x80 if discont else 0)
    body = bytes([flags]) + encode_pcr(pcr)
    room = 188 - 4 - 1 - len(body)
    if len(payload) > room:
        raise SystemExit("video payload %d does not fit in %d" % (len(payload), room))
    body += bytes(room - len(payload))
    pkt = bytearray(188)
    pkt[0] = 0x47
    pkt[1] = (0x40 if pusi else 0) | ((pid >> 8) & 0x1F)
    pkt[2] = pid & 0xFF
    pkt[3] = 0x30 | (cc & 0xF)
    pkt[4] = len(body)
    pkt[5:5 + len(body)] = body
    off = 5 + len(body)
    pkt[off:off + len(payload)] = payload
    b.pkts.append(bytes(pkt))


def emit_video(b, es, pts, dts, discont=False):
    blob = pes_dts(0xE0, pts & ((1 << 33) - 1), dts & ((1 << 33) - 1), es)
    pos = 0
    first = True
    while pos < len(blob):
        room = 176
        video_packet(b, blob[pos:pos + room], pusi=first, discont=discont and first)
        first = False
        pos += room


def psi_tick(b, pmt):
    last = b.last_psi if hasattr(b, "last_psi") else -1000
    if len(b.pkts) - last < 30:
        return
    b.add(0x0000, with_pointer(PAT), pusi=True)
    b.add(0x0100, with_pointer(pmt), pusi=True)
    b.last_psi = len(b.pkts)


def clock90(index, lead_ms=0):
    return (PCR_BASE // 300) + index * (TICKS_10MS // 300) + int(round(lead_ms * 90))


def implied_bp(sizes, delay0, rate, tc):
    tr = 0.0
    tai = tr - delay0 / 90000.0
    taf = tai + sizes[0] * 8 / rate
    t_af = taf
    for i in range(1, len(sizes) - 1):
        tr = i * tc
        tai = t_af
        taf = tai + sizes[i] * 8 / rate
        t_af = taf
    tr = (len(sizes) - 1) * tc
    return int(round(90000.0 * (tr - t_af)))


PMT_LEAK = pmt_section(1, 0x101, [(0x1B, 0x101, b"")])
PMT_HRD = pmt_section(1, 0x101, [(0x1B, 0x101, bytes((0x2A, 2, 0xFE, 0x1F)))])


def build_hrd_ok():
    rate = 400_000
    cpb = 800_000
    delay0 = 36000
    rough = [access_unit(delay0 if i in (0, 4) else None, i, idr=(i == 0), slice_type=2 if i == 0 else 0, sps=(i == 0), filler=400, cpb=cpb) for i in range(5)]
    delay4 = implied_bp([len(x) for x in rough], delay0, rate, 0.04)
    frames = [access_unit(delay0 if i == 0 else delay4 if i == 4 else None, i, idr=(i == 0), slice_type=2 if i == 0 else 0, sps=(i == 0), filler=400, cpb=cpb) for i in range(5)]
    b = Builder()
    t0 = None
    for i, es in enumerate(frames):
        psi_tick(b, PMT_LEAK)
        if t0 is None:
            t0 = clock90(len(b.pkts), 400)
        emit_video(b, es, t0 + i * 3600, t0 + i * 3600)
    write("hrd_ok.ts", b.pkts)


def build_hrd_join():
    b = Builder()
    t0 = None
    for i in range(3):
        es = access_unit(36000 if i == 0 else None, i, idr=(i == 0), slice_type=2 if i == 0 else 0, sps=(i == 0), filler=300)
        psi_tick(b, PMT_LEAK)
        if t0 is None:
            t0 = clock90(len(b.pkts), 400)
        emit_video(b, es, t0 + i * 3600, t0 + i * 3600)
    es = access_unit(45000, 0, idr=True, slice_type=2, sps=True, filler=300)
    psi_tick(b, PMT_LEAK)
    emit_video(b, es, t0 + 3 * 3600, t0 + 3 * 3600, discont=True)
    write("hrd_join.ts", b.pkts)


def build_tstd_eb_underflow():
    b = Builder()
    es = access_unit(36000, 0, idr=True, slice_type=2, sps=True, filler=800)
    psi_tick(b, PMT_LEAK)
    dts = clock90(len(b.pkts), 0)
    emit_video(b, es, dts, dts)
    write("tstd_eb_underflow.ts", b.pkts)


def build_tstd_eb_overflow():
    b = Builder()
    es = access_unit(20000, 0, idr=True, slice_type=2, sps=True, filler=3500, cpb=8000)
    psi_tick(b, PMT_HRD)
    dts = clock90(len(b.pkts), 1000)
    emit_video(b, es, dts, dts)
    write("tstd_eb_overflow.ts", b.pkts)


def build_pcr_ac():
    b = Builder()
    for i in range(80):
        if i == 40:
            b.extra += 40
        if i % 10 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 10 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
        if i == 40:
            b.extra -= 40
    write("pcr_ac.ts", b.pkts)


def build_p3_gaps():
    b = Builder()
    for i in range(1200):
        if i % 20 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 20 == 1:
            b.add(0x0100, with_pointer(PMT), pusi=True)
        elif i % 5 == 0:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
        else:
            b.add(0x0200, b"\x00\x01", pusi=False)
    write("p3_gaps.ts", b.pkts)


def tdt_section():
    # 2024-06-01 12:00:00, same MJD as the EIT fixture.
    return bytes((0x70, 0x70, 0x05, 0xEC, 0x2E, 0x12, 0x00, 0x00))


def lcn_descriptor():
    body = bytes((0x00, 0x01, 0x80, 0x07))
    return bytes((0x83, len(body))) + body


def build_si_full():
    name = bytes((0x43, 0x61, 0x66, 0xC2, 0x65))
    desc = bytes((0x4D, 3 + 1 + len(name) + 1)) + b"eng" + bytes((len(name),)) + name + bytes((0,))
    body = bytearray((0x00, 0x01, 0x12, 0x34, 0x4E, 0x4E))
    body += bytes((0x00, 0x08))
    body += bytes((0xEC, 0x2E, 0x12, 0x00, 0x00, 0x00, 0x30, 0x00))
    word = (4 << 13) | len(desc)
    body += bytes(((word >> 8) & 0xFF, word & 0xFF)) + desc
    eit = psi_section(0x4E, 1, bytes(body))
    nit = nit_section(0x2200, "TestNet", [(1, 0x1234)])
    # Rebuild NIT with an LCN descriptor in the network loop.
    nb = b"TestNet"
    nd = bytes((0x40, len(nb))) + nb + lcn_descriptor()
    nbody = bytearray((0xF0 | ((len(nd) >> 8) & 0x0F), len(nd) & 0xFF)) + nd
    nbody += bytes((0xF0, 0x06, 0x00, 0x01, 0x12, 0x34, 0xF0, 0x00))
    nit = psi_section(0x40, 0x2200, bytes(nbody))
    avc = bytes((0x28, 4, 77, 0x40, 10, 0x1F))
    timing = bytes((0x2A, 2, 0x7E, 0x1F))
    pmt = pmt_section(1, 0x101, [
        (0x1B, 0x101, avc + timing),
        (0x06, 0x103, bytes((0x56, 5, ord("e"), ord("n"), ord("g"), 0x09, 0x00))),
        (0x06, 0x104, bytes((0x59, 8, ord("e"), ord("n"), ord("g"), 0x10, 0x00, 0x01, 0x00, 0x01))),
    ])
    b = Builder()
    for i in range(40):
        slot = i % 8
        if slot == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif slot == 1:
            b.add(0x0100, with_pointer(pmt), pusi=True)
        elif slot == 2:
            b.add(0x0011, with_pointer(SDT), pusi=True)
        elif slot == 3:
            b.add(0x0010, with_pointer(nit), pusi=True)
        elif slot == 4:
            b.add(0x0012, with_pointer(eit), pusi=True)
        elif slot == 5:
            b.add(0x0014, with_pointer(tdt_section()), pusi=True)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("si_full.ts", b.pkts)


def ham84(nibble):
    table = [0x15, 0x02, 0x49, 0x5E, 0x64, 0x73, 0x38, 0x2F,
             0xD0, 0xC7, 0x8C, 0x9B, 0xA1, 0xB6, 0xFD, 0xEA]
    return table[nibble & 0xF]


def odd_parity(ch):
    v = ord(ch) & 0x7F
    if bin(v).count("1") % 2 == 0:
        v |= 0x80
    return v


def teletext_address(magazine, packet):
    mag = 0 if magazine == 8 else magazine
    n0 = packet & 0xF
    n1 = ((packet >> 4) & 1) | ((mag & 7) << 1)
    return bytes((ham84(n0), ham84(n1)))


def teletext_unit(magazine, packet, data40):
    line = bytes((0xC2, 0xE4)) + teletext_address(magazine, packet) + data40
    return bytes((0x02, len(line))) + line


def build_teletext():
    header = bytes((ham84(0), ham84(0))) + bytes(6) + bytes(odd_parity(c) for c in ("P100".ljust(32)))
    row = bytes(odd_parity(c) for c in ("HELLO".ljust(40)))
    payload = bytes((0x10,)) + teletext_unit(1, 0, header) + teletext_unit(1, 1, row)
    b = Builder()
    pmt = pmt_section(1, 0x101, [
        (0x1B, 0x101, b""),
        (0x06, 0x103, bytes((0x56, 5, ord("e"), ord("n"), ord("g"), 0x09, 0x00))),
    ])
    for i in range(30):
        if i % 10 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 10 == 1:
            b.add(0x0100, with_pointer(pmt), pusi=True)
        elif i == 4:
            b.add(0x0103, pes(0xBD, 90000, payload), pusi=True)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("teletext.ts", b.pkts)


def build_dvbsub():
    # 8x8 region, one 2-bit object of colour 1, CLUT entry 1 opaque white.
    pixels = bytearray()
    # data_type 0x10, eight pixels of colour 1 (code 01), end 00 00 00, byte align.
    # 01 repeated 8 times = 16 bits, then 000000 end, then 2 stuff bits to align? 
    # 16 + 6 = 22, need 2 more bits to 24. read2 aligns by consuming to a byte.
    row = bytes((0x10, 0x55, 0x55, 0x00))
    # 0x55 is 01010101 = four colour-1 pixels. Two bytes = 8 pixels. Then 0x00 ends.
    top = b"".join([row] * 8)
    obj = bytes((0x00, 0x01, 0x00, (len(top) >> 8) & 0xFF, len(top) & 0xFF, 0x00, 0x00)) + top
    region = bytes((
        0x00, 0x00, 0x00, 0x08, 0x00, 0x08, 0x00, 0x01, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    ))
    page = bytes((0x01, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00))
    clut = bytes((0x01, 0x00, 0x01, 0xF0, 0xFF, 0x80, 0x80, 0x00))
    def seg(kind, body):
        return bytes((0x0F, kind, 0x00, 0x01, (len(body) >> 8) & 0xFF, len(body) & 0xFF)) + body
    payload = bytes((0x20, 0x00)) + seg(0x10, page) + seg(0x11, region) + seg(0x12, clut) + seg(0x13, obj) + seg(0x80, b"") + bytes((0xFF,))
    b = Builder()
    pmt = pmt_section(1, 0x101, [
        (0x1B, 0x101, b""),
        (0x06, 0x104, bytes((0x59, 8, ord("e"), ord("n"), ord("g"), 0x10, 0x00, 0x01, 0x00, 0x01))),
    ])
    for i in range(30):
        if i % 10 == 0:
            b.add(0x0000, with_pointer(PAT), pusi=True)
        elif i % 10 == 1:
            b.add(0x0100, with_pointer(pmt), pusi=True)
        elif i == 4:
            b.add(0x0104, pes(0xBD, 90000, payload), pusi=True)
        else:
            b.add(0x0101, pes(0xE0, i * 900 + 9000), pusi=True)
    write("dvbsub.ts", b.pkts)


def build_video_fc_noise():
    # PID 100 is the PCR PID with an H.264 stream. The PES payload is chosen so
    # bytes that look like a splice_info_section appear in slice data. The PMT
    # names PID 100 as video only, so none of it may reach the SCTE list.
    b = Builder()
    pmt = pmt_section(1, 0x100, [(0x1B, 0x100, b"")])
    noise = bytes.fromhex("fc0004ff") + b"\x00\x55" * 60
    for i in range(60):
        if i % 10 == 0:
            b.add(0x0000, with_pointer(pat_section([(1, 0x81)])), pusi=True)
        elif i % 10 == 1:
            b.add(0x0081, with_pointer(pmt), pusi=True)
        elif i % 10 == 2:
            # PES start code 00 00 01 E0 followed by slice-like bytes.
            b.add(0x0064, b"\x00\x00\x01\xe0\x00\x10\x80\x00\x00" + noise, pusi=True, pcr=True)
        else:
            b.add(0x0064, b"\x00\x00\x01\xe0" + noise, pusi=False, pcr=True)
    write("video_fc_noise.ts", b.pkts)


def cc_data_pair(byte1, byte2, cc_type=0):
    # cc_data() from CEA-708 section 4: marker bits 0xF8, cc_valid, cc_type,
    # then the two 608 bytes. One 3-byte pair per call.
    return bytes((0xFC | (cc_type & 0x03), byte1, byte2))


def cc_padding(count):
    # Real encoders pad the block out to 20 pairs with cc_valid clear and
    # cc_type 2, which decoders skip. The padding is what keeps the caption
    # clock running between words, so it is reproduced here.
    return [b"\xFA\x00\x00"] * count


def cc_sei_payload(pairs, cc_count=20):
    # ATSC A/53 user data: country 0xB5, provider 0x0031, identifier GA94,
    # type 3 (cc_data), a flags byte and the count, then the pairs. A None
    # entry becomes a padding pair with cc_valid clear, which decoders skip.
    body = bytearray(b"\xB5\x00\x31GA94\x03")
    body.append(0xC0 | min(len(pairs), cc_count))  # process_cc_data_flag, cc_count
    body.append(0xFF)  # em_data
    for index in range(cc_count):
        pair = pairs[index] if index < len(pairs) else None
        body += cc_data_pair(pair[0], pair[1]) if pair else b"\xFA\x00\x00"
    # A trailing 0xFF marker closes the cc_data block; decoders look for it.
    body.append(0xFF)
    return bytes(body)


def cc608_text(text):
    # The 608 basic character set is ASCII for the letters and digits used
    # here: a preamble address code, resume caption loading, the letters, then
    # EOC, which is what puts the caption on screen.
    pairs = [(0x94, 0x2C)]  # PAC, row 14, white
    pairs.append((0x14, 0x20))  # RCL, resume caption loading
    for ch in text:
        pairs.append((odd_parity(ch), 0x80))
    pairs.append((0x14, 0x2F))  # EOC
    return pairs


def build_cc608():
    # The caption text is carried in GA94 SEI messages, and every frame also
    # carries the null pair 0x80 0x80 that keeps a 608 caption's clock moving.
    # This fixture exists to prove the SEI detection in the inspector: the words
    # arrive one frame apart, with an EOC and a later erase.
    b = Builder()
    pmt = pmt_section(1, 0x101, [(0x1B, 0x101, b"")])
    script = [None] * 10 + cc608_text("TS INSPECTOR") + [None] * 20 + [(0x14, 0x2C)]
    base = clock90(0, 400)
    for i in range(len(script) + 20):
        psi_tick(b, pmt)
        t = base + i * 3600
        pairs = [(0x80, 0x80)]
        if i < len(script) and script[i]:
            pairs.insert(0, script[i])
        payload = cc_sei_payload(pairs)
        messages = [(1, pt_payload(0)), (4, payload)]
        idr = i % 40 == 0
        parts = [nal_unit(9, aud_rbsp(0 if idr else 1), ref=0)]
        if i == 0:
            parts.append(nal_unit(7, sps_rbsp(), ref=3))
        parts.append(nal_unit(8, pps_rbsp(), ref=3))
        parts.append(nal_unit(6, sei_rbsp(messages), ref=0))
        parts.append(nal_unit(5 if idr else 1, slice_rbsp(2 if idr else 0, idr, i), ref=3))
        emit_video(b, b"".join(parts), t, t)
    write("cc608.ts", b.pkts)


def main():
    global OUT
    # --out DIR writes somewhere else, so a test can regenerate the streams
    # without rewriting test/fixtures while other tests read it.
    if len(sys.argv) == 3 and sys.argv[1] == "--out":
        OUT = Path(sys.argv[2]).resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    build_ok()
    build_cc_gap()
    build_pat_gap()
    build_pcr_gap()
    build_tei()
    build_crc()
    build_pts_gap()
    build_pid_silence()
    build_pcr_wrap()
    build_hrd_ok()
    build_hrd_join()
    build_tstd_eb_underflow()
    build_tstd_eb_overflow()
    build_pcr_ac()
    build_p3_gaps()
    build_si_full()
    build_teletext()
    build_dvbsub()
    build_cue_pair()
    build_cc608()
    build_video_fc_noise()


if __name__ == "__main__":
    main()
