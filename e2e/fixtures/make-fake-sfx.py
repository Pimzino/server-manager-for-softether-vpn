#!/usr/bin/env python3
"""Build a synthetic SoftEther-style SFX installer for tests.

Layout mirrors Cedar/SW.c SwCompileSfx: a PE32+ executable whose resource section holds
DATAFILE resources named VPNSETUP.EXE, VPNCLIENT.EXE, VPNCMGR.EXE, VPNCMD.EXE (4-byte
big-endian size + zlib, Mayaqua CompressBuf) and RAW_HAMCORE.SE2 (stored as-is).
The inner "exe" files are tiny PE32+ stubs (machine AMD64) with a VS_VERSION_INFO resource
so architecture and version detection can be tested.

usage: make-fake-sfx.py OUT.exe [version]
"""
import struct
import sys
import zlib

FILE_ALIGN = 0x200
SECT_ALIGN = 0x1000


def align(n, a):
    return (n + a - 1) // a * a


def build_resource_section(types, rva_base):
    """types: list of (type_key, [(name_key, data)]) where keys are str (named) or int (id)."""
    # Layout: root dir, type dirs, name dirs, lang dirs, data entries, strings, data
    dirs = []  # (offset placeholder) built in passes

    def dir_size(n):
        return 16 + 8 * n

    # compute sizes
    offset = dir_size(len(types))
    type_dir_off = []
    for _, names in types:
        type_dir_off.append(offset)
        offset += dir_size(len(names))
    name_dir_off = []
    for _, names in types:
        lst = []
        for _ in names:
            lst.append(offset)
            offset += dir_size(1)
        name_dir_off.append(lst)
    data_entry_off = []
    for _, names in types:
        lst = []
        for _ in names:
            lst.append(offset)
            offset += 16
        data_entry_off.append(lst)
    strings = {}
    str_blob = b""
    str_base = offset
    for tkey, names in types:
        for key in [tkey] + [n for n, _ in names]:
            if isinstance(key, str) and key not in strings:
                strings[key] = str_base + len(str_blob)
                enc = key.encode("utf-16le")
                str_blob += struct.pack("<H", len(key)) + enc
    offset = align(str_base + len(str_blob), 8)
    data_off = []
    data_blob = b""
    for _, names in types:
        lst = []
        for _, data in names:
            lst.append(offset + len(data_blob))
            data_blob += data + b"\0" * (align(len(data), 8) - len(data))
        data_off.append(lst)
    total = offset + len(data_blob)
    buf = bytearray(total)

    def write_dir(off, entries):
        named = sum(1 for k, _ in entries if isinstance(k, str))
        ids = len(entries) - named
        struct.pack_into("<IIHHHH", buf, off, 0, 0, 4, 0, named, ids)
        # named entries first, then ids (sorted)
        ordered = [e for e in entries if isinstance(e[0], str)] + [e for e in entries if not isinstance(e[0], str)]
        for i, (k, target) in enumerate(ordered):
            name_field = (0x80000000 | strings[k]) if isinstance(k, str) else k
            struct.pack_into("<II", buf, off + 16 + i * 8, name_field, target)

    write_dir(0, [(t, 0x80000000 | type_dir_off[i]) for i, (t, _) in enumerate(types)])
    for ti, (_, names) in enumerate(types):
        write_dir(type_dir_off[ti], [(n, 0x80000000 | name_dir_off[ti][ni]) for ni, (n, _) in enumerate(names)])
        for ni, (_, data) in enumerate(names):
            write_dir(name_dir_off[ti][ni], [(1033, data_entry_off[ti][ni])])
            struct.pack_into("<IIII", buf, data_entry_off[ti][ni], rva_base + data_off[ti][ni], len(data), 0, 0)
    buf[str_base:str_base + len(str_blob)] = str_blob
    buf[offset:offset + len(data_blob)] = data_blob
    return bytes(buf)


def version_info(ver):
    a, b, c, d = (int(x) for x in ver.split("."))
    fixed = struct.pack("<IIIIIIIIIIIII", 0xFEEF04BD, 0x00010000, (a << 16) | b, (c << 16) | d, (a << 16) | b, (c << 16) | d, 0x3F, 0, 4, 1, 0, 0, 0)
    key = "VS_VERSION_INFO".encode("utf-16le") + b"\0\0"
    hdr_len = 6 + len(key)
    pad = align(hdr_len, 4) - hdr_len
    body = key + b"\0" * pad + fixed
    return struct.pack("<HHH", 6 + len(body), len(fixed), 0) + body


def make_pe(resources, marker=b""):
    """Minimal PE32+ (AMD64) with one .rsrc section; `resources` as for build_resource_section."""
    headers_size = FILE_ALIGN
    rsrc_rva = SECT_ALIGN
    rsrc = build_resource_section(resources, rsrc_rva) + marker
    raw_size = align(len(rsrc), FILE_ALIGN)
    dos = bytearray(0x40)
    dos[0:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 0x40)
    coff = struct.pack("<HHIIIHH", 0x8664, 1, 0, 0, 0, 240, 0x22)
    opt = bytearray(240)
    struct.pack_into("<H", opt, 0, 0x20B)
    struct.pack_into("<I", opt, 32, SECT_ALIGN)
    struct.pack_into("<I", opt, 36, FILE_ALIGN)
    struct.pack_into("<I", opt, 56, rsrc_rva + align(len(rsrc), SECT_ALIGN))
    struct.pack_into("<I", opt, 60, headers_size)
    struct.pack_into("<I", opt, 108, 16)
    struct.pack_into("<II", opt, 112 + 2 * 8, rsrc_rva, len(rsrc))
    sect = struct.pack("<8sIIIIIIHHI", b".rsrc", len(rsrc), rsrc_rva, raw_size, headers_size, 0, 0, 0, 0, 0x40000040)
    head = bytes(dos) + b"PE\0\0" + coff + bytes(opt) + sect
    head += b"\0" * (headers_size - len(head))
    return head + rsrc + b"\0" * (raw_size - len(rsrc))


def compress(data):
    return struct.pack(">I", len(data)) + zlib.compress(data)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("version", nargs="?", default="5.2.5188.0")
    ap.add_argument("--hamcore", help="real hamcore.se2 to embed (default: dummy bytes)")
    ap.add_argument("--pe", help="real PE32+ executable to use for the inner client binaries (default: minimal stubs)")
    a = ap.parse_args()
    out, ver = a.out, a.version
    marker = lambda name: ("SoftEther VPN Client Developer Edition " + name).encode("utf-16le")
    if a.pe:
        real = open(a.pe, "rb").read()
        stub = lambda name: real + marker(name)  # overlay bytes keep the edition marker detectable
    else:
        stub = lambda name: make_pe([(16, [(1, version_info(ver))])], marker=marker(name))
    hamcore = open(a.hamcore, "rb").read() if a.hamcore else b"HamCore" + bytes(range(256)) * 16
    files = [
        ("VPNSETUP.EXE", compress(stub("vpnsetup"))),
        ("VPNCLIENT.EXE", compress(stub("vpnclient"))),
        ("VPNCMGR.EXE", compress(stub("vpncmgr"))),
        ("VPNCMD.EXE", compress(stub("vpncmd"))),
        ("RAW_HAMCORE.SE2", hamcore),
    ]
    sfx = make_pe([("DATAFILE", files), (16, [(1, version_info(ver))])])
    with open(out, "wb") as f:
        f.write(sfx)
    print(f"wrote {out} ({len(sfx)} bytes)")


if __name__ == "__main__":
    main()
