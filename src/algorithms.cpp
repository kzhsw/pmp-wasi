// SPDX-License-Identifier: MIT
#include "mesh.hpp"
#include "pmp/algorithms/decimation.h"
#include "pmp/algorithms/remeshing.h"
#include "pmp/algorithms/subdivision.h"
#include "pmp/algorithms/smoothing.h"
#include "pmp/algorithms/hole_filling.h"
#include <cmath>
#include <string_view>

using namespace pmp_wasm;
namespace {
bool derived(std::string_view name)
{
    return name == "v:normal" || name == "f:normal" || name == "v:curv" ||
           name == "geodesic:distance" || name == "v:component";
}
bool core_property(std::string_view name)
{
    return name == "v:point" || name == "v:connectivity" || name == "h:connectivity" ||
           name == "f:connectivity" || name == "v:deleted" || name == "e:deleted" || name == "f:deleted";
}
bool preserves_rows(uint32_t op)
{
    return op == PMP_EXPLICIT_SMOOTH || op == PMP_IMPLICIT_SMOOTH ||
           op == PMP_CURVATURE || op == PMP_FAIR || op == PMP_CONNECTED_COMPONENTS;
}
bool feature_algorithm(uint32_t op)
{
    return op == PMP_DECIMATE || op == PMP_UNIFORM_REMESH || op == PMP_ADAPTIVE_REMESH ||
           op == PMP_CATMULL_CLARK || op == PMP_LOOP || op == PMP_TRIANGULATE;
}
bool allowed(std::string_view name, uint32_t domain, uint32_t op)
{
    if (core_property(name) || derived(name) || preserves_rows(op)) return true;
    // Triangulation preserves vertices and explicitly transfers face/corner
    // rows. New diagonals have no source edge for arbitrary edge attributes.
    if (op == PMP_TRIANGULATE && domain != PMP_EDGE) return true;
    if (feature_algorithm(op) && (name == "v:feature" || name == "e:feature")) return true;
    if ((op == PMP_DECIMATE || op == PMP_UNIFORM_REMESH || op == PMP_ADAPTIVE_REMESH) && name == "v:selected")
        return true;
    // Decimation retains endpoint vertices, so their original channels remain
    // meaningful and garbage collection moves those complete property rows.
    if (op == PMP_DECIMATE && domain == PMP_VERTEX && (name.starts_with("user:") || name == "v:tex"))
        return true;
    return op == PMP_DECIMATE && domain == PMP_HALFEDGE && name == "h:tex";
}
uint32_t unsupported(const pmp::SurfaceMesh& mesh, uint32_t op)
{
    require(op <= PMP_CONNECTED_COMPONENTS);
    uint32_t mask = 0;
    for (uint32_t domain = PMP_VERTEX; domain <= PMP_FACE; ++domain)
        if (pmp::WasmAccess::properties(mesh, domain).any_property(
                [&](std::string_view name) { return !allowed(name, domain, op); }))
            mask |= 1u << domain;
    if (feature_algorithm(op)) {
        const auto vertices = mesh.get_vertex_property<bool>("v:feature");
        const auto edges = mesh.get_edge_property<bool>("e:feature");
        if (bool(vertices) != bool(edges)) mask |= (1u << PMP_VERTEX) | (1u << PMP_EDGE);
        else if (edges)
            for (auto e : mesh.edges())
                if (edges[e] && (!vertices[mesh.vertex(e, 0)] || !vertices[mesh.vertex(e, 1)]))
                    mask |= (1u << PMP_VERTEX) | (1u << PMP_EDGE);
    }
    return mask;
}
} // namespace

namespace pmp_wasm {
void check_mesh(const pmp::SurfaceMesh& mesh)
{
    compact(mesh);
    require(mesh.vertices_size() <= INT32_MAX && mesh.edges_size() <= INT32_MAX / 2 &&
            mesh.faces_size() <= INT32_MAX);
    for (auto v : mesh.vertices()) {
        const auto& p = mesh.position(v);
        require(std::isfinite(p[0]) && std::isfinite(p[1]) && std::isfinite(p[2]));
    }
}
pmp::SurfaceMesh& prepare(pmp_mesh* handle, uint32_t op, bool triangles)
{
    auto& mesh = mesh_of(handle);
    check_mesh(mesh);
    require(unsupported(mesh, op) == 0);
    require(!triangles || mesh.is_triangle_mesh());
    return mesh;
}
void check_polygon_matrices(const pmp::SurfaceMesh& mesh, bool polygons)
{
    // Eigen's release-mode dimension products use signed wasm32 indices. Check
    // before multiplying: n-gon Laplace/mass operators allocate (n+1)^2 doubles.
    constexpr uint64_t max_coefficients = INT32_MAX / sizeof(double);
    require(mesh.vertices_size() <= max_coefficients / 3);
    if (polygons)
        for (auto f : mesh.faces()) {
            const uint64_t dimension = uint64_t(mesh.valence(f)) + 1;
            require(dimension * dimension <= max_coefficients);
        }
}
void invalidate_results(pmp::SurfaceMesh& mesh)
{
    // Derived values become stale when coordinates or connectivity change.
    auto& vertices = pmp::WasmAccess::properties(mesh, PMP_VERTEX);
    for (const char* name : {"v:normal", "v:curv", "geodesic:distance", "v:component"}) vertices.remove(name);
    pmp::WasmAccess::properties(mesh, PMP_FACE).remove("f:normal");
}
} // namespace pmp_wasm

