#!/usr/bin/env bash
# Unlocks an ADB-connected Android device using a numeric PIN.
#
# Usage: ./scripts/unlock_adb.sh [PIN]
# Defaults to $ADB_UNLOCK_PIN, else 3490.
#
# Notes:
# - Screenshots of the secure keyguard render blank due to FLAG_SECURE, and
#   `uiautomator dump` returns a null root. There is no way to see the PIN
#   pad, so this script never taps digit keys: it sends them as key events.
# - Swipe coordinates are derived from `wm size` rather than hardcoded, so
#   the geometry follows the device instead of one particular phone.
# - The swipe that reveals the PIN pad must be SLOW. On motorola edge 50 neo
#   (Android 16) a 300ms swipe is treated as a fling and the bouncer never
#   appears; 800ms works. The script verifies the bouncer is actually up
#   before typing rather than assuming the swipe landed.
# - The PIN is checked with `cmd lock_settings verify` first, so a wrong PIN
#   is reported as such instead of looking like a broken swipe. Note that a
#   wrong PIN costs a real failed attempt, and the device throttles after a
#   few of them.

set -euo pipefail

PIN="${1:-${ADB_UNLOCK_PIN:-3490}}"

if ! [[ "$PIN" =~ ^[0-9]+$ ]]; then
  echo "Error: PIN must be numeric" >&2
  exit 1
fi

if ! adb devices | grep -qw "device$"; then
  echo "Error: no ADB device connected" >&2
  exit 1
fi

keycode_for_digit() {
  case "$1" in
    0) echo KEYCODE_0 ;;
    1) echo KEYCODE_1 ;;
    2) echo KEYCODE_2 ;;
    3) echo KEYCODE_3 ;;
    4) echo KEYCODE_4 ;;
    5) echo KEYCODE_5 ;;
    6) echo KEYCODE_6 ;;
    7) echo KEYCODE_7 ;;
    8) echo KEYCODE_8 ;;
    9) echo KEYCODE_9 ;;
  esac
}

keyguard_showing() {
  adb shell dumpsys window policy \
    | grep -A1 'KeyguardStateMonitor' \
    | grep -o 'mIsShowing=[a-z]*' \
    | head -1 | cut -d= -f2
}

bouncer_visible() {
  adb shell dumpsys activity service com.android.systemui/.SystemUIService 2>/dev/null \
    | grep -o 'mBouncerVisible=[a-z]*' \
    | head -1 | cut -d= -f2
}

wakefulness() {
  adb shell dumpsys power \
    | grep -o 'mWakefulness=[A-Za-z]*' \
    | head -1 | cut -d= -f2
}

# Use the override size when one is set (that is what input coordinates are
# scaled to) and the physical size otherwise.
read -r WIDTH HEIGHT < <(
  adb shell wm size \
    | sed -n 's/.*size: \([0-9]*\)x\([0-9]*\).*/\1 \2/p' \
    | tail -1
)
if [[ -z "${WIDTH:-}" || -z "${HEIGHT:-}" ]]; then
  echo "Error: could not read screen size from 'adb shell wm size'" >&2
  exit 1
fi

if [[ "$(keyguard_showing)" != "true" ]]; then
  echo "Device already unlocked."
  exit 0
fi

# Fail fast on a wrong PIN. A locked device that is merely asleep looks
# identical to one with the wrong PIN once the taps stop working.
verify="$(adb shell cmd lock_settings verify --old "$PIN" 2>&1 || true)"
case "$verify" in
  *"throttl"*)
    echo "Error: too many recent failed attempts; the device is throttling." >&2
    echo "Wait ~30s and retry." >&2
    exit 1
    ;;
  *"didn't match"*|*"does not match"*)
    echo "Error: PIN $PIN is not this device's lock credential." >&2
    exit 1
    ;;
esac

# The device parks in Dozing (AOD) rather than Asleep; touches land but the
# bouncer will not open until it is fully awake.
if [[ "$(wakefulness)" != "Awake" ]]; then
  echo "Waking device..."
  adb shell input keyevent KEYCODE_WAKEUP
  sleep 1
fi

swipe_x=$((WIDTH / 2))
swipe_from_y=$((HEIGHT * 3 / 4))
swipe_to_y=$((HEIGHT * 3 / 8))

if [[ "$(bouncer_visible)" != "true" ]]; then
  echo "Swiping up to reveal PIN entry (${WIDTH}x${HEIGHT})..."
  for attempt in 1 2 3; do
    adb shell input touchscreen swipe \
      "$swipe_x" "$swipe_from_y" "$swipe_x" "$swipe_to_y" 800
    sleep 1
    [[ "$(bouncer_visible)" == "true" ]] && break
    if [[ $attempt == 3 ]]; then
      echo "Error: PIN pad did not appear after 3 swipes." >&2
      exit 1
    fi
    adb shell input keyevent KEYCODE_WAKEUP
    sleep 1
  done
fi

echo "Entering PIN..."
for ((i = 0; i < ${#PIN}; i++)); do
  digit="${PIN:$i:1}"
  adb shell input keyevent "$(keycode_for_digit "$digit")"
  sleep 0.3
done
adb shell input keyevent KEYCODE_ENTER

# Keyguard dismissal is animated; poll rather than guessing a sleep.
for _ in $(seq 1 10); do
  sleep 0.5
  if [[ "$(keyguard_showing)" == "false" ]]; then
    echo "Device unlocked."
    exit 0
  fi
done

echo "Error: PIN verified but the keyguard did not dismiss." >&2
echo "The PIN pad may be ignoring injected key events on this device." >&2
exit 1
