#!/usr/bin/env python3
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src_file = root / "scripts" / "install.ps1.src"
dst_file = root / "install.ps1"

text = src_file.read_text(encoding="utf-8")
encoded = re.sub(
    r"MSG\{(.*?)\}",
    lambda m: "".join(f"\\u{ord(c):04x}" if ord(c) > 127 else c for c in m.group(1)),
    text,
)
dst_file.write_text(encoded, encoding="ascii")
print(f"Generated {dst_file} (ASCII bytes: {len(encoded)})")
