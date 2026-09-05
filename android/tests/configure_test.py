#!/usr/bin/env python3
"""No network or personal configuration: generate independent certificate fixtures."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ANDROID = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('configure', ANDROID / 'configure.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def openssl(*args):
    subprocess.run(['openssl', *map(str, args)], check=True, capture_output=True)


class ConfigureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='ponte-android-config-')
        cls.root = Path(cls.directory.name)
        cls.ca = cls.root / 'ca.crt'
        cls.leaf = cls.root / 'server.crt'
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', cls.root / 'ca.key',
                '-out', cls.ca, '-days', '2', '-subj', '/CN=Ponte synthetic CA',
                '-addext', 'basicConstraints=critical,CA:TRUE')
        openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', cls.root / 'server.key',
                '-out', cls.root / 'server.csr', '-subj', '/CN=Ponte synthetic server')
        (cls.root / 'server.ext').write_text('subjectAltName=IP:100.64.0.10\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n')
        openssl('x509', '-req', '-in', cls.root / 'server.csr', '-CA', cls.ca,
                '-CAkey', cls.root / 'ca.key', '-CAcreateserial', '-out', cls.leaf, '-days', '2',
                '-extfile', cls.root / 'server.ext')
        cls.base = {'schemaVersion': 1, 'nativeTls': {
            'host': '100.64.0.10', 'port': 8788, 'certFile': str(cls.leaf), 'caFile': str(cls.ca),
            'keyFile': str(cls.root / 'must-never-be-read.key'),
        }, 'pairToken': 'synthetic-private-token-must-not-be-packaged'}

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def configure(self, config):
        self.output = self.root / self.id().split('.')[-1]
        path = self.root / 'config.json'
        path.write_text(json.dumps(config))
        return module.configure(path, self.output, ANDROID / 'AndroidManifest.xml')

    def test_generates_only_endpoint_public_leaf_and_version(self):
        config = copy.deepcopy(self.base)
        config['android'] = {'versionCode': 42, 'versionName': '1.2.3-test'}
        result = self.configure(config)
        self.assertEqual(result['upstream'], 'https://100.64.0.10:8788')
        self.assertEqual(result['versionCode'], 42)
        assets = list((self.output / 'assets').iterdir())
        self.assertEqual([p.name for p in assets], ['pc-certificate.pem'])
        self.assertEqual(assets[0].read_bytes(), self.leaf.read_bytes())
        for path in self.output.rglob('*'):
            if path.is_file():
                contents = path.read_bytes()
                self.assertNotIn(b'PRIVATE KEY', contents)
                self.assertNotIn(self.base['pairToken'].encode(), contents)
                self.assertNotIn(b'must-never-be-read.key', contents)
        self.assertIn('VERSION_NAME = "1.2.3-test"', (self.output / 'generated/app/ponte/omarchy/BuildConfig.java').read_text())

    def test_rejects_noncanonical_or_non_tailscale_hosts(self):
        for host in ['127.0.0.1', '100.63.255.255', '100.128.0.1', '100.064.0.10', 'example.com', '100.64.0.10:8788', '100.64.0.10/']:
            with self.subTest(host=host):
                config = copy.deepcopy(self.base)
                config['nativeTls']['host'] = host
                with self.assertRaises(ValueError): self.configure(config)

    def test_rejects_wrong_ip_san(self):
        config = copy.deepcopy(self.base)
        config['nativeTls']['host'] = '100.64.0.11'
        with self.assertRaisesRegex(ValueError, 'IP SAN'): self.configure(config)

    def test_rejects_wrong_ca(self):
        config = copy.deepcopy(self.base)
        config['nativeTls']['caFile'] = str(self.leaf)
        with self.assertRaisesRegex(ValueError, 'trusted'): self.configure(config)

    def test_rejects_secret_or_extra_pem_contents(self):
        for contents in [self.leaf.read_bytes() + (self.root / 'server.key').read_bytes(), self.ca.read_bytes() + self.leaf.read_bytes(), b'not a certificate']:
            (self.root / 'bad.pem').write_bytes(contents)
            config = copy.deepcopy(self.base)
            config['nativeTls']['certFile'] = str(self.root / 'bad.pem')
            with self.assertRaisesRegex(ValueError, 'public PEM'): self.configure(config)

    def test_rejects_invalid_port_and_version(self):
        for port in [True, 0, 65536, '8788']:
            config = copy.deepcopy(self.base)
            config['nativeTls']['port'] = port
            with self.assertRaisesRegex(ValueError, 'port'): self.configure(config)
        for version in [{'versionCode': True}, {'versionCode': 0}, {'versionName': 'bad";code'}]:
            config = copy.deepcopy(self.base)
            config['android'] = version
            with self.assertRaisesRegex(ValueError, 'version'): self.configure(config)

    def test_requires_local_schema_and_tls_configuration(self):
        for config in [{}, {'schemaVersion': True}, {'schemaVersion': 1}, {'schemaVersion': 2}]:
            with self.assertRaises(ValueError): self.configure(config)


if __name__ == '__main__':
    unittest.main()