namespace {
bool nonnegative(float value) { return std::isfinite(value) && value >= 0; }
bool positive(float value) { return std::isfinite(value) && value > 0; }
pmp::BoundaryHandling boundary(uint32_t handling)
{
    require(handling <= PMP_BOUNDARY_PRESERVE);
    return static_cast<pmp::BoundaryHandling>(handling);
}
} // namespace

extern "C" {
uint32_t pmp_mesh_unsupported_properties(const pmp_mesh* handle, uint32_t op)
{
    // Name and flag inspection is allocation-free and does not mutate the mesh.
    return unsupported(mesh_of(handle), op);
}
void pmp_decimate(pmp_mesh* handle, uint32_t count, float aspect, float length,
                  uint32_t valence, float normal_deviation, float hausdorff,
                  float seam_threshold, float seam_angle)
{
    require(nonnegative(aspect) && nonnegative(length) && nonnegative(normal_deviation) &&
            nonnegative(hausdorff) && nonnegative(seam_threshold) && nonnegative(seam_angle));
    auto& mesh = prepare(handle, PMP_DECIMATE, true);
    pmp::decimate(mesh, count, aspect, length, valence, normal_deviation, hausdorff, seam_threshold, seam_angle);
    invalidate_results(mesh);
}
void pmp_uniform_remeshing(pmp_mesh* handle, float length, uint32_t iterations, uint32_t projection)
{
    require(positive(length) && projection <= 1);
    auto& mesh = prepare(handle, PMP_UNIFORM_REMESH, true);
    pmp::uniform_remeshing(mesh, length, iterations, projection);
    invalidate_results(mesh);
}
void pmp_adaptive_remeshing(pmp_mesh* handle, float min_length, float max_length, float error,
                           uint32_t iterations, uint32_t projection)
{
    require(positive(min_length) && positive(max_length) && max_length >= min_length && positive(error) && projection <= 1);
    auto& mesh = prepare(handle, PMP_ADAPTIVE_REMESH, true);
    pmp::adaptive_remeshing(mesh, min_length, max_length, error, iterations, projection);
    invalidate_results(mesh);
}
void pmp_catmull_clark_subdivision(pmp_mesh* handle, uint32_t handling)
{
    const auto mode = boundary(handling);
    auto& mesh = prepare(handle, PMP_CATMULL_CLARK);
    pmp::catmull_clark_subdivision(mesh, mode);
    invalidate_results(mesh);
}
void pmp_loop_subdivision(pmp_mesh* handle, uint32_t handling)
{
    const auto mode = boundary(handling);
    auto& mesh = prepare(handle, PMP_LOOP, true);
    pmp::loop_subdivision(mesh, mode);
    invalidate_results(mesh);
}
void pmp_quad_tri_subdivision(pmp_mesh* handle, uint32_t handling)
{
    const auto mode = boundary(handling);
    auto& mesh = prepare(handle, PMP_QUAD_TRI);
    pmp::quad_tri_subdivision(mesh, mode);
    invalidate_results(mesh);
}
void pmp_linear_subdivision(pmp_mesh* handle)
{
    auto& mesh = prepare(handle, PMP_LINEAR);
    pmp::linear_subdivision(mesh);
    invalidate_results(mesh);
}
void pmp_explicit_smoothing(pmp_mesh* handle, uint32_t iterations, uint32_t uniform)
{
    require(uniform <= 1);
    auto& mesh = prepare(handle, PMP_EXPLICIT_SMOOTH);
    check_polygon_matrices(mesh, !uniform);
    pmp::explicit_smoothing(mesh, iterations, uniform);
    invalidate_results(mesh);
}
void pmp_implicit_smoothing(pmp_mesh* handle, float timestep, uint32_t iterations, uint32_t uniform, uint32_t rescale)
{
    require(nonnegative(timestep) && uniform <= 1 && rescale <= 1);
    auto& mesh = prepare(handle, PMP_IMPLICIT_SMOOTH);
    check_polygon_matrices(mesh, !uniform);
    pmp::implicit_smoothing(mesh, timestep, iterations, uniform, rescale);
    invalidate_results(mesh);
}
void pmp_fill_hole(pmp_mesh* handle, uint32_t index)
{
    auto& mesh = prepare(handle, PMP_FILL_HOLE);
    require(index < mesh.halfedges_size());
    const pmp::Halfedge h(index);
    require(!mesh.is_deleted(mesh.edge(h)) && mesh.is_boundary(h));
    // Hole refinement invokes fairing over the whole mesh, including other faces.
    check_polygon_matrices(mesh, true);
    pmp::fill_hole(mesh, h);
    invalidate_results(mesh);
}
} // extern "C"
