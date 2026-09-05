#!/usr/bin/env python3
"""Fetch the pinned official build toolchain into a local build directory."""
from pathlib import Path
import concurrent.futures
import hashlib
import platform
import sys
import tarfile
import urllib.request
import zipfile

ITEMS = [
    ('build-tools.zip', 'https://dl.google.com/android/repository/build-tools_r35_linux.zip', 'sha1', '2cfaa0bbb2336e9ec18ed3ecea84fa2e2af607bc'),
    ('platform.zip', 'https://dl.google.com/android/repository/platform-35_r02.zip', 'sha1', '0bb560a90a7a2cbd0dd8348224d518b638fe7949'),
    ('jdk.tar.gz', 'https://corretto.aws/downloads/resources/17.0.20.10.1/amazon-corretto-17.0.20.10.1-linux-x64.tar.gz', 'sha256', '74ff458657da91ca222681993e3c6b9a8e3629ca8e61c0d8cd90527280da9aa5'),
]
if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
    raise SystemExit('The bundled toolchain targets Linux x86_64. Supply PONTE_JDK, PONTE_ANDROID_TOOLS and PONTE_ANDROID_PLATFORM for another host.')
root = Path(sys.argv[1]).resolve()
downloads = root / 'downloads'
downloads.mkdir(parents=True, exist_ok=True)

def download(item):
    name, url, algorithm, digest = item
    path = downloads / name
    if not path.exists():
        with urllib.request.urlopen(url, timeout=60) as response, path.open('wb') as target:
            while block := response.read(1024 * 1024):
                target.write(block)
    with path.open('rb') as source:
        actual = hashlib.file_digest(source, algorithm).hexdigest()
    if actual != digest:
        raise ValueError(f'Checksum mismatch: {name}')
    print(f'{name}: checksum verified', flush=True)
    return path

with concurrent.futures.ThreadPoolExecutor(3) as workers:
    archives = list(workers.map(download, ITEMS))
for archive in archives[:2]:
    destination = root / ('build-tools' if archive.name == 'build-tools.zip' else 'platform')
    destination.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(destination)
        for info in bundle.infolist():
            mode = info.external_attr >> 16
            if mode:
                (destination / info.filename).chmod(mode)
with tarfile.open(archives[2]) as bundle:
    bundle.extractall(root / 'jdk', filter='data')
