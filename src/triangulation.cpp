// SPDX-License-Identifier: MIT
#include "mesh.hpp"
#include "pmp/algorithms/triangulation.h"
#include <algorithm>
#include <string_view>
#include <utility>
#include <vector>

using namespace pmp_wasm;
namespace {
bool corner_channel(std::string_view name)
{
    return name.starts_with("user:") || name == "h:tex";
}
bool face_channel(std::string_view name) { return name.starts_with("user:"); }

void check_face(const pmp::SurfaceMesh& mesh, pmp::Face face)
{
    const uint64_t n = mesh.valence(face);
    // Native dynamic programming stores two n*n tables of 32-bit entries.
    // Bound their combined allocation before any multiplication in wasm32.
    require(n * n <= INT32_MAX / (sizeof(float) + sizeof(int32_t)));
    for (auto v : mesh.vertices(face)) require(mesh.is_manifold(v));
}

void triangulate_face(pmp::SurfaceMesh& mesh, pmp::Face face)
{
    const auto count = mesh.valence(face);
    if (count <= 3) return;
    auto& corners = pmp::WasmAccess::properties(mesh, PMP_HALFEDGE);
    auto& faces = pmp::WasmAccess::properties(mesh, PMP_FACE);
    const bool copy_corners = corners.any_property(corner_channel);
    const bool copy_faces = faces.any_property(face_channel);
    // Only topology indices are staged; attribute buffers stay in native
    // storage. Each new corner duplicates its original polygon's target row,
    // so seams on adjacent polygons remain independent.
    std::vector<std::pair<uint32_t, uint32_t>> sources;
    if (copy_corners) {
        sources.reserve(mesh.valence(face));
        for (auto h : mesh.halfedges(face))
            sources.emplace_back(mesh.to_vertex(h).idx(), h.idx());
        std::sort(sources.begin(), sources.end());
    }
    const auto first_corner = mesh.halfedges_size();
    const auto first_face = mesh.faces_size();
    pmp::triangulate(mesh, face);
    // Native insert_edge can silently skip a diagonal that already exists
    // outside this polygon. A successful binding call must yield n-2 triangles.
    // This check follows mutation: failure abandons the instance as usual.
    require(mesh.faces_size() - first_face == count - 3 && mesh.valence(face) == 3);
    for (auto i = first_face; i < mesh.faces_size(); ++i)
        require(mesh.valence(pmp::Face(i)) == 3);
    if (copy_faces)
        for (auto i = first_face; i < mesh.faces_size(); ++i)
            faces.copy_rows(face.idx(), i, face_channel);
    if (copy_corners)
        for (auto i = first_corner; i < mesh.halfedges_size(); ++i) {
            const auto vertex = mesh.to_vertex(pmp::Halfedge(i)).idx();
            const auto source = std::lower_bound(sources.begin(), sources.end(),
                std::pair<uint32_t, uint32_t>{vertex, 0});
            require(source != sources.end() && source->first == vertex);
            corners.copy_rows(source->second, i, corner_channel);
        }
}
} // namespace

extern "C" {
void pmp_triangulate(pmp_mesh* handle)
{
    auto& mesh = prepare(handle, PMP_TRIANGULATE);
    // Check all original faces before changing connectivity.
    for (auto face : mesh.faces()) check_face(mesh, face);
    const auto count = mesh.faces_size();
    for (uint32_t i = 0; i < count; ++i) triangulate_face(mesh, pmp::Face(i));
    invalidate_results(mesh);
}

void pmp_triangulate_face(pmp_mesh* handle, uint32_t index)
{
    auto& mesh = prepare(handle, PMP_TRIANGULATE);
    const auto face = face_of(mesh, index);
    check_face(mesh, face);
    triangulate_face(mesh, face);
    invalidate_results(mesh);
}
} // extern "C"
