#!/usr/bin/env python3
"""crosery-api-console 生产 release ⟷ 本地仓库 漂移扫描器（task-6 Phase 1 工具，只读）。

用法：
    python3 divergence-scan.py <workdir> [repo]

<workdir> 需先放好（全部由只读命令生成；命令见 divergence-report.md 第 6 节）：
    prod-release-manifest.tsv        sha256 \t lines \t ./path   ← 生产 current release
    local-head-manifest.tsv          同上                          ← 本地 HEAD (git archive HEAD)
    local-base-662a504-manifest.tsv  同上                          ← 本地 merge-base 662a504
    releases/<release-id>/MANIFEST.sha256 + RELEASE.json           ← 生产 release 链

输出：analysis.json（逐文件三方分类 + 两侧内容历史）、classification.tsv。

分类口径（三方比较，common = 生产 release 链与本地提交历史中最近一次内容相同者）：
    SAME      两侧内容一致
    P         仅生产侧改动（生产补丁，必须回移）
    C         两侧都改过（必须人工合并）
    P-ONLY    生产有、本地没有（路径级）
    L-ONLY    本地有、生产没有（路径级）
    L         仅本地侧改动
    C-NOBASE  两侧都生成过、历史里无共同基线（如 MANIFEST.sha256）

本脚本只读本地 git 与本地文件，不连接生产主机。
"""
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter, OrderedDict, defaultdict

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
REPO = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.getcwd())


def load_tsv(path):
    out = OrderedDict()
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 3:
                continue
            sha, lines, p = parts
            out[p[2:] if p.startswith("./") else p] = (sha, lines)
    return out


def parse_manifest(path):
    out = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if "  " not in line:
                continue
            sha, p = line.split("  ", 1)
            sha = sha.strip()
            if len(sha) != 64:
                continue
            p = p[2:] if p.startswith("./") else p.lstrip("/")
            out[p] = sha
    return out


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True).stdout


def local_blob_hashes():
    """sha1 blob -> sha256 content，覆盖本地仓库全部对象（判断生产内容是否在本地任何提交出现过）。"""
    listing = git("cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)")
    blobs = [l.split()[0] for l in listing.splitlines() if l.endswith(" blob")]
    proc = subprocess.Popen(["git", "-C", REPO, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    out, _ = proc.communicate(("\n".join(blobs) + "\n").encode())
    res, pos = {}, 0
    for _ in blobs:
        nl = out.index(b"\n", pos)
        parts = out[pos:nl].decode().split()
        size = int(parts[2])
        res[parts[0]] = hashlib.sha256(out[nl + 1:nl + 1 + size]).hexdigest()
        pos = nl + 1 + size + 1
    return res


def local_path_history(blob2sha):
    hist = defaultdict(list)
    raw = git("log", "--all", "--reverse", "--pretty=%H")
    for sha in raw.split():
        seen = {}
        for line in git("ls-tree", "-r", sha).splitlines():
            meta, p = line.split("\t", 1)
            seen[p] = blob2sha.get(meta.split()[2])
        for p, h in seen.items():
            if not hist[p] or hist[p][-1][1] != h:
                hist[p].append((sha[:7], h))
    return hist


def main():
    prod = load_tsv(os.path.join(ROOT, "prod-release-manifest.tsv"))
    head = load_tsv(os.path.join(ROOT, "local-head-manifest.tsv"))
    base = load_tsv(os.path.join(ROOT, "local-base-662a504-manifest.tsv"))

    rel_root = os.path.join(ROOT, "releases")
    rels = sorted(d for d in os.listdir(rel_root) if os.path.isdir(os.path.join(rel_root, d))) if os.path.isdir(rel_root) else []
    rel_manifests = OrderedDict()
    for r in rels:
        mf = os.path.join(rel_root, r, "MANIFEST.sha256")
        if os.path.exists(mf):
            rel_manifests[r] = parse_manifest(mf)

    blob2sha = local_blob_hashes()
    all_local = set(blob2sha.values())
    hist = local_path_history(blob2sha)
    prod_hist = defaultdict(list)
    for r, mf in rel_manifests.items():
        for p, h in mf.items():
            if not prod_hist[p] or prod_hist[p][-1][1] != h:
                prod_hist[p].append((r, h))

    rows = []
    for p in sorted(set(prod) | set(head) | set(base)):
        ps = prod[p][0] if p in prod else None
        hs = head[p][0] if p in head else None
        bs = base[p][0] if p in base else None
        lchain = [h for _c, h in hist.get(p, [])]
        pchain = [h for _r, h in prod_hist.get(p, [])]
        common = [h for h in pchain if h in set(lchain)]
        if not common and bs and bs in set(lchain):
            common = [bs]
        newest_common = common[-1] if common else None
        anc = next((r for r, h in prod_hist.get(p, []) if h == newest_common), None)

        if ps and hs and ps == hs:
            cat = "SAME"
        elif ps and hs:
            if newest_common is None:
                cat = "C-NOBASE"
            elif ps == newest_common:
                cat = "L"
            elif hs == newest_common:
                cat = "P"
            else:
                cat = "C"
        elif ps:
            cat = "P-ONLY"
        elif hs:
            cat = "L-ONLY"
        else:
            continue

        rows.append({
            "path": p, "cat": cat, "prod_sha": ps, "prod_lines": prod.get(p, (None, None))[1],
            "head_sha": hs, "head_lines": head.get(p, (None, None))[1], "base_sha": bs,
            "prod_hist": prod_hist.get(p, []), "local_hist": hist.get(p, []),
            "newest_common": newest_common, "ancestor_release": anc,
            "prod_blob_known_locally": bool(ps and ps in all_local),
        })

    json.dump({"rows": rows, "releases": rels, "counts": {"prod_files": len(prod), "head_files": len(head), "base_files": len(base)}},
              open(os.path.join(ROOT, "analysis.json"), "w"), indent=1, ensure_ascii=False)
    print(Counter(r["cat"] for r in rows))
    print("prod:", len(prod), "head:", len(head), "base:", len(base))
    print("prod content never present in any local commit:",
          len([r for r in rows if r["prod_sha"] and not r["prod_blob_known_locally"]]))


if __name__ == "__main__":
    main()
