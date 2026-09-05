#!/usr/bin/env python3
"""Generate Android resources from a local Ponte configuration, never credentials."""
from pathlib import Path
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ANDROID = '{http://schemas.android.com/apk/res/android}'
TAILSCALE = ipaddress.IPv4Network('100.64.0.0/10')


def public_certificate(path):
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise ValueError('Certificate paths must be absolute')
    with Path(path).open('rb') as stream:
        data = stream.read(65537)
    if len(data) > 65536 or not re.fullmatch(
        rb'\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*', data
    ):
        raise ValueError('Expected one public PEM certificate, without keys or other contents')
    return data.strip() + b'\n'


def configure(config_path, output, template):
    config_path, output, template = map(Path, (config_path, output, template))
    if not config_path.is_file():
        raise ValueError('No local Ponte config found. Run ./ponte setup, or set PONTE_CONFIG.')
    if config_path.stat().st_size > 65536:
        raise ValueError('Ponte configuration exceeds 64 KiB')
    config = json.loads(config_path.read_text())
    if type(config) is not dict or type(config.get('schemaVersion')) is not int or config['schemaVersion'] != 1:
        raise ValueError('Expected Ponte configuration schemaVersion 1')
    native = config.get('nativeTls')
    if type(native) is not dict:
        raise ValueError('Enable nativeTls with ./ponte setup before building Android')
    host, port = native.get('host'), native.get('port')
    if not isinstance(host, str):
        raise ValueError('nativeTls.host must be a canonical Tailscale IPv4 address')
    address = ipaddress.IPv4Address(host)
    if str(address) != host or address not in TAILSCALE:
        raise ValueError('nativeTls.host must be a canonical Tailscale IPv4 address')
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('nativeTls.port must be an integer from 1 to 65535')
    certificate = public_certificate(native.get('certFile'))
    ca = public_certificate(native.get('caFile', native.get('certFile')))
    # The configuration may contain keyFile, dataDir and unrelated credentials.
    # Only these public certificate bytes and the validated endpoint are used.
    output.mkdir(parents=True, exist_ok=True)
    os.chmod(output, 0o700)
    assets = output / 'assets'
    assets.mkdir(exist_ok=True)
    certificate_file = assets / 'pc-certificate.pem'
    certificate_file.write_bytes(certificate)
    ca_file = output / 'build-ca.pem'
    ca_file.write_bytes(ca)
    result = subprocess.run([
        'openssl', 'verify', '-CAfile', str(ca_file), '-no-CApath', '-no-CAstore', '-purpose', 'sslserver',
        '-verify_ip', host, str(certificate_file),
    ], text=True, capture_output=True)
    if result.returncode:
        certificate_file.unlink(missing_ok=True)
        raise ValueError('The public server certificate must be valid, trusted by caFile, and contain the configured IP SAN')
    manifest = ET.parse(template)
    android_config = config.get('android', {})
    if type(android_config) is not dict:
        raise ValueError('android must be an object when provided')
    version_code = android_config.get('versionCode', int(manifest.getroot().attrib[ANDROID + 'versionCode']))
    version_name = android_config.get('versionName', manifest.getroot().attrib[ANDROID + 'versionName'])
    if type(version_code) is not int or not 1 <= version_code <= 2100000000:
        raise ValueError('android.versionCode must be a positive Android version code')
    if not isinstance(version_name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+\-]{0,39}', version_name):
        raise ValueError('android.versionName must be a short release identifier')
    manifest.getroot().set(ANDROID + 'versionCode', str(version_code))
    manifest.getroot().set(ANDROID + 'versionName', version_name)
    ET.register_namespace('android', ANDROID[1:-1])
    manifest.write(output / 'AndroidManifest.xml', encoding='utf-8', xml_declaration=True)
    upstream = f'https://{host}:{port}'
    java = output / 'generated/app/ponte/omarchy/BuildConfig.java'
    java.parent.mkdir(parents=True, exist_ok=True)
    java.write_text('package app.ponte.omarchy;\n\nfinal class BuildConfig {\n'
                    + '    static final String UPSTREAM = ' + json.dumps(upstream) + ';\n'
                    + '    static final String VERSION_NAME = ' + json.dumps(version_name) + ';\n}\n')
    metadata = {'upstream': upstream, 'versionCode': version_code, 'versionName': version_name,
                'certificateSha256': hashlib.sha256(certificate).hexdigest()}
    (output / 'public-build.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return metadata


if __name__ == '__main__':
    try:
        configure(*sys.argv[1:])
        print('Local Android endpoint, certificate chain, IP SAN and version verified.')
    except (ValueError, OSError, ET.ParseError) as error:
        raise SystemExit(str(error))
