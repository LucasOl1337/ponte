#!/usr/bin/env python3
"""Build a synthetic APK and inspect its contents without reading user config."""
import json
import os
from pathlib import Path
import subprocess
import zipfile
from configure_test import ConfigureTest, ANDROID

ConfigureTest.setUpClass()
try:
    fixture = ConfigureTest
    config = fixture.root / 'config.json'
    config.write_text(json.dumps(fixture.base))
    apk = Path(os.environ.get('PONTE_FIXTURE_APK', ANDROID.parent / '.work/Ponte-fixture.apk')).resolve()
    environment = dict(os.environ, PONTE_CONFIG=str(config), PONTE_ANDROID_KEYS=str(fixture.root / 'signing'), PONTE_ANDROID_APK=str(apk))
    subprocess.run([str(ANDROID / 'build.sh')], check=True, env=environment)
    with zipfile.ZipFile(apk) as archive:
        assert archive.read('assets/pc-certificate.pem') == fixture.leaf.read_bytes()
        for name in archive.namelist():
            contents = archive.read(name)
            assert b'PRIVATE KEY' not in contents, name
            assert fixture.base['pairToken'].encode() not in contents, name
            assert b'must-never-be-read.key' not in contents, name
        assert not any(name.endswith(('.key', '.p12', 'config.json')) for name in archive.namelist())
    print('Synthetic APK built: expected leaf only; pairing sentinel, private keys and config absent.')
finally:
    ConfigureTest.tearDownClass()
