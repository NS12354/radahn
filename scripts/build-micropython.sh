#!/usr/bin/env bash
# Rebuilds public/firmware/micropython-rp2-pico-*.uf2 from source.
# Needs: git, cmake, arm-none-eabi-gcc + newlib + libstdc++ (apt: gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib)
set -euo pipefail
VER=${1:-v1.24.1}
cd "$(dirname "$0")/.."
W=$(mktemp -d)
git clone --depth 1 --branch "$VER" https://github.com/micropython/micropython.git "$W/micropython"
make -C "$W/micropython/mpy-cross" -j
make -C "$W/micropython/ports/rp2" BOARD=RPI_PICO submodules
make -C "$W/micropython/ports/rp2" BOARD=RPI_PICO -j
cp "$W/micropython/ports/rp2/build-RPI_PICO/firmware.uf2" "public/firmware/micropython-rp2-pico-$VER.uf2"
echo "Wrote public/firmware/micropython-rp2-pico-$VER.uf2 (update the filename in src/ui/elec.ts if the version changed)"
