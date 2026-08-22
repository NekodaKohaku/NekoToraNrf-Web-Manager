#!/usr/bin/env python3
"""Stage a verified firmware build for publication.

    python tools/publish.py <folder-with-build-artifacts>

Point it at the folder you unzipped the Build Firmware artifact into. It works
out the version from the firmware itself, checks the two files are what they
claim to be, copies them into firmware/<device>/ and rewrites latest.json.
Nothing is committed - you review `git diff` and push.

Why a script rather than copying by hand: the two files look interchangeable
and are not, and the manifest has three fields that must agree with things you
cannot see by looking at them.

  .update.bin       MCUboot signed update image. Written to slot 1; the
                    bootloader swaps it in. Used by wireless OTA and wired DFU.
  .first_flash.hex  Full image including MCUboot itself. SWD only.

The dangerous mix-up is publishing the build tree's plain `zephyr.hex` as the
SWD image. It looks like a normal hex file, flashes without complaint, and
overwrites the bootloader with the application - after which the unit can only
be recovered over SWD, which is the very thing a customer does not have. The
check for a load address at 0x0 below is what catches it.

Requires nothing but Python 3.8+.
"""

import argparse
import json
import re
import shutil
import struct
import sys
from pathlib import Path

MCUBOOT_MAGIC = 0x96F3B83D
REPO = Path(__file__).resolve().parent.parent


def die(msg):
    print("error: " + msg, file=sys.stderr)
    raise SystemExit(1)


def read_mcuboot_header(path):
    """Pull the version MCUboot recorded out of an update image.

    This is the authoritative answer to "what version is this build", because
    it is written by the same CMake pass that defines FW_VERSION_* in the
    firmware - the numbers the tracker reports over OTA. Taking the version
    from a filename or from what the operator remembers is how a manifest ends
    up disagreeing with the thing it describes.
    """
    data = path.read_bytes()
    if len(data) < 32:
        die(f"{path.name}: too small to be an MCUboot image")
    magic, _load, hdr_size, _ptlv, img_size, _flags = struct.unpack_from("<IIHHII", data, 0)
    if magic != MCUBOOT_MAGIC:
        die(f"{path.name}: not an MCUboot update image "
            f"(magic {magic:#010x}, expected {MCUBOOT_MAGIC:#010x}).\n"
            "       This is probably the wrong file - look for *.update.bin.")
    major, minor, revision, build_num = struct.unpack_from("<BBHI", data, 20)
    return {
        "version": f"{major}.{minor}.{revision}",
        "major": major, "minor": minor, "patch": revision,
        "build_num": build_num,
        "img_size": img_size,
        "hdr_size": hdr_size,
        "file_size": len(data),
    }


def hex_lowest_address(path):
    """Lowest load address in an Intel HEX file.

    A full image starts at 0x0 because that is where MCUboot's vector table
    lives. An application-only hex starts at the slot-0 offset instead.
    """
    base = 0
    lowest = None
    for lineno, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        if not line.startswith(":"):
            die(f"{path.name}:{lineno}: not an Intel HEX file")
        try:
            b = bytes.fromhex(line[1:])
        except ValueError:
            die(f"{path.name}:{lineno}: bad hex digits")
        if len(b) < 5:
            die(f"{path.name}:{lineno}: record too short")
        if (sum(b) & 0xFF) != 0:
            die(f"{path.name}:{lineno}: checksum mismatch - file may be corrupt")
        count, addr, rectype = b[0], (b[1] << 8) | b[2], b[3]
        payload = b[4:4 + count]
        if rectype == 0x00:
            a = base + addr
            lowest = a if lowest is None else min(lowest, a)
        elif rectype == 0x01:
            break
        elif rectype == 0x02:
            base = ((payload[0] << 8) | payload[1]) << 4
        elif rectype == 0x04:
            base = ((payload[0] << 8) | payload[1]) << 16
    if lowest is None:
        die(f"{path.name}: contains no data records")
    return lowest


