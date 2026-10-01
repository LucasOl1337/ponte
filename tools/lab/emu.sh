#!/usr/bin/env bash
# Android emulator for the lab, rendered on the host GPU instead of SwiftShader.
#
# SwiftShader draws every guest frame on the CPU: with Chrome showing the
# Ponte stream at 1344x2992 it costs ~3.6 cores; on the host GPU the same
# scene costs ~0.6. On -gpu host the guest's MediaCodec frames come out solid
# green in Chrome/WebView, so both get --disable-accelerated-video-decode
# (Chrome decodes H.264 in software and the GPU only composites). The unit
# runs in the idle CPU class, so it only ever gets cycles nobody else wants.
#
#   tools/lab/emu.sh start          # boot AVD (default ponte-celular) in unit ponte-emu
#   tools/lab/emu.sh flags          # (re)write the Chrome/WebView flags on a running guest
#   tools/lab/emu.sh sleep|wake     # screen off/on: a hidden page stops the stream
#   tools/lab/emu.sh stop|status
set -euo pipefail
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.config/.android/avd}"
avd="${PONTE_EMU_AVD:-ponte-celular}"
unit="${PONTE_EMU_UNIT:-ponte-emu}"
port="${PONTE_EMU_PORT:-5554}"
gpu="${PONTE_EMU_GPU:-host}"
serial="emulator-$port"
adb() { command adb -s "$serial" "$@"; }

wait_boot() {
  for _ in $(seq 1 60); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && return 0
    timeout 3 tail -f /dev/null || true
  done
  echo "emu: $serial did not boot in 3 min" >&2; return 1
}

flags() {
  # adb root restarts adbd, which drops every adb reverse on this serial.
  adb root >/dev/null; adb wait-for-device
  local f='--disable-accelerated-video-decode --disable-fre --no-default-browser-check --no-first-run'
  adb shell "echo '_ $f' > /data/local/tmp/chrome-command-line; echo '_ $f' > /data/local/tmp/webview-command-line; chmod 644 /data/local/tmp/*-command-line"
  adb shell am set-debug-app --persistent com.android.chrome >/dev/null
  adb shell am force-stop com.android.chrome
}

case "${1:-status}" in
  start)
    systemctl --user is-active --quiet "$unit" && { echo "emu: $unit already running"; exit 0; }
    systemctl --user reset-failed "$unit" 2>/dev/null || true
    systemd-run --user --unit="$unit" -p CPUWeight=idle \
      -E ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT" -E ANDROID_AVD_HOME="$ANDROID_AVD_HOME" \
      "$ANDROID_SDK_ROOT/emulator/emulator" -avd "$avd" -port "$port" -no-window \
      -gpu "$gpu" -no-snapshot -no-audio -no-boot-anim
    wait_boot
    [ "$gpu" = host ] && flags
    echo "emu: $serial up on -gpu $gpu (unit $unit)"
    ;;
  flags) flags ;;
  sleep) adb shell input keyevent KEYCODE_SLEEP ;;
  wake) adb shell input keyevent KEYCODE_WAKEUP ;;
  stop) systemctl --user stop "$unit" ;;
  status)
    systemctl --user show "$unit" -p ActiveState -p CPUUsageNSec -p ExecStart --value | sed -n '1,2p'
    pgrep -af "qemu-system.*-avd $avd" | grep -o -- '-gpu [a-z_]*' || true
    ;;
  *) echo "usage: $0 start|flags|sleep|wake|stop|status" >&2; exit 2 ;;
esac
