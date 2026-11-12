#!/usr/bin/env bash
# Sets up the local Arduino compile path used by `npm run dev` (/api/compile).
#
# Preferred: arduino-cli (Homebrew core on macOS, or the official installer),
#   plus the Arduino AVR core and the libraries the example sketches use.
# Fallback (Linux without arduino-cli): avr-gcc + a vendored ArduinoCore-avr checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

install_cli_deps() {
  echo "Installing the Arduino AVR core and libraries (one-time download from Arduino)…"
  arduino-cli core update-index
  arduino-cli core install arduino:avr
  arduino-cli lib install "Adafruit NeoPixel" Servo
  echo "Done. Sketches compile with arduino-cli."
}

if command -v arduino-cli >/dev/null; then install_cli_deps; exit 0; fi

if command -v brew >/dev/null; then
  echo "Installing arduino-cli with Homebrew…"
  brew install arduino-cli
  install_cli_deps
  exit 0
fi

if command -v apt-get >/dev/null; then
  if ! command -v avr-gcc >/dev/null; then
    echo "Installing avr-gcc…"
    sudo apt-get install -y gcc-avr avr-libc binutils-avr
  fi
  mkdir -p vendor
  [ -d vendor/ArduinoCore-avr ] || git clone --depth 1 https://github.com/arduino/ArduinoCore-avr.git vendor/ArduinoCore-avr
  [ -d vendor/Adafruit_NeoPixel ] || git clone --depth 1 https://github.com/adafruit/Adafruit_NeoPixel.git vendor/Adafruit_NeoPixel
  echo "Done. Drop more Arduino libraries into vendor/ (each in its own folder)."
  exit 0
fi

echo "Install arduino-cli (https://arduino.github.io/arduino-cli/latest/installation/), then re-run: npm run setup:toolchain"
exit 1
