// SPDX-License-Identifier: MIT
#include "mesh.hpp"
#include "pmp/algorithms/curvature.h"
#include "pmp/algorithms/differential_geometry.h"
#include "pmp/algorithms/fairing.h"
#include "pmp/algorithms/utilities.h"
#include <cmath>

using namespace pmp_wasm;
namespace {
const pmp::SurfaceMesh& inspected_mesh(const pmp_mesh* handle)
{
    const auto& mesh = mesh_of(handle);
    check_mesh(mesh);
    return mesh;
}

pmp::SurfaceMesh& fairing_mesh(pmp_mesh* handle)
{
    auto& mesh = prepare(handle, PMP_FAIR);
    check_polygon_matrices(mesh, true);
    return mesh;
}
} // namespace

extern "C" {
int32_t pmp_connected_components(pmp_mesh* handle)
{
    auto& mesh = prepare(handle, PMP_CONNECTED_COMPONENTS);
    return pmp::connected_components(mesh);
}

void pmp_bounds(const pmp_mesh* handle, float out_min_max[6])
{
    require(out_min_max != nullptr);
    const auto& mesh = inspected_mesh(handle);
    require(mesh.n_vertices() != 0);
    const auto bounds = pmp::bounds(mesh);
    store(out_min_max, bounds.min());
    store(out_min_max + 3, bounds.max());
}

float pmp_surface_area(const pmp_mesh* handle)
{
    return pmp::surface_area(inspected_mesh(handle));
}

float pmp_volume(const pmp_mesh* handle)
{
    const auto& mesh = inspected_mesh(handle);
    require(mesh.is_triangle_mesh());
    return pmp::volume(mesh);
}

void pmp_centroid(const pmp_mesh* handle, float out[3])
{
    require(out != nullptr);
    const auto& mesh = inspected_mesh(handle);
    require(mesh.n_faces() != 0);
    // Validate the denominator in the same Scalar precision and face order
    // used by PMP. The centroid itself retains the native weighted formula.
    const auto area = pmp::surface_area(mesh);
    require(std::isfinite(area) && area > 0);
    store(out, pmp::centroid(mesh));
}

float pmp_mean_edge_length(const pmp_mesh* handle)
{
    const auto& mesh = inspected_mesh(handle);
    require(mesh.n_edges() != 0);
    return pmp::mean_edge_length(mesh);
}

float pmp_min_edge_length(const pmp_mesh* handle)
{
    const auto& mesh = inspected_mesh(handle);
    require(mesh.n_edges() != 0);
    return pmp::min_edge_length(mesh);
}

float pmp_min_face_area(const pmp_mesh* handle)
{
    const auto& mesh = inspected_mesh(handle);
    require(mesh.n_faces() != 0);
    return pmp::min_face_area(mesh);
}

void pmp_curvature(pmp_mesh* handle, uint32_t kind, int32_t smoothing_steps,
                   uint32_t use_tensor, uint32_t use_two_ring)
{
    require(kind <= PMP_CURVATURE_MAX_ABS && smoothing_steps >= 0 &&
            use_tensor <= 1 && use_two_ring <= 1);
    auto& mesh = prepare(handle, PMP_CURVATURE);
    // Both analysis paths build mass matrices; smoothing additionally builds
    // a Laplace matrix even when tensor analysis is requested.
    check_polygon_matrices(mesh, true);
    pmp::curvature(mesh, static_cast<pmp::Curvature>(kind), smoothing_steps,
                   use_tensor, use_two_ring);
}

void pmp_fair(pmp_mesh* handle, uint32_t k)
{
    require(k >= 1);
    auto& mesh = fairing_mesh(handle);
    pmp::fair(mesh, k);
    invalidate_results(mesh);
}

void pmp_minimize_area(pmp_mesh* handle)
{
    auto& mesh = fairing_mesh(handle);
    pmp::minimize_area(mesh);
    invalidate_results(mesh);
}

void pmp_minimize_curvature(pmp_mesh* handle)
{
    auto& mesh = fairing_mesh(handle);
    pmp::minimize_curvature(mesh);
    invalidate_results(mesh);
}
} // extern "C"
