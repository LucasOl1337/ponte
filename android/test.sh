#!/usr/bin/env bash
set -euo pipefail
umask 077
android_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(realpath "$android_dir/..")"
build_root="${PONTE_ANDROID_BUILD:-$repo_dir/.work/android-build}"
jdk="${PONTE_JDK:-$build_root/jdk/amazon-corretto-17.0.20.10.1-linux-x64}"
if [[ ! -x "$jdk/bin/javac" ]]; then
  python3 "$android_dir/bootstrap.py" "$build_root"
fi
mkdir -p "$build_root/test-classes"
fixtures="$(mktemp -d "$build_root/test-tls.XXXXXX")"
trap 'rm -rf -- "$fixtures"' EXIT
for name in good wrong; do
  if [[ ! -f "$fixtures/$name.crt" ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$fixtures/$name.key" -out "$fixtures/$name.crt" -days 3 -subj "/CN=Ponte test $name" -addext 'subjectAltName=IP:127.0.0.1' -addext 'basicConstraints=critical,CA:TRUE' >/dev/null 2>&1
    openssl pkcs12 -export -out "$fixtures/$name.p12" -inkey "$fixtures/$name.key" -in "$fixtures/$name.crt" -passout pass:test-only
  fi
done
if [[ ! -f "$fixtures/child.p12" ]]; then
  openssl req -new -newkey rsa:2048 -nodes -keyout "$fixtures/child.key" -out "$fixtures/child.csr" -subj '/CN=Ponte test child' >/dev/null 2>&1
  printf 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n' > "$fixtures/child.ext"
  openssl x509 -req -in "$fixtures/child.csr" -CA "$fixtures/good.crt" -CAkey "$fixtures/good.key" -CAcreateserial -out "$fixtures/child.crt" -days 3 -extfile "$fixtures/child.ext" >/dev/null 2>&1
  openssl pkcs12 -export -out "$fixtures/child.p12" -inkey "$fixtures/child.key" -in "$fixtures/child.crt" -certfile "$fixtures/good.crt" -passout pass:test-only
fi
"$jdk/bin/javac" -encoding UTF-8 -d "$build_root/test-classes" "$android_dir/src/app/ponte/omarchy/LoopbackProxy.java" "$android_dir/src/app/ponte/omarchy/ProxyMessages.java" "$android_dir/src/app/ponte/omarchy/MicrophonePermissionGate.java" "$android_dir/tests/ProxyTest.java" "$android_dir/tests/MicrophonePermissionGateTest.java"
"$jdk/bin/java" -cp "$build_root/test-classes" app.ponte.omarchy.ProxyTest "$fixtures"
"$jdk/bin/java" -cp "$build_root/test-classes" app.ponte.omarchy.MicrophonePermissionGateTest
python3 "$android_dir/tests/configure_test.py"
