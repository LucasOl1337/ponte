#!/usr/bin/env bash
# Local equivalent of the retired GitHub Actions checks. Never downloads tools.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
android_build=0
case "${1:-}" in
  '') ;;
  --android-build) android_build=1 ;;
  --help) printf 'Usage: tools/check-local.sh [--android-build]\nRequires Node >=22, Python, tmux, OpenSSL and PONTE_JDK (JDK17+).\n--android-build also checks the installed Android SDK and builds a synthetic APK.\n'; exit 0 ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
for cmd in node npm python3 tmux openssl; do
  command -v "$cmd" >/dev/null || { printf 'Missing dependency: %s\n' "$cmd" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node >=22 required"); process.exit(1); }'
build_root="${PONTE_ANDROID_BUILD:-$PWD/.work/android-build}"
jdk="${PONTE_JDK:-$build_root/jdk/amazon-corretto-17.0.20.10.1-linux-x64}"
[[ -x "$jdk/bin/javac" && -x "$jdk/bin/java" ]] || { printf 'Set PONTE_JDK to an installed JDK17+. No bootstrap/download was started.\n' >&2; exit 1; }
export PONTE_JDK="$jdk"
if ((android_build)); then
  tools="${PONTE_ANDROID_TOOLS:-$build_root/build-tools/android-15}"
  platform="${PONTE_ANDROID_PLATFORM:-$build_root/platform/android-35/android.jar}"
  [[ -x "$tools/aapt2" && -f "$tools/lib/d8.jar" && -f "$platform" ]] || {
    printf 'Android SDK is missing. Provision it explicitly or set PONTE_ANDROID_TOOLS/PONTE_ANDROID_PLATFORM. No download was started.\n' >&2
    exit 1
  }
fi
npm test
./android/test.sh
if ((android_build)); then
  python3 android/tests/build_fixture_test.py
else
  printf 'Synthetic APK build not requested. Use --android-build for the former workflow full check.\n'
fi