def pick(folder, suffix):
    hits = sorted(folder.glob("*" + suffix))
    if not hits:
        die(f"no *{suffix} in {folder}\n"
            f"       found: " + (", ".join(p.name for p in sorted(folder.iterdir())) or "(nothing)"))
    if len(hits) > 1:
        die(f"more than one *{suffix} in {folder}:\n       " +
            "\n       ".join(p.name for p in hits))
    return hits[0]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, help="folder containing the build artifacts")
    ap.add_argument("--device", default="nekotora", help="device id in devices.json (default: nekotora)")
    ap.add_argument("--board-target", default=None,
                    help="override CONFIG_BOARD_TARGET (default: keep what latest.json has)")
    ap.add_argument("--expect-version", default=None,
                    help="fail unless the firmware reports this version")
    ap.add_argument("--dry-run", action="store_true", help="report only, change nothing")
    args = ap.parse_args()

    folder = args.folder.expanduser().resolve()
    if not folder.is_dir():
        die(f"not a folder: {folder}")

    bin_src = pick(folder, ".update.bin")
    hex_src = pick(folder, ".first_flash.hex")

    info = read_mcuboot_header(bin_src)
    version = info["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        die(f"firmware reports a malformed version {version!r}")
    if version == "0.0.0":
        die("firmware reports version 0.0.0.\n"
            "       The build had no x.y.z git tag to describe, so every tracker\n"
            "       would report 0.0.0 and the updater could never tell old from new.\n"
            "       Tag the tracker repo (e.g. `git tag 1.0.0`, no leading v), push\n"
            "       the tag, rebuild, and use that artifact instead.")
    if args.expect_version and args.expect_version != version:
        die(f"firmware reports {version}, expected {args.expect_version}")

    lowest = hex_lowest_address(hex_src)
    if lowest != 0:
        die(f"{hex_src.name} starts at {lowest:#010x}, not 0x00000000.\n"
            "       A full image contains MCUboot and therefore begins at 0x0.\n"
            "       This looks like an application-only hex; flashing it over SWD\n"
            "       would erase the bootloader and leave the unit updatable only\n"
            "       over SWD. Use the *.first_flash.hex from the build artifact.")

    dest = REPO / "firmware" / args.device
    manifest_path = dest / "latest.json"
    if not manifest_path.is_file():
        die(f"no manifest at {manifest_path.relative_to(REPO)} - is --device right?")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    board = args.board_target or manifest.get("boardTarget")
    if not board:
        die("no boardTarget in the manifest and none given.\n"
            "       It must match the tracker's CONFIG_BOARD_TARGET exactly, or every\n"
            "       tracker shows up as the wrong model and none can be updated.\n"
            "       Pass --board-target 'promicro_uf2/nrf52840/spi'.")

    version_code = (info["major"] << 16) | (info["minor"] << 8) | info["patch"]
    bin_name = f"{args.device}-{version}.update.bin"
    hex_name = f"{args.device}-{version}.hex"

    print(f"  source      {folder}")
    print(f"  update.bin  {bin_src.name}")
    print(f"              {info['file_size']:,} bytes, image {info['img_size']:,} bytes")
    print(f"  full hex    {hex_src.name}")
    print(f"              lowest load address 0x{lowest:08X} (bootloader present)")
    print(f"  version     {version}  (versionCode {version_code} = 0x{version_code:06X})")
    if info["build_num"]:
        print(f"              build_num {info['build_num']} - commits past the tag; the"
              f" firmware calls itself {version} but is not identical to that tag")
    print(f"  board       {board}")
    print(f"  device      {args.device}")

    previous = manifest.get("versionCode")
    if isinstance(previous, int):
        if version_code < previous:
            print(f"\n  note: this is OLDER than what is published "
                  f"({manifest.get('version')}). Trackers already on the newer build "
                  f"will show as up to date and will not take this.")
        elif version_code == previous:
            print(f"\n  note: same version as what is published ({manifest.get('version')}). "
                  f"Files will be overwritten; trackers will see nothing new.")

    if args.dry_run:
        print("\n  dry run, nothing written")
        return

    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(bin_src, dest / bin_name)
    shutil.copy2(hex_src, dest / hex_name)

    manifest.update({
        "version": version,
        "versionCode": version_code,
        "boardTarget": board,
        "hex": hex_name,
        "bin": bin_name,
        "date": __import__("datetime").date.today().isoformat(),
    })
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                             encoding="utf-8")

    rel = dest.relative_to(REPO).as_posix()
    print(f"\n  wrote {rel}/{bin_name}")
    print(f"  wrote {rel}/{hex_name}")
    print(f"  wrote {rel}/latest.json")
    print("\nNext:")
    print(f"  git add {rel}")
    print("  git diff --cached -- '*latest.json'      # check the manifest reads right")
    print(f"  git commit -m \"firmware: {args.device} {version}\"")
    print("  git push")


if __name__ == "__main__":
    main()
