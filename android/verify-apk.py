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
    # Agent alerts with the app closed: a specialUse foreground service.
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.ACCESS_NETWORK_STATE',
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
tree = subprocess.check_output([aapt, 'dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], text=True)
service = tree[tree.find('E: service'):] if 'E: service' in tree else ''
if ('".AgentAlertService"' not in service or 'exported(0x01010010)=false' not in service
        or 'foregroundServiceType(0x01010599)=0x40000000' not in service or 'PROPERTY_SPECIAL_USE_FGS_SUBTYPE' not in service):
    raise SystemExit('APK must declare the agent alert service as private, specialUse, with its subtype')
metadata = json.loads((Path(build) / 'public-build.json').read_text())
with zipfile.ZipFile(apk) as archive:
    assets = {name for name in archive.namelist() if name.startswith('assets/')}
    if assets != {'assets/pc-ca.pem'}:
        raise SystemExit('APK must contain only the public installation CA as an asset')
    if archive.read('assets/pc-ca.pem') != (Path(build) / 'assets/pc-ca.pem').read_bytes():
        raise SystemExit('APK trust anchor does not match the configured public CA')
    dex = [archive.read(name) for name in archive.namelist() if re.fullmatch(r'classes[0-9]*\.dex', name)]
    if not any(metadata['upstream'].encode() in contents for contents in dex):
        raise SystemExit('APK endpoint does not match the configured Tailscale origin')
print(f'APK package verified: {expected[0]} {expected[2]} (versionCode {expected[1]}); all {len(required)} permissions present.')
