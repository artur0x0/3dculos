/**
 * Build the fTetWild volume mesher.
 *
 *   node scripts/fea/build-mesh-wasm.mjs
 *   node scripts/fea/build-mesh-wasm.mjs --native
 *   node scripts/fea/build-mesh-wasm.mjs --out-dir pkg-rebuild
 *
 * The wasm module is a separate emscripten build from packages/surfcad-fea.
 * surfcad-fea stays on wasm-pack / wasm32-unknown-unknown. fTetWild needs
 * libc++, exceptions, and Geogram's Emscripten platform.
 *
 * Shipped code is MPL-2.0 / BSD-3-Clause / MIT / Zlib / Unlicense / public
 * domain. TetGen (AGPL), Triangle, HLBFGS (GPL line search), FPG (LGPL),
 * and GMP (LGPL-3.0-or-later OR GPL-2.0-or-later) are not compiled. Exact
 * rationals use libtommath. See packages/surfcad-mesh/LICENSES.md.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EMSDK_VERSION = '6.0.12';
const PINS = {
  ftetwild: '8118f810478e0e65a7bf2d8cecdc5e203a876e97',
  geogramTag: 'v1.9.6',
  tommathTag: 'v1.3.0',
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const meshRoot = resolve(repoRoot, 'packages/surfcad-mesh');
const depsRoot = resolve(meshRoot, '.deps');
const pristineRoot = resolve(depsRoot, 'src');
const workRoot = resolve(depsRoot, 'work');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

const native = process.argv.includes('--native');
const outDirName = argValue('--out-dir') || 'pkg';
if (outDirName.includes('/') || outDirName.includes('\\') || outDirName === '.' || outDirName === '..') {
  throw new Error('--out-dir must be a single directory name inside packages/surfcad-mesh');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    const code = result.status === null ? 1 : result.status;
    throw new Error(`${command} ${args.join(' ')} failed (${code})`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) {
    throw new Error(`patch ${label} did not match the pinned sources`);
  }
  return text.replace(from, to);
}

function ensureCommit(dir, url, commit) {
  if (!existsSync(resolve(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    run('git', ['clone', '--filter=blob:none', url, dir]);
  }
  const head = capture('git', ['-C', dir, 'rev-parse', 'HEAD']);
  if (head !== commit) {
    run('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', commit]);
    run('git', ['-C', dir, 'checkout', '--force', 'FETCH_HEAD']);
  }
}

function ensureTag(dir, url, tag) {
  if (!existsSync(resolve(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    run('git', ['clone', '--depth', '1', '--branch', tag, url, dir]);
  }
  const head = capture('git', ['-C', dir, 'describe', '--tags', '--exact-match', 'HEAD']);
  if (head !== tag) {
    rmSync(dir, { recursive: true, force: true });
    run('git', ['clone', '--depth', '1', '--branch', tag, url, dir]);
  }
}

function ensureSources() {
  mkdirSync(pristineRoot, { recursive: true });
  ensureCommit(
    resolve(pristineRoot, 'fTetWild'),
    'https://github.com/wildmeshing/fTetWild.git',
    PINS.ftetwild,
  );
  ensureTag(
    resolve(pristineRoot, 'geogram'),
    'https://github.com/BrunoLevy/geogram.git',
    PINS.geogramTag,
  );
  run('git', [
    '-C', resolve(pristineRoot, 'geogram'),
    'submodule', 'update', '--init', '--depth', '1',
    'src/lib/geogram/third_party/amgcl',
    'src/lib/geogram/third_party/libMeshb',
    'src/lib/geogram/third_party/rply',
  ]);
  ensureTag(
    resolve(pristineRoot, 'libtommath'),
    'https://github.com/libtom/libtommath.git',
    PINS.tommathTag,
  );
}

function copyWork(name) {
  const from = resolve(pristineRoot, name);
  const to = resolve(workRoot, name);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  // cp is available on the CI image; rsync is not.
  run('cp', ['-a', `${from}/.`, to]);
  rmSync(resolve(to, '.git'), { recursive: true, force: true });
  return to;
}

function patchFtetwild(dir) {
  const cmakePath = resolve(dir, 'CMakeLists.txt');
  let cmake = readFileSync(cmakePath, 'utf8');
  cmake = mustReplace(
    cmake,
    'set(CMAKE_CXX_STANDARD 14)',
    'set(CMAKE_CXX_STANDARD 17)',
    'cxx standard',
  );
  cmake = mustReplace(cmake, 'cxx_std_14', 'cxx_std_17', 'cxx feature');
  cmake = mustReplace(
    cmake,
    `find_package(GMPfTetWild)
if(NOT \${GMP_FOUND})
    message(FATAL_ERROR "Cannot find GMP")
endif()`,
    `# GMP is LGPL-3.0-or-later OR GPL-2.0-or-later and is not linked.
# Exact rationals are libtommath (Unlicense), attached by the parent project.`,
    'gmp find',
  );
  cmake = mustReplace(
    cmake,
    'target_include_directories(${PROJECT_NAME} SYSTEM PUBLIC ${GMP_INCLUDE_DIRS})\n\n',
    '',
    'gmp include',
  );
  cmake = mustReplace(
    cmake,
    '         ${GMP_LIBRARIES}\n',
    '',
    'gmp link',
  );
  writeFileSync(cmakePath, cmake);

  const depsPath = resolve(dir, 'cmake/FloatTetwildDependencies.cmake');
  let deps = readFileSync(depsPath, 'utf8');
  deps = mustReplace(
    deps,
    `    if(MSVC)
        set(GEO_PLATFORM "Win-vs-generic")
    elseif(CMAKE_SYSTEM_NAME MATCHES "Darwin")
        set(GEO_PLATFORM "Darwin-clang")
    else()
        set(GEO_PLATFORM "Linux64-gcc")
    endif()`,
    `    if(EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
        set(GEO_PLATFORM "Emscripten-clang")
    elseif(MSVC)
        set(GEO_PLATFORM "Win-vs-generic")
    elseif(CMAKE_SYSTEM_NAME MATCHES "Darwin")
        set(GEO_PLATFORM "Darwin-clang")
    else()
        set(GEO_PLATFORM "Linux64-gcc")
    endif()`,
    'geogram platform',
  );
  deps = mustReplace(
    deps,
    '    set(GEOGRAM_WITH_TRIANGLE OFF CACHE BOOL "Disable triangle" FORCE)\n',
    `    set(GEOGRAM_WITH_TRIANGLE OFF CACHE BOOL "Disable triangle" FORCE)
    set(GEOGRAM_WITH_TETGEN OFF CACHE BOOL "Disable TetGen (AGPL)" FORCE)
    set(GEOGRAM_WITH_HLBFGS OFF CACHE BOOL "Disable HLBFGS (GPL line search)" FORCE)
    set(GEOGRAM_WITH_FPG OFF CACHE BOOL "Disable FPG (LGPL)" FORCE)
`,
    'forbidden geogram options',
  );
  writeFileSync(depsPath, deps);

  const geogramCmake = resolve(dir, 'cmake/geogram.cmake');
  let geo = readFileSync(geogramCmake, 'utf8');
  const start = geo.indexOf('target_include_directories(geogram SYSTEM PUBLIC ${GEOGRAM_SOURCE_INCLUDE_DIR})');
  const end = geo.indexOf('if(${CMAKE_SYSTEM_NAME} MATCHES "Windows")', start);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('patch geogram.cmake anchors missing');
  }
  const replacement = `if(GEOGRAM_SOURCE_INCLUDE_DIR)
	target_include_directories(geogram SYSTEM PUBLIC \${GEOGRAM_SOURCE_INCLUDE_DIR})
endif()

# No OpenMP. Upstream forces -fopenmp on Linux, which pulls a shared runtime.
if(NOT TARGET geogram::geogram)
	add_library(geogram::geogram ALIAS geogram)
endif()

`;
  geo = geo.slice(0, start) + replacement + geo.slice(end);
  writeFileSync(geogramCmake, geo);

  cpSync(resolve(repoRoot, 'scripts/fea/overlay/Rational.h'), resolve(dir, 'src/external/Rational.h'));
  cpSync(resolve(repoRoot, 'scripts/fea/overlay/Logger.cpp'), resolve(dir, 'src/Logger.cpp'));

  const insertionPath = resolve(dir, 'src/TriangleInsertion.cpp');
  let insertion = readFileSync(insertionPath, 'utf8');
  insertion = mustReplace(
    insertion,
    `#include <oneapi/tbb.h>
#include <oneapi/tbb/parallel_for.h>
`,
    `// TBB is off. The parallel bodies below are already under FLOAT_TETWILD_USE_TBB.
#ifdef FLOAT_TETWILD_USE_TBB
#include <oneapi/tbb.h>
#include <oneapi/tbb/parallel_for.h>
#endif
`,
    'triangle insertion tbb',
  );
  writeFileSync(insertionPath, insertion);

  const improvePath = resolve(dir, 'src/MeshImprovement.cpp');
  let improve = readFileSync(improvePath, 'utf8');
  improve = mustReplace(
    improve,
    'igl::writeSTL(mesh.params.output_path + "_" + mesh.params.postfix + "_tracked_surface.stl", V_sf, F_sf);',
    '// The wasm module has no filesystem. Skip the tracked-surface STL dump.',
    'tracked surface stl',
  );
  writeFileSync(improvePath, improve);
}

function patchGeogramEmscripten(dir) {
  const path = resolve(dir, 'cmake/platforms/Emscripten-clang.cmake');
  let text = readFileSync(path, 'utf8');
  const toolchainStart = text.indexOf('find_path(EMSCRIPTEN_DIR');
  const toolchainEnd = text.indexOf('include(${EMSCRIPTEN_DIR}/cmake/Modules/Platform/Emscripten.cmake)');
  if (toolchainStart < 0 || toolchainEnd < 0) {
    throw new Error('patch Emscripten-clang.cmake toolchain block missing');
  }
  const toolchainMarker = 'include(${EMSCRIPTEN_DIR}/cmake/Modules/Platform/Emscripten.cmake)';
  text = `${text.slice(0, toolchainStart)}# emcmake already selected the toolchain. Geogram's pre-upstream\n# Emscripten platform file resets the compilers and is not included.\nset(CMAKE_SKIP_RPATH TRUE)\n${text.slice(toolchainEnd + toolchainMarker.length)}`;
  const start = text.indexOf('set(EM_COMMON_FLAGS');
  const end = text.indexOf('set(EM_FLAGS_RELEASE');
  if (start < 0 || end < 0) throw new Error('patch Emscripten-clang.cmake flags missing');
  text = `${text.slice(0, start)}set(EM_COMMON_FLAGS)\n${text.slice(end)}`;
  text = mustReplace(text, 'add_definitions(${FULL_WARNINGS})', 'add_definitions(${NORMAL_WARNINGS})', 'emscripten warnings');
  text = mustReplace(
    text,
    'add_flags(CMAKE_EXE_LINKER_FLAGS ${EM_COMMON_FLAGS} -lnodefs.js)',
    'add_flags(CMAKE_EXE_LINKER_FLAGS ${EM_COMMON_FLAGS})',
    'nodefs',
  );
  writeFileSync(path, text);

  const intervalPath = resolve(dir, 'src/lib/geogram/numerics/interval_nt.h');
  let interval = readFileSync(intervalPath, 'utf8');
  interval = mustReplace(
    interval,
    `#ifdef __SSE__
#include <xmmintrin.h>
#else
#include <fenv.h>
#endif`,
    `// wasm has no SSE rounding-mode register. emscripten still provides fesetround.
#if defined(__EMSCRIPTEN__)
#include <fenv.h>
#elif defined(__SSE__)
#include <xmmintrin.h>
#else
#include <fenv.h>
#endif`,
    'interval include',
  );
  interval = mustReplace(
    interval,
    `        static void set_FPU_round_to_nearest() {
#ifdef __SSE__
            _MM_SET_ROUNDING_MODE(_MM_ROUND_NEAREST);
#else
            fesetround(FE_TONEAREST);
#endif
        }

        static void set_FPU_round_to_upper() {
#ifdef __SSE__
            _MM_SET_ROUNDING_MODE(_MM_ROUND_UP);
#else
            fesetround(FE_UPWARD);
#endif
        }`,
    `        static void set_FPU_round_to_nearest() {
#if defined(__EMSCRIPTEN__) || !defined(__SSE__)
            fesetround(FE_TONEAREST);
#else
            _MM_SET_ROUNDING_MODE(_MM_ROUND_NEAREST);
#endif
        }

        static void set_FPU_round_to_upper() {
#if defined(__EMSCRIPTEN__) || !defined(__SSE__)
            fesetround(FE_UPWARD);
#else
            _MM_SET_ROUNDING_MODE(_MM_ROUND_UP);
#endif
        }`,
    'interval rounding',
  );
  writeFileSync(intervalPath, interval);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, name.name);
    if (name.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

// libigl 2.6 module switches. Copyleft is GPL-family; restricted pulls in
// a non-commercial or proprietary dependency (Triangle, MATLAB, MOSEK).
const LIBIGL_FORBIDDEN_OFF = [
  'LIBIGL_COPYLEFT_CORE',
  'LIBIGL_COPYLEFT_CGAL',
  'LIBIGL_COPYLEFT_COMISO',
  'LIBIGL_COPYLEFT_TETGEN',
  'LIBIGL_RESTRICTED_MATLAB',
  'LIBIGL_RESTRICTED_MOSEK',
  'LIBIGL_RESTRICTED_TRIANGLE',
];

function forbiddenMeshHit(text) {
  const norm = text.replace(/\\/g, '/');
  if (/igl[_-](?:copyleft|restricted)/i.test(norm)) return 'libigl copyleft or restricted module';
  // "triangulation" is not Triangle. Require a token boundary.
  if (/(?:^|[^A-Za-z0-9_])tetgen(?:[^A-Za-z0-9_]|$)/i.test(norm)) return 'TetGen';
  if (/(?:^|[^A-Za-z0-9_])triangle(?:[^A-Za-z0-9_]|$)/i.test(norm)) return 'Triangle';
  return '';
}

function forbiddenBuildArtifact(path) {
  const norm = path.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (/\/(?:igl[_-]copyleft|igl[_-]restricted)/i.test(norm)) return 'libigl copyleft or restricted module';
  if (/\/(?:tetgen|triangle)\.dir\//i.test(norm)) return 'TetGen or Triangle object directory';
  const sourceOrObject = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|o|obj|a|lib)$/i.test(base);
  if (!sourceOrObject) return '';
  if (/^(?:lib)?(?:tetgen|triangle)\./i.test(base)) return base;
  if (/(?:^|\/)(?:tetgen|triangle)(?:\/|$)/i.test(norm)) return base;
  if (/(?:^|\/)igl\/(?:copyleft|triangle)(?:\/|$)/i.test(norm)) return base;
  return '';
}

function assertLicenseConfig(buildDir) {
  const cachePath = resolve(buildDir, 'CMakeCache.txt');
  const cache = readFileSync(cachePath, 'utf8');
  const required = [
    'GEOGRAM_WITH_TETGEN:BOOL=OFF',
    'GEOGRAM_WITH_TRIANGLE:BOOL=OFF',
    'GEOGRAM_WITH_HLBFGS:BOOL=OFF',
    'GEOGRAM_WITH_FPG:BOOL=OFF',
    'FLOAT_TETWILD_ENABLE_TBB:BOOL=OFF',
    'FLOAT_TETWILD_WITH_EXACT_ENVELOPE:BOOL=OFF',
    'LIBIGL_PREDICATES:BOOL=ON',
    ...LIBIGL_FORBIDDEN_OFF.map((name) => `${name}:BOOL=OFF`),
  ];
  for (const line of required) {
    if (!cache.includes(line)) {
      throw new Error(`licence config missing ${line}`);
    }
  }
  for (const name of LIBIGL_FORBIDDEN_OFF) {
    if (new RegExp(`${name}:BOOL=ON`).test(cache)) {
      throw new Error(`${name} is ON in ${cachePath}`);
    }
  }
  const linkFiles = walk(buildDir).filter((path) => path.endsWith('link.txt') || path.endsWith('linkLibs.rsp'));
  const forbiddenLink = [/libgmp/, /libmpfr/, /hlbfgs/i];
  for (const path of linkFiles) {
    const text = readFileSync(path, 'utf8');
    for (const pattern of forbiddenLink) {
      if (pattern.test(text)) {
        throw new Error(`${path} links a forbidden library (${pattern})`);
      }
    }
    const hit = forbiddenMeshHit(text);
    if (hit) throw new Error(`${path} links a forbidden library (${hit})`);
  }
  for (const path of walk(buildDir)) {
    const hit = forbiddenBuildArtifact(path);
    if (hit) throw new Error(`${path} is a TetGen or Triangle build artifact (${hit})`);
  }
  const commandsPath = resolve(buildDir, 'compile_commands.json');
  if (existsSync(commandsPath)) {
    const commands = readFileSync(commandsPath, 'utf8');
    if (!commands.includes('EIGEN_MPL2_ONLY')) {
      throw new Error('EIGEN_MPL2_ONLY is not in compile_commands.json');
    }
    if (commands.includes('FLOAT_TETWILD_USE_TBB')) {
      throw new Error('TBB compile definition leaked into the mesh build');
    }
    let entries;
    try {
      entries = JSON.parse(commands);
    } catch (err) {
      throw new Error(`compile_commands.json is not JSON (${err.message})`);
    }
    for (const entry of entries) {
      const file = String(entry.file || '');
      const hit = forbiddenBuildArtifact(file) || forbiddenMeshHit(file);
      if (hit) {
        throw new Error(`compile_commands.json compiles a forbidden source: ${file} (${hit})`);
      }
    }
  }
}

function emsdkRoot() {
  if (process.env.EMSDK && existsSync(resolve(process.env.EMSDK, 'emsdk.py'))) {
    return process.env.EMSDK;
  }
  const local = resolve(depsRoot, 'emsdk');
  if (existsSync(resolve(local, 'emsdk.py'))) return local;
  const home = resolve(homedir(), 'emsdk');
  if (existsSync(resolve(home, 'emsdk.py'))) return home;
  return local;
}

function ensureEmsdk() {
  const root = emsdkRoot();
  if (!existsSync(resolve(root, 'emsdk.py'))) {
    mkdirSync(dirname(root), { recursive: true });
    run('git', ['clone', '--depth', '1', '--branch', EMSDK_VERSION, 'https://github.com/emscripten-core/emsdk.git', root]);
  }
  const envScript = resolve(root, 'emsdk_env.sh');
  if (!existsSync(resolve(root, 'upstream/emscripten/emcc'))) {
    run(resolve(root, 'emsdk'), ['install', EMSDK_VERSION], { cwd: root });
    run(resolve(root, 'emsdk'), ['activate', EMSDK_VERSION], { cwd: root });
  }
  if (!existsSync(envScript)) throw new Error(`emsdk env script missing at ${envScript}`);
  return { root, envScript };
}

function cmakeEnv(extra = {}) {
  const env = {
    ...process.env,
    SOURCE_DATE_EPOCH: '0',
    ...extra,
  };
  delete env.CCACHE_DIR;
  return env;
}

function configureAndBuild(buildDir, ftetwildDir, geogramDir, tommathDir, emscripten) {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  // Native and wasm must not share a FetchContent build tree: Geogram's
  // platform file (Linux64-gcc vs Emscripten-clang) is chosen at configure.
  const fetchDir = resolve(depsRoot, emscripten ? 'fetch-wasm' : 'fetch');
  mkdirSync(fetchDir, { recursive: true });
  const cmakeArgs = [
    '-S', meshRoot,
    '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DFTETWILD_DIR=${ftetwildDir}`,
    `-DTOMMATH_DIR=${tommathDir}`,
    `-DFETCHCONTENT_SOURCE_DIR_GEOGRAM=${geogramDir}`,
    `-DFETCHCONTENT_BASE_DIR=${fetchDir}`,
  ];
  const prefix = [
    `-ffile-prefix-map=${depsRoot}=/deps`,
    `-ffile-prefix-map=${meshRoot}=/surfcad-mesh`,
    `-ffile-prefix-map=${repoRoot}=/repo`,
  ].join(' ');
  const env = cmakeEnv({
    CFLAGS: prefix,
    CXXFLAGS: prefix,
  });
  if (emscripten) {
    const { envScript } = ensureEmsdk();
    const command = [
      'set -euo pipefail',
      `source ${JSON.stringify(envScript)}`,
      `export SOURCE_DATE_EPOCH=0`,
      `export CFLAGS=${JSON.stringify(prefix)}`,
      `export CXXFLAGS=${JSON.stringify(prefix)}`,
      `emcmake cmake ${cmakeArgs.map((arg) => JSON.stringify(arg)).join(' ')}`,
      `cmake --build ${JSON.stringify(buildDir)} -j2 --target surfcad_mesh`,
    ].join('\n');
    run('bash', ['-lc', command], { env, cwd: repoRoot });
  } else {
    // /usr/bin/c++ on this image is clang, which does not search gcc's
    // libstdc++. Pin the native toolchain to gcc so the self-test links.
    const nativeArgs = [
      ...cmakeArgs,
      '-DCMAKE_C_COMPILER=/usr/bin/gcc',
      '-DCMAKE_CXX_COMPILER=/usr/bin/g++',
    ];
    run('cmake', nativeArgs, { env, cwd: repoRoot });
    run('cmake', ['--build', buildDir, '-j2', '--target', 'surfcad_mesh'], { env, cwd: repoRoot });
  }
  assertLicenseConfig(buildDir);
}

function hardenGlue(text) {
  // FILESYSTEM=0 still routes fopen/fprintf through fd_write. fd 0 is stored
  // as null and a write crashes the page. Keep a buffer for every fd.
  return mustReplace(
    text,
    'printCharBuffers=[null,[],[]];var printChar=(stream,curr)=>{var buffer=printCharBuffers[stream];',
    'printCharBuffers=[[],[],[]];var printChar=(stream,curr)=>{var buffer=printCharBuffers[stream]||(printCharBuffers[stream]=[]);',
    'printChar buffers',
  );
}

function findArtifact(buildDir, name) {
  const hits = walk(buildDir).filter((path) => path.endsWith(`/${name}`));
  if (hits.length === 0) throw new Error(`missing ${name} under ${buildDir}`);
  hits.sort((a, b) => a.length - b.length);
  return hits[0];
}

ensureSources();
const ftetwildDir = copyWork('fTetWild');
const geogramDir = copyWork('geogram');
const tommathDir = copyWork('libtommath');
patchFtetwild(ftetwildDir);
if (!native) patchGeogramEmscripten(geogramDir);

const buildDir = resolve(meshRoot, native ? 'build-native' : 'build-wasm');
configureAndBuild(buildDir, ftetwildDir, geogramDir, tommathDir, !native);

if (native) {
  const binary = findArtifact(buildDir, 'surfcad_mesh');
  run(binary, ['--self-test']);
  console.log(`native mesher: ${binary}`);
} else {
  const outDir = resolve(meshRoot, outDirName);
  mkdirSync(outDir, { recursive: true });
  for (const name of ['surfcad_mesh.js', 'surfcad_mesh.wasm']) {
    cpSync(findArtifact(buildDir, name), resolve(outDir, name));
  }
  const gluePath = resolve(outDir, 'surfcad_mesh.js');
  writeFileSync(gluePath, hardenGlue(readFileSync(gluePath, 'utf8')));
  const wasm = readFileSync(resolve(outDir, 'surfcad_mesh.wasm'));
  const gzip = spawnSync('gzip', ['-c', '-n', resolve(outDir, 'surfcad_mesh.wasm')], { encoding: 'buffer' });
  if (gzip.status !== 0) throw new Error('gzip failed');
  console.log(`surfcad-mesh wasm: ${outDir}`);
  console.log(`  surfcad_mesh.wasm ${wasm.length} bytes, gzip ${gzip.stdout.length} bytes`);
}
