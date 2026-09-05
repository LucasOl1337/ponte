#!/usr/bin/env python3
"""Check the packaged manifest, including Chromium's audio requirements."""
import re
import json
from pathlib import Path
import zipfile
import subprocess
import sys
import xml.etree.ElementTree as ET

android = '{http://schemas.android.com/apk/res/android}'
aapt, apk, manifest, build = sys.argv[1:]
source = ET.parse(manifest).getroot()
badging = subprocess.check_output([aapt, 'dump', 'badging', apk], text=True)
permissions = set(re.findall(r"^uses-permission: name='([^']+)'", badging, re.MULTILINE))
required = {
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
}
if permissions != required:
    raise SystemExit('APK permissions mismatch: missing=' + repr(sorted(required - permissions))
                     + ', unexpected=' + repr(sorted(permissions - required)))
package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging)
expected = ('app.ponte.omarchy', source.attrib[android + 'versionCode'], source.attrib[android + 'versionName'])
if package is None or package.groups() != expected:
    raise SystemExit('APK package/version does not match the release manifest')
if "launchable-activity: name='app.ponte.omarchy.MainActivity'" not in badging:
    raise SystemExit('APK is missing the Ponte launcher Activity')
metadata = json.loads((Path(build) / 'public-build.json').read_text())
with zipfile.ZipFile(apk) as archive:
    assets = {name for name in archive.namelist() if name.startswith('assets/')}
    if assets != {'assets/pc-certificate.pem'}:
        raise SystemExit('APK must contain only the selected public server certificate as an asset')
    if archive.read('assets/pc-certificate.pem') != (Path(build) / 'assets/pc-certificate.pem').read_bytes():
        raise SystemExit('APK certificate does not match the configured public leaf')
    dex = [archive.read(name) for name in archive.namelist() if re.fullmatch(r'classes[0-9]*\.dex', name)]
    if not any(metadata['upstream'].encode() in contents for contents in dex):
        raise SystemExit('APK endpoint does not match the configured Tailscale origin')
print(f'APK package verified: {expected[0]} {expected[2]} (versionCode {expected[1]}); all 3 permissions present.')
