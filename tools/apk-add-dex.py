#!/usr/bin/env python3
"""把 classes.dex 与 assets 目录注入 aapt2 link 产出的 APK，输出未签名 APK。

用法: apk-add-dex.py <base.apk> <classes.dex> <assets-dir> <out.apk>
assets-dir 下的每个文件以 assets/<相对路径> 写入（aapt -A 的等价结果）。
中文文件名以 UTF-8 标志写入 zip，Android AssetManager 可正常读取。
"""
import sys
import zipfile

src, dex, assets_dir, dst = sys.argv[1:5]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for info in zin.infolist():
        if info.filename == "classes.dex" or info.filename.startswith("META-INF/"):
            continue
        zout.writestr(info, zin.read(info.filename))
    zout.write(dex, "classes.dex")
    import os
    for dirpath, _dirnames, filenames in os.walk(assets_dir):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, assets_dir).replace("\\", "/")
            zout.write(full, "assets/" + rel)
print(f"OK {dst}")
