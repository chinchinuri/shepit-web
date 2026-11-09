# Replaces sherpa-onnx/wasm/asr/CMakeLists.txt for Shepit Web.
# Differences from upstream: no model baked into a .data file (models are
# downloaded and cached by the browser at run time), 4 GB address space for the
# ~660 MB Nemotron encoder, and the FS / WORKERFS APIs exposed to JavaScript.

if(NOT $ENV{SHERPA_ONNX_IS_USING_BUILD_WASM_SH})
  message(FATAL_ERROR "Please use scripts/build-wasm.sh")
endif()

set(exported_functions
  MyPrint
  SherpaOnnxCreateOnlineRecognizer
  SherpaOnnxCreateOnlineStream
  SherpaOnnxDecodeOnlineStream
  SherpaOnnxDestroyOnlineRecognizer
  SherpaOnnxDestroyOnlineRecognizerResult
  SherpaOnnxDestroyOnlineStream
  SherpaOnnxDestroyOnlineStreamResultJson
  SherpaOnnxGetOfflineStreamResultAsJson
  SherpaOnnxGetOnlineStreamResult
  SherpaOnnxGetOnlineStreamResultAsJson
  SherpaOnnxIsOnlineStreamReady
  SherpaOnnxOnlineStreamAcceptWaveform
  SherpaOnnxOnlineStreamGetOption
  SherpaOnnxOnlineStreamInputFinished
  SherpaOnnxOnlineStreamIsEndpoint
  SherpaOnnxOnlineStreamReset
  SherpaOnnxOnlineStreamSetOption
  SherpaOnnxOfflineStreamGetOption
  SherpaOnnxOfflineStreamSetOption
)
set(mangled_exported_functions)
foreach(x IN LISTS exported_functions)
  list(APPEND mangled_exported_functions "_${x}")
endforeach()
list(JOIN mangled_exported_functions "," all_exported_functions)

include_directories(${CMAKE_SOURCE_DIR})
set(MY_FLAGS " -s FORCE_FILESYSTEM=1 -s INITIAL_MEMORY=512MB -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB ")
string(APPEND MY_FLAGS " -sSTACK_SIZE=10485760 ")
string(APPEND MY_FLAGS " -lworkerfs.js -lnodefs.js ")
string(APPEND MY_FLAGS " -sEXPORTED_FUNCTIONS=[_CopyHeap,_malloc,_free,${all_exported_functions}] ")
string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','HEAPF64','FS'] ")

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${MY_FLAGS}")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${MY_FLAGS}")
set(CMAKE_EXECUTABLE_LINKER_FLAGS "${CMAKE_EXECUTABLE_LINKER_FLAGS} ${MY_FLAGS}")

add_executable(sherpa-onnx-wasm-main-asr sherpa-onnx-wasm-main-asr.cc)
target_link_libraries(sherpa-onnx-wasm-main-asr sherpa-onnx-c-api)
install(TARGETS sherpa-onnx-wasm-main-asr DESTINATION bin/wasm/asr)
install(
  FILES
    "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-asr>/sherpa-onnx-wasm-main-asr.js"
    "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-asr>/sherpa-onnx-wasm-main-asr.wasm"
    "sherpa-onnx-asr.js"
  DESTINATION
    bin/wasm/asr
)
