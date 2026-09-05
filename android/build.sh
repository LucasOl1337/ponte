#!/usr/bin/env bash
set -euo pipefail
umask 077
android_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(realpath "$android_dir/..")"
build_root="${PONTE_ANDROID_BUILD:-$repo_dir/.work/android-build}"
config="${PONTE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/ponte/config.json}"
jdk="${PONTE_JDK:-$build_root/jdk/amazon-corretto-17.0.20.10.1-linux-x64}"
tools="${PONTE_ANDROID_TOOLS:-$build_root/build-tools/android-15}"
platform="${PONTE_ANDROID_PLATFORM:-$build_root/platform/android-35/android.jar}"
build="$build_root/app"
keys="${PONTE_ANDROID_KEYS:-${XDG_DATA_HOME:-$HOME/.local/share}/ponte/android-signing}"
apk="${PONTE_ANDROID_APK:-$repo_dir/.work/Ponte.apk}"
if [[ ! -f "$config" ]]; then
  printf 'No local Ponte config found. Run ./ponte setup, or set PONTE_CONFIG.\n' >&2
  exit 1
fi
if [[ ! -x "$jdk/bin/javac" || ! -x "$tools/aapt2" || ! -f "$platform" ]]; then
  python3 "$android_dir/bootstrap.py" "$build_root"
fi
mkdir -p "$build/classes" "$build/generated" "$build/dex" "$build/assets" "$keys" "$(dirname -- "$apk")"
chmod 700 "$keys"
python3 - "$build" <<'PY'
from pathlib import Path
import shutil,sys
root=Path(sys.argv[1])
for name in ('classes','generated','dex','assets'):
 p=root/name;shutil.rmtree(p);p.mkdir()
PY
python3 "$android_dir/configure.py" "$config" "$build" "$android_dir/AndroidManifest.xml"
if [[ ! -f "$keys/signing-password" ]]; then
  python3 - "$keys/signing-password" <<'PY'
from pathlib import Path
import secrets,sys
p=Path(sys.argv[1]);p.write_text(secrets.token_hex(32)+'\n');p.chmod(0o600)
PY
fi
if [[ ! -f "$keys/ponte-signing.p12" ]]; then
  "$jdk/bin/keytool" -genkeypair -noprompt -alias ponte -storetype PKCS12 -keystore "$keys/ponte-signing.p12" -storepass:file "$keys/signing-password" -keypass:file "$keys/signing-password" -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 -dname "CN=Ponte Local Build,O=Ponte"
  chmod 600 "$keys/ponte-signing.p12"
fi
"$tools/aapt2" compile --dir "$android_dir/res" -o "$build/resources.zip"
"$tools/aapt2" link -o "$build/base.apk" -I "$platform" --manifest "$build/AndroidManifest.xml" -A "$build/assets" --java "$build/generated" "$build/resources.zip"
python3 - "$android_dir" "$build" <<'PY'
from pathlib import Path
import sys
android,build=map(Path,sys.argv[1:]);sources=sorted((android/'src').rglob('*.java'))+sorted((build/'generated').rglob('*.java'))
(build/'sources.txt').write_text('\n'.join('"'+str(p)+'"' for p in sources)+'\n')
PY
"$jdk/bin/javac" -encoding UTF-8 -source 8 -target 8 -classpath "$platform" -d "$build/classes" "@$build/sources.txt"
"$jdk/bin/jar" --create --file "$build/classes.jar" -C "$build/classes" .
"$jdk/bin/java" -cp "$tools/lib/d8.jar" com.android.tools.r8.D8 --release --min-api 26 --lib "$platform" --output "$build/dex" "$build/classes.jar"
python3 - "$build" <<'PY'
from pathlib import Path
import sys,zipfile
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'base.apk') as base:
 entries={i.filename:(base.read(i),i.compress_type) for i in base.infolist()}
for dex in sorted((p/'dex').glob('classes*.dex')):entries[dex.name]=(dex.read_bytes(),zipfile.ZIP_DEFLATED)
with zipfile.ZipFile(p/'unsigned.apk','w') as z:
 for name,(data,compression) in sorted(entries.items()):
  info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.create_system=3;info.external_attr=0o100644<<16
  z.writestr(info,data,compress_type=compression)
PY
"$tools/zipalign" -f 4 "$build/unsigned.apk" "$build/aligned.apk"
"$jdk/bin/java" -jar "$tools/lib/apksigner.jar" sign --ks "$keys/ponte-signing.p12" --ks-key-alias ponte --ks-pass "file:$keys/signing-password" --out "$apk" "$build/aligned.apk"
chmod 644 "$apk"
"$jdk/bin/java" -jar "$tools/lib/apksigner.jar" verify --verbose "$apk"
"$tools/zipalign" -c 4 "$apk"
python3 "$android_dir/verify-apk.py" "$tools/aapt2" "$apk" "$build/AndroidManifest.xml" "$build"
printf 'APK: %s\n' "$apk"
