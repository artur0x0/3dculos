// C ABI around floatTetWild::tetrahedralization.
//
// Returns a packed TET4 blob. The JS layer upgrades it to TET10, snaps
// mid-edge nodes onto the input surface, and copies face ids onto the
// boundary. The wasm module stays single-threaded: no pthreads, no TBB.

#include <floattetwild/FloatTetwild.h>
#include <floattetwild/Logger.hpp>

#include <geogram/basic/common.h>
#include <geogram/basic/logger.h>
#include <geogram/basic/process.h>
#include <geogram/mesh/mesh.h>

#include <Eigen/Dense>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <exception>
#include <iostream>
#include <string>
#include <vector>

#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

namespace {

enum Status : int32_t {
    kOk = 0,
    kBadInput = 1,
    kMeshFailed = 2,
    kTooManyTets = 3,
    kInternal = 4,
};

struct NullBuf : std::streambuf {
    int overflow(int character) override
    {
        return character;
    }
};

struct SilenceStreams {
    NullBuf buffer;
    std::streambuf* cout_buf;
    std::streambuf* cerr_buf;

    SilenceStreams()
        : cout_buf(std::cout.rdbuf(&buffer))
        , cerr_buf(std::cerr.rdbuf(&buffer))
    {
    }

    ~SilenceStreams()
    {
        std::cout.rdbuf(cout_buf);
        std::cerr.rdbuf(cerr_buf);
    }
};

void ensure_geogram()
{
    static bool ready = false;
    if (ready) {
        return;
    }
    GEO::initialize();
    GEO::Logger::instance()->unregister_all_clients();
    GEO::Logger::instance()->set_quiet(true);
    GEO::Process::enable_multithreading(false);
    GEO::Process::set_max_threads(1);
    floatTetWild::Logger::init(false);
    ready = true;
}

void append_bytes(std::vector<uint8_t>& out, const void* data, size_t size)
{
    const auto* bytes = static_cast<const uint8_t*>(data);
    out.insert(out.end(), bytes, bytes + size);
}

void append_u32(std::vector<uint8_t>& out, uint32_t value)
{
    append_bytes(out, &value, sizeof(value));
}

void append_i32(std::vector<uint8_t>& out, int32_t value)
{
    append_bytes(out, &value, sizeof(value));
}

void append_f64(std::vector<uint8_t>& out, double value)
{
    append_bytes(out, &value, sizeof(value));
}

std::vector<uint8_t> pack_blob(
    int32_t status,
    const std::string& message,
    double seconds,
    const double* positions,
    uint32_t n_vertices,
    const uint32_t* tets,
    uint32_t n_tets)
{
    std::vector<uint8_t> out;
    out.reserve(32 + message.size() + static_cast<size_t>(n_vertices) * 24 + static_cast<size_t>(n_tets) * 16);
    append_i32(out, status);
    append_u32(out, n_vertices);
    append_u32(out, n_tets);
    append_u32(out, static_cast<uint32_t>(message.size()));
    append_f64(out, seconds);
    append_bytes(out, message.data(), message.size());
    while ((out.size() & 7U) != 0U) {
        out.push_back(0);
    }
    if (n_vertices > 0 && positions != nullptr) {
        append_bytes(out, positions, static_cast<size_t>(n_vertices) * 3 * sizeof(double));
    }
    if (n_tets > 0 && tets != nullptr) {
        append_bytes(out, tets, static_cast<size_t>(n_tets) * 4 * sizeof(uint32_t));
    }
    return out;
}

uint8_t* publish(std::vector<uint8_t> blob, uint32_t* out_bytes)
{
    auto* memory = static_cast<uint8_t*>(std::malloc(blob.size()));
    if (memory == nullptr) {
        return nullptr;
    }
    std::memcpy(memory, blob.data(), blob.size());
    if (out_bytes != nullptr) {
        *out_bytes = static_cast<uint32_t>(blob.size());
    }
    return memory;
}

bool finite_coord(double value)
{
    return std::isfinite(value);
}

}  // namespace

