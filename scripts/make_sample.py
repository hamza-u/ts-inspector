#!/usr/bin/env python3
"""Make the demo stream behind the page's "Try the sample" button.

The source is Big Buck Bunny, (c) copyright 2008, Blender Foundation,
www.bigbuckbunny.org, licensed under Creative Commons Attribution 3.0. The
script downloads the official 640x360 release from download.blender.org,
checks its SHA-256, cuts ten seconds, and encodes them with FFmpeg into a
constant-rate transport stream: H.264 with NAL HRD signalling, AAC audio, and
an SDT that names the service.

FFmpeg writes no NIT, EIT, TDT, or SCTE-35, so the script adds them. The PMT
gains a SCTE-35 PID and a CUEI registration descriptor. NIT, EIT
present/following, TDT, and two time_signal sections (a provider
advertisement start and its end) take the place of null packets. The mux rate
and every timestamp stay as FFmpeg wrote them.

Usage:
    python3 scripts/make_sample.py              # writes samples/big-buck-bunny.ts
    python3 scripts/make_sample.py --source BigBuckBunny_640x360.m4v

Needs ffmpeg with libx264 on PATH. The download (116 MB) is cached in
vendor/src/bbb/, which git ignores.
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from make_fixtures import Bits, crc32_mpeg, scte_section  # noqa: E402

URL = "https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_640x360.m4v.zip"
SHA256 = "7118242b6728d40c871479c5b3c0f0fb27d748089df15d7f1b469f297c74a2d6"
MEMBER = "BigBuckBunny_640x360.m4v"
CACHE = ROOT / "vendor" / "src" / "bbb"
OUT = ROOT / "samples" / "big-buck-bunny.ts"

START_S = 88          # the bunny in the meadow
DURATION_S = 10
MUXRATE = 520_000
MAXRATE = 450_000
PMT_PID = 0x1000
VIDEO_PID = 0x0100
SCTE_PID = 0x01F4
NIT_PID = 0x0010
EIT_PID = 0x0012
TDT_PID = 0x0014
TSID = 1
ONID = 0xFF01
SERVICE_ID = 1
# The film's release date, so that the stream is the same on every run.
MJD = 54616           # 2008-05-30
START_BCD = (0x12, 0x00, 0x00)
CUE_OUT_S = 3.0       # splice times, from the first video PTS
CUE_IN_S = 7.0
PREROLL_S = 2.0       # each cue is sent this long before its splice time


def fetch_source() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / "BigBuckBunny_640x360.m4v.zip"
    if not archive.is_file():
        print("download", URL)
        urllib.request.urlretrieve(URL, archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != SHA256:
        raise SystemExit("unexpected SHA-256 for %s: %s" % (archive, digest))
    movie = CACHE / MEMBER
    if not movie.is_file():
        with zipfile.ZipFile(archive) as zf:
            zf.extract(MEMBER, CACHE)
    return movie


def encode(source: Path, dest: Path) -> None:
    cmd = [
        "ffmpeg", "-v", "error", "-y",
        "-ss", str(START_S), "-t", str(DURATION_S), "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0",
        "-vf", "scale=320:180,fps=25",
        "-c:v", "libx264", "-preset", "slow", "-profile:v", "main", "-level", "3.0",
        # The HRD rate sets the T-STD transport-buffer drain, Rx = 1.2 x
        # MAXRATE, which must stay above the mux rate or FFmpeg's bursts
        # overflow TB. The gap between MUXRATE and the real rate leaves null
        # packets for the tables added below.
        "-b:v", "240k", "-maxrate", str(MAXRATE), "-bufsize", str(MAXRATE),
        "-x264-params", "nal-hrd=vbr:force-cfr=1:keyint=50:min-keyint=50:scenecut=0",
        "-bf", "2", "-threads", "1",
        "-c:a", "aac", "-b:a", "64k", "-ar", "48000", "-ac", "2",
        "-f", "mpegts", "-muxrate", str(MUXRATE), "-pcr_period", "30",
        "-muxdelay", "1.0", "-muxpreload", "1.0",
        "-mpegts_transport_stream_id", str(TSID), "-mpegts_original_network_id", str(ONID),
        "-mpegts_service_id", str(SERVICE_ID), "-mpegts_pmt_start_pid", str(PMT_PID),
        "-mpegts_start_pid", str(VIDEO_PID),
        "-metadata", "service_provider=Blender Foundation",
        "-metadata", "service_name=Big Buck Bunny",
        "-fflags", "+bitexact", "-flags", "+bitexact",
        str(dest),
    ]
    subprocess.run(cmd, check=True)


def splice_time(pts: int) -> bytes:
    b = Bits()
    b.w(1, 1)            # time_specified_flag
    b.w(0x3F, 6)
    b.w(pts & 0x1FFFFFFFF, 33)
    return b.bytes()


def segmentation_descriptor(event_id: int, type_id: int, duration: int | None) -> bytes:
    b = Bits()
    b.w(0x43554549, 32)  # "CUEI"
    b.w(event_id, 32)
    b.w(0, 1)            # segmentation_event_cancel_indicator
    b.w(0x7F, 7)
    b.w(1, 1)            # program_segmentation_flag
    b.w(1 if duration is not None else 0, 1)
    b.w(1, 1)            # delivery_not_restricted_flag
    b.w(0x1F, 5)
    if duration is not None:
        b.w(duration, 40)
    b.w(0x0C, 8)         # segmentation_upid_type: MPU
    upid = b"\x42\x42\x42\x31" + b"demo"  # format identifier "BBB1", then data
    b.w(len(upid), 8)
    body = b.bytes() + upid
    body += bytes((type_id, 1, 1))  # segmentation_type_id, segment_num, segments_expected
    return bytes((0x02, len(body))) + body


def cue(event_id: int, type_id: int, pts: int, duration: int | None) -> bytes:
    return scte_section(0x06, splice_time(pts), segmentation_descriptor(event_id, type_id, duration))


def read_pts(payload: bytes) -> int | None:
    if payload[:3] != b"\x00\x00\x01" or not payload[7] & 0x80:
        return None
    p = payload[9:14]
    return (((p[0] >> 1) & 0x07) << 30) | (p[1] << 22) | ((p[2] >> 1) << 15) | (p[3] << 7) | (p[4] >> 1)


def payload_of(pkt: bytes) -> bytes:
    afc = (pkt[3] >> 4) & 3
    if not afc & 1:
        return b""
    off = 4 + (1 + pkt[4] if afc & 2 else 0)
    return pkt[off:]


def pcr_of(pkt: bytes) -> int | None:
    if not (pkt[3] >> 4) & 2 or pkt[4] == 0 or not pkt[5] & 0x10:
        return None
    b = pkt[6:12]
    base = (b[0] << 25) | (b[1] << 17) | (b[2] << 9) | (b[3] << 1) | (b[4] >> 7)
    return base * 300 + (((b[4] & 1) << 8) | b[5])


def rewrite_pmt(pkt: bytes) -> bytes:
    pointer = payload_of(pkt)[0]
    sec = payload_of(pkt)[1 + pointer:]
    length = ((sec[1] & 0x0F) << 8) | sec[2]
    sec = sec[:3 + length]
    if crc32_mpeg(sec) != 0:
        raise SystemExit("PMT CRC check failed")
    program = (sec[3] << 8) | sec[4]
    version_byte = sec[5]
    pcr_pid = ((sec[8] & 0x1F) << 8) | sec[9]
    info_len = ((sec[10] & 0x0F) << 8) | sec[11]
    info = sec[12:12 + info_len] + b"\x05\x04CUEI"
    streams = sec[12 + info_len:-4] + bytes((0x86, 0xE0 | (SCTE_PID >> 8), SCTE_PID & 0xFF, 0xF0, 0x00))
    body = bytes((program >> 8, program & 0xFF, version_byte, 0, 0,
                  0xE0 | (pcr_pid >> 8), pcr_pid & 0xFF,
                  0xF0 | (len(info) >> 8), len(info) & 0xFF)) + info + streams
    head = bytes((0x02, 0xB0 | ((len(body) + 4) >> 8), (len(body) + 4) & 0xFF))
    new = head + body
    new += crc32_mpeg(new).to_bytes(4, "big")
    payload = b"\x00" + new
    if len(payload) > 184:
        raise SystemExit("PMT no longer fits one packet")
    return pkt[:4] + payload + b"\xFF" * (184 - len(payload))


def long_section(table_id, ext, body, section=0, last=0, version=0):
    head = bytes((ext >> 8, ext & 0xFF, 0xC1 | (version << 1), section, last))
    length = len(head) + len(body) + 4
    raw = bytes((table_id, 0xF0 | (length >> 8), length & 0xFF)) + head + body
    return raw + crc32_mpeg(raw).to_bytes(4, "big")


def nit() -> bytes:
    name = b"TS Inspector demo"
    net = bytes((0x40, len(name))) + name
    service_list = bytes((0x41, 3, SERVICE_ID >> 8, SERVICE_ID & 0xFF, 0x01))
    ts_loop = bytes((TSID >> 8, TSID & 0xFF, ONID >> 8, ONID & 0xFF,
                     0xF0, len(service_list))) + service_list
    body = (bytes((0xF0 | (len(net) >> 8), len(net) & 0xFF)) + net
            + bytes((0xF0 | (len(ts_loop) >> 8), len(ts_loop) & 0xFF)) + ts_loop)
    return long_section(0x40, ONID, body)


def eit(section: int) -> bytes:
    events = b""
    if section == 0:
        name = b"Big Buck Bunny"
        text = b"Excerpt. (c) 2008 Blender Foundation, CC BY 3.0."
        short = b"eng" + bytes((len(name),)) + name + bytes((len(text),)) + text
        desc = bytes((0x4D, len(short))) + short
        events = (bytes((0x00, 0x01, MJD >> 8, MJD & 0xFF)) + bytes(START_BCD)
                  + bytes((0x00, 0x00, 0x10))           # duration 00:00:10
                  + bytes((0x80 | (len(desc) >> 8), len(desc) & 0xFF))  # running
                  + desc)
    body = bytes((TSID >> 8, TSID & 0xFF, ONID >> 8, ONID & 0xFF, 0x01, 0x4E)) + events
    return long_section(0x4E, SERVICE_ID, body, section=section, last=1)


def tdt(seconds: int) -> bytes:
    utc = bytes((MJD >> 8, MJD & 0xFF, START_BCD[0], START_BCD[1],
                 ((seconds // 10) << 4) | (seconds % 10)))
    return bytes((0x70, 0x70, 0x05)) + utc


def section_packet(pid: int, section: bytes, cc: int) -> bytes:
    payload = b"\x00" + section
    if len(payload) > 184:
        raise SystemExit("section on PID %d does not fit one packet" % pid)
    head = bytes((0x47, 0x40 | (pid >> 8), pid & 0xFF, 0x10 | (cc & 0x0F)))
    return head + payload + b"\xFF" * (184 - len(payload))


def add_tables(data: bytes) -> bytes:
    pkts = [data[i:i + 188] for i in range(0, len(data), 188)]
    first_pts = None
    for pkt in pkts:
        pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
        if pid == VIDEO_PID and pkt[1] & 0x40:
            first_pts = read_pts(payload_of(pkt))
            if first_pts is not None:
                break
    if first_pts is None:
        raise SystemExit("no video PTS found")
    plan = [
        (CUE_OUT_S - PREROLL_S, SCTE_PID, cue(0x4242, 0x30, first_pts + int(CUE_OUT_S * 90000),
                                              int((CUE_IN_S - CUE_OUT_S) * 90000))),
        (CUE_IN_S - PREROLL_S, SCTE_PID, cue(0x4243, 0x31, first_pts + int(CUE_IN_S * 90000), None)),
    ]
    for t in (0.0, 5.0):
        plan.append((t, NIT_PID, nit()))
    # EIT p/f is due every 2 s. Null packets come in clusters, so plan it
    # every 0.5 s to keep a margin.
    for i in range(2 * DURATION_S + 2):
        plan.append((i * 0.5, EIT_PID, eit(0)))
        plan.append((i * 0.5, EIT_PID, eit(1)))
    for t in range(0, DURATION_S + 2, 5):
        plan.append((t + 0.5, TDT_PID, tdt(t)))
    plan.sort(key=lambda item: item[0])
    first_pcr, now, cc, out = None, 0.0, {}, []
    for pkt in pkts:
        pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
        pcr = pcr_of(pkt)
        if pcr is not None:
            first_pcr = pcr if first_pcr is None else first_pcr
            now = (pcr - first_pcr) / 27e6
        if pid == PMT_PID and pkt[1] & 0x40:
            pkt = rewrite_pmt(pkt)
        elif pid == 0x1FFF and plan and now >= plan[0][0]:
            _, target, section = plan.pop(0)
            pkt = section_packet(target, section, cc.get(target, 0))
            cc[target] = cc.get(target, 0) + 1
        out.append(pkt)
    # Tables planned past the last null packet are dropped; the SCTE-35 cues
    # must not be among them.
    if any(target == SCTE_PID for _, target, _ in plan):
        raise SystemExit("ran out of null packets before every cue was placed")
    return b"".join(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", help="a local copy of " + MEMBER + " (skips the download)")
    parser.add_argument("--out", default=str(OUT))
    args = parser.parse_args()
    source = Path(args.source) if args.source else fetch_source()
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "raw.ts"
        encode(source, raw)
        data = add_tables(raw.read_bytes())
    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    print("wrote %s (%d bytes, %d packets)" % (dest, len(data), len(data) // 188))


if __name__ == "__main__":
    main()
