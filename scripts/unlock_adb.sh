#!/usr/bin/env bash
# Unlocks an ADB-connected Android device using a numeric PIN.
#
# Usage: ./scripts/unlock_adb.sh [PIN]
# Defaults to PIN 3490 if not provided.
#
# Notes:
# - On some OEM skins (e.g. Vivo/FunTouch), synthetic touch taps on the
#   secure keyguard's PIN pad are ignored. Digits must be sent as key
#   events instead, which is what this script does.
# - Screenshots of the secure keyguard render blank due to FLAG_SECURE;
#   that's expected and not a sign of failure.

set -euo pipefail

PIN="${1:-3490}"

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

wakefulness="$(adb shell dumpsys power | grep -o 'mWakefulness=[A-Za-z]*' | cut -d= -f2)"
if [[ "$wakefulness" != "Awake" ]]; then
  echo "Waking device..."
  adb shell input keyevent KEYCODE_WAKEUP
  sleep 1
fi

showing="$(adb shell dumpsys window policy | grep -A1 'KeyguardStateMonitor' | grep -o 'mIsShowing=[a-z]*' | cut -d= -f2)"
if [[ "$showing" != "true" ]]; then
  echo "Device already unlocked."
  exit 0
fi

echo "Swiping up to reveal PIN entry..."
adb shell input swipe 540 2200 540 400 300
sleep 1

echo "Entering PIN..."
for ((i = 0; i < ${#PIN}; i++)); do
  digit="${PIN:$i:1}"
  adb shell input keyevent "$(keycode_for_digit "$digit")"
  sleep 0.3
done
adb shell input keyevent KEYCODE_ENTER
sleep 1

showing="$(adb shell dumpsys window policy | grep -A1 'KeyguardStateMonitor' | grep -o 'mIsShowing=[a-z]*' | cut -d= -f2)"
if [[ "$showing" == "false" ]]; then
  echo "Device unlocked."
else
  echo "Error: device still locked. Check PIN or swipe coordinates for this device." >&2
  exit 1
fi