extern "C" {

#if defined(__wasm_simd128__)
float surfcad_mesh_simd_unit();
#endif

// Packed little-endian blob:
//   int32  status
//   uint32 nVertices
//   uint32 nTets
//   uint32 messageLen
//   double seconds
//   char   message[messageLen] padded to 8 bytes
//   double positions[nVertices * 3]
//   uint32 tets[nTets * 4]
uint8_t* surfcad_mesh_tet4(
    const double* positions,
    uint32_t n_vertices,
    const uint32_t* indices,
    uint32_t n_triangles,
    double edge_length,
    double epsilon,
    uint32_t max_tets,
    uint32_t* out_bytes)
{
    try {
        if (out_bytes != nullptr) {
            *out_bytes = 0;
        }
#if defined(__wasm_simd128__)
        if (surfcad_mesh_simd_unit() != 1.0f) {
            return publish(pack_blob(kInternal, "simd128 unit lane was not 1", 0, nullptr, 0, nullptr, 0), out_bytes);
        }
#endif
        if (positions == nullptr || indices == nullptr || n_vertices < 4 || n_triangles < 4) {
            return publish(pack_blob(kBadInput, "positions and indices must describe a closed triangle mesh", 0, nullptr, 0, nullptr, 0), out_bytes);
        }
        for (uint32_t i = 0; i < n_vertices * 3; ++i) {
            if (!finite_coord(positions[i])) {
                return publish(pack_blob(kBadInput, "positions contain a non-finite coordinate", 0, nullptr, 0, nullptr, 0), out_bytes);
            }
        }
        for (uint32_t i = 0; i < n_triangles * 3; ++i) {
            if (indices[i] >= n_vertices) {
                return publish(pack_blob(kBadInput, "indices reference a vertex outside positions", 0, nullptr, 0, nullptr, 0), out_bytes);
            }
        }
        if (!(edge_length >= 0.0) || !std::isfinite(edge_length) || !(epsilon >= 0.0) || !std::isfinite(epsilon)) {
            return publish(pack_blob(kBadInput, "edgeLength and epsilon must be finite and non-negative", 0, nullptr, 0, nullptr, 0), out_bytes);
        }

        ensure_geogram();
        SilenceStreams silence;

        GEO::Mesh surface;
        surface.vertices.create_vertices(n_vertices);
        for (uint32_t i = 0; i < n_vertices; ++i) {
            double* point = surface.vertices.point_ptr(i);
            point[0] = positions[i * 3];
            point[1] = positions[i * 3 + 1];
            point[2] = positions[i * 3 + 2];
        }
        for (uint32_t i = 0; i < n_triangles; ++i) {
            surface.facets.create_triangle(indices[i * 3], indices[i * 3 + 1], indices[i * 3 + 2]);
        }

        floatTetWild::Parameters params;
        params.is_quiet = true;
        params.log_level = 6;
        params.num_threads = 1;
        params.correct_surface_orientation = true;
        if (edge_length > 0.0) {
            params.ideal_edge_length_abs = edge_length;
        }
        if (epsilon > 0.0) {
            params.eps_rel = epsilon;
        }

        Eigen::MatrixXd vertices;
        Eigen::MatrixXi tets;
        const int code = floatTetWild::tetrahedralization(surface, params, vertices, tets, -1, false);

        if (code != 0 || vertices.rows() == 0 || tets.rows() == 0) {
            return publish(pack_blob(kMeshFailed, "fTetWild did not return a volume mesh", 0, nullptr, 0, nullptr, 0), out_bytes);
        }
        if (max_tets > 0 && static_cast<uint32_t>(tets.rows()) > max_tets) {
            return publish(
                pack_blob(kTooManyTets, "mesh exceeded maxTets; increase edgeLength", 0, nullptr, 0, nullptr, 0),
                out_bytes);
        }

        std::vector<double> flat_positions(static_cast<size_t>(vertices.rows()) * 3);
        for (Eigen::Index i = 0; i < vertices.rows(); ++i) {
            flat_positions[static_cast<size_t>(i) * 3] = vertices(i, 0);
            flat_positions[static_cast<size_t>(i) * 3 + 1] = vertices(i, 1);
            flat_positions[static_cast<size_t>(i) * 3 + 2] = vertices(i, 2);
        }
        std::vector<uint32_t> flat_tets(static_cast<size_t>(tets.rows()) * 4);
        for (Eigen::Index i = 0; i < tets.rows(); ++i) {
            for (int k = 0; k < 4; ++k) {
                const int index = tets(i, k);
                if (index < 0 || index >= vertices.rows()) {
                    return publish(pack_blob(kInternal, "fTetWild tet index is outside the vertex list", 0, nullptr, 0, nullptr, 0), out_bytes);
                }
                flat_tets[static_cast<size_t>(i) * 4 + static_cast<size_t>(k)] = static_cast<uint32_t>(index);
            }
        }
        return publish(
            pack_blob(
                kOk,
                "",
                0.0,
                flat_positions.data(),
                static_cast<uint32_t>(vertices.rows()),
                flat_tets.data(),
                static_cast<uint32_t>(tets.rows())),
            out_bytes);
    } catch (const std::exception& error) {
        return publish(pack_blob(kInternal, error.what(), 0, nullptr, 0, nullptr, 0), out_bytes);
    } catch (...) {
        return publish(pack_blob(kInternal, "unknown fTetWild failure", 0, nullptr, 0, nullptr, 0), out_bytes);
    }
}

void surfcad_mesh_free(void* memory)
{
    std::free(memory);
}

// One simd128 add, so the module contains a simd opcode even if the
// compiler does not vectorise Geogram on this target. The lane is 1.
#if defined(__wasm_simd128__)
__attribute__((used)) float surfcad_mesh_simd_unit()
{
    const v128_t sum = wasm_f32x4_add(wasm_f32x4_splat(1.0f), wasm_f32x4_splat(0.0f));
    return wasm_f32x4_extract_lane(sum, 0);
}
#endif

}  // extern "C"

#ifndef __EMSCRIPTEN__

static int self_test()
{
    const double positions[] = {
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    };
    const uint32_t indices[] = {
        0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
        3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    };
    uint32_t bytes = 0;
    uint8_t* blob = surfcad_mesh_tet4(positions, 8, indices, 12, 0.5, 1e-3, 20000, &bytes);
    if (blob == nullptr || bytes < 24) {
        std::cerr << "self-test: empty blob\n";
        return 1;
    }
    int32_t status = 0;
    uint32_t n_vertices = 0;
    uint32_t n_tets = 0;
    std::memcpy(&status, blob, 4);
    std::memcpy(&n_vertices, blob + 4, 4);
    std::memcpy(&n_tets, blob + 8, 4);
    uint32_t message_len = 0;
    std::memcpy(&message_len, blob + 12, 4);
    std::string message;
    if (message_len > 0 && 24 + message_len <= bytes) {
        message.assign(reinterpret_cast<char*>(blob + 24), message_len);
    }
    std::cout << "self-test status=" << status << " vertices=" << n_vertices << " tets=" << n_tets;
    if (!message.empty()) {
        std::cout << " message=" << message;
    }
    std::cout << "\n";
    surfcad_mesh_free(blob);
    return status == 0 && n_tets > 0 ? 0 : 1;
}

int main(int argc, char** argv)
{
    if (argc > 1 && std::strcmp(argv[1], "--self-test") == 0) {
        return self_test();
    }
    return 0;
}

#else

int main()
{
    return 0;
}

#endif
