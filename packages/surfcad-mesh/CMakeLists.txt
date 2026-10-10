cmake_minimum_required(VERSION 3.20)
project(surfcad_mesh LANGUAGES C CXX)

# Separate module from packages/surfcad-fea. That crate is wasm-pack /
# wasm32-unknown-unknown. fTetWild needs libc++, exceptions, and Geogram's
# Emscripten platform, so it is built with emcc and loaded beside the solver.

if(NOT FTETWILD_DIR)
    message(FATAL_ERROR "FTETWILD_DIR is required (patched wildmeshing/fTetWild checkout)")
endif()
if(NOT TOMMATH_DIR)
    message(FATAL_ERROR "TOMMATH_DIR is required (libtommath checkout)")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(ENABLE_CCACHE OFF CACHE BOOL "" FORCE)

# fTetWild / libigl switches. TetGen is AGPL, Triangle's licence is not
# permissive, HLBFGS contains GPL, FPG vendors an LGPL CGAL subset.
#
# libigl 2.6 (the pin in fTetWild) dropped the LIBIGL_WITH_* names. The
# copyleft and restricted modules are LIBIGL_COPYLEFT_* and
# LIBIGL_RESTRICTED_*. Predicates stay on: that module is MPL-2.0 and
# ships Shewchuk's public-domain predicates. CoMISo is still an option
# in 2.6 even though the module file is gone; force it off anyway.
set(FLOAT_TETWILD_ENABLE_TBB OFF CACHE BOOL "" FORCE)
set(FLOAT_TETWILD_USE_FLOAT OFF CACHE BOOL "" FORCE)
set(FLOAT_TETWILD_WITH_SANITIZERS OFF CACHE BOOL "" FORCE)
set(FLOAT_TETWILD_WITH_EXACT_ENVELOPE OFF CACHE BOOL "" FORCE)
set(LIBIGL_COPYLEFT_CORE OFF CACHE BOOL "" FORCE)
set(LIBIGL_COPYLEFT_CGAL OFF CACHE BOOL "" FORCE)
set(LIBIGL_COPYLEFT_COMISO OFF CACHE BOOL "" FORCE)
set(LIBIGL_COPYLEFT_TETGEN OFF CACHE BOOL "" FORCE)
set(LIBIGL_RESTRICTED_MATLAB OFF CACHE BOOL "" FORCE)
set(LIBIGL_RESTRICTED_MOSEK OFF CACHE BOOL "" FORCE)
set(LIBIGL_RESTRICTED_TRIANGLE OFF CACHE BOOL "" FORCE)
set(LIBIGL_PREDICATES ON CACHE BOOL "" FORCE)
set(EIGEN_MPL2_ONLY ON CACHE BOOL "" FORCE)

set(GEOGRAM_WITH_GRAPHICS OFF CACHE BOOL "" FORCE)
set(GEOGRAM_WITH_LEGACY_NUMERICS OFF CACHE BOOL "" FORCE)
set(GEOGRAM_WITH_HLBFGS OFF CACHE BOOL "" FORCE)
set(GEOGRAM_WITH_TETGEN OFF CACHE BOOL "" FORCE)
set(GEOGRAM_WITH_TRIANGLE OFF CACHE BOOL "" FORCE)
set(GEOGRAM_WITH_LUA OFF CACHE BOOL "" FORCE)
set(GEOGRAM_WITH_FPG OFF CACHE BOOL "" FORCE)
set(GEOGRAM_WITH_EXPLORAGRAM OFF CACHE BOOL "" FORCE)
set(GEOGRAM_WITH_TBB OFF CACHE BOOL "" FORCE)
set(GEOGRAM_LIB_ONLY ON CACHE BOOL "" FORCE)
set(GEOGRAM_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(GEOGRAM_BUILD_STATIC ON CACHE BOOL "" FORCE)

set(FMT_INSTALL OFF CACHE BOOL "" FORCE)
set(FMT_DOC OFF CACHE BOOL "" FORCE)
set(FMT_TEST OFF CACHE BOOL "" FORCE)
set(FMT_OS OFF CACHE BOOL "" FORCE)
set(SPDLOG_FMT_EXTERNAL ON CACHE BOOL "" FORCE)
set(SPDLOG_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(SPDLOG_INSTALL OFF CACHE BOOL "" FORCE)

add_compile_definitions(EIGEN_MPL2_ONLY)

if(EMSCRIPTEN)
    # -msimd128 is the wasm simd switch. Do not pass -msse/-msse2: this clang
    # rejects the x86 intrinsic headers on wasm32, and both Eigen and libigl's
    # fast winding number include them when __SSE__ is set. api.cpp emits an
    # explicit simd128 op so the module still contains simd128.
    add_compile_options(-fexceptions -msimd128)
    add_link_options(-fexceptions -msimd128)
endif()

add_subdirectory("${TOMMATH_DIR}" "${CMAKE_BINARY_DIR}/libtommath" EXCLUDE_FROM_ALL)
add_subdirectory("${FTETWILD_DIR}" "${CMAKE_BINARY_DIR}/fTetWild" EXCLUDE_FROM_ALL)

target_link_libraries(FloatTetwild PUBLIC libtommath)
target_compile_definitions(FloatTetwild PUBLIC EIGEN_MPL2_ONLY)
if(EMSCRIPTEN)
    target_compile_definitions(FloatTetwild PUBLIC EIGEN_DONT_VECTORIZE)
endif()
target_compile_features(FloatTetwild PUBLIC cxx_std_17)
if(NOT EMSCRIPTEN AND TARGET geogram)
    # Geogram's Linux gcc platform compiles OpenMP into the static library.
    # gomp has to follow that archive. The wasm platform does not use OpenMP,
    # and this binary is the native self-test only.
    target_link_libraries(geogram PUBLIC gomp)
endif()

add_executable(surfcad_mesh src/api.cpp)
target_link_libraries(surfcad_mesh PRIVATE FloatTetwild)
target_compile_features(surfcad_mesh PRIVATE cxx_std_17)
target_compile_definitions(surfcad_mesh PRIVATE EIGEN_MPL2_ONLY)

if(EMSCRIPTEN)
    target_link_options(surfcad_mesh PRIVATE
        "-fexceptions"
        "-msimd128"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sINITIAL_MEMORY=67108864"
        "-sSTACK_SIZE=8388608"
        "-sENVIRONMENT=web,webview,worker,node"
        "-sMODULARIZE=1"
        "-sEXPORT_ES6=1"
        "-sEXPORT_NAME=createSurfcadMesh"
        "-sEXPORTED_FUNCTIONS=_surfcad_mesh_tet4,_surfcad_mesh_tet4_sized,_surfcad_mesh_free,_malloc,_free"
        "-sEXPORTED_RUNTIME_METHODS=getValue,UTF8ToString,HEAPU8,HEAPF64,HEAPU32"
        "-sFILESYSTEM=0"
        "-sNO_EXIT_RUNTIME=1"
        "-sINVOKE_RUN=0"
        "-sDISABLE_EXCEPTION_CATCHING=0"
        "-sALLOW_UNIMPLEMENTED_SYSCALLS=1"
        "-sERROR_ON_UNDEFINED_SYMBOLS=0"
    )
endif()
