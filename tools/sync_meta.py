from pathlib import Path
root = Path(__file__).resolve().parents[1]
source = root / "Poscenter_file_catalog_plus.user.js"
raw = source.read_bytes()
header = raw.split(b"// ==/UserScript==", 1)[0]
newline = b"\r\n" if b"\r\n" in header else b"\n"
(root / "Poscenter_file_catalog_plus.meta.js").write_bytes(header + b"// ==/UserScript==" + newline)
