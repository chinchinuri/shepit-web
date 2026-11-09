#!/usr/bin/env bash
# Builds the sherpa-onnx streaming-ASR WebAssembly module used by Shepit Web.
# Needs emsdk 4.0.23 activated (emcc on PATH). Output goes to web/engine/.
set -euo pipefail

SHERPA_VERSION="${SHERPA_VERSION:-v2.0.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$ROOT/.build}"

mkdir -p "$WORK"
if [ ! -d "$WORK/sherpa-onnx" ]; then
  git clone -q --depth 1 --branch "$SHERPA_VERSION" https://github.com/k2-fsa/sherpa-onnx "$WORK/sherpa-onnx"
fi
cp "$ROOT/wasm/CMakeLists.txt" "$WORK/sherpa-onnx/wasm/asr/CMakeLists.txt"

cd "$WORK/sherpa-onnx"
EMSCRIPTEN=$(dirname "$(realpath "$(which emcc)")")
export EMSCRIPTEN
export SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON

mkdir -p build-wasm-simd-asr
cd build-wasm-simd-asr
cmake \
  -DCMAKE_INSTALL_PREFIX=./install \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake" \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_WASM_ASR=ON \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF \
  ..
make -j"$(nproc)"
make install

mkdir -p "$ROOT/web/engine"
cp install/bin/wasm/asr/sherpa-onnx-wasm-main-asr.js \
   install/bin/wasm/asr/sherpa-onnx-wasm-main-asr.wasm \
   install/bin/wasm/asr/sherpa-onnx-asr.js \
   "$ROOT/web/engine/"
ls -lh "$ROOT/web/engine"
