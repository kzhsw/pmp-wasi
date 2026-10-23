// SPDX-License-Identifier: MIT
#pragma once
#include "pmp.h"
#include "pmp/surface_mesh.h"

// Shared ABI checks: raw pointer validity remains a caller precondition.
// These helpers never allocate. Native failures abandon the Wasm instance.
namespace pmp_wasm {
inline void require(bool condition) { if (!condition) pmp::fail(); }

inline pmp::SurfaceMesh& mesh_of(pmp_mesh* handle)
{
    require(handle != nullptr);
    return *reinterpret_cast<pmp::SurfaceMesh*>(handle);
}
inline const pmp::SurfaceMesh& mesh_of(const pmp_mesh* handle)
{
    require(handle != nullptr);
    return *reinterpret_cast<const pmp::SurfaceMesh*>(handle);
}
inline void compact(const pmp::SurfaceMesh& mesh)
{
    require(mesh.n_vertices() == mesh.vertices_size() &&
            mesh.n_edges() == mesh.edges_size() && mesh.n_faces() == mesh.faces_size());
}
inline pmp::Vertex vertex_of(const pmp::SurfaceMesh& mesh, uint32_t index)
{
    require(index < mesh.vertices_size());
    pmp::Vertex v(index);
    require(!mesh.is_deleted(v));
    return v;
}
inline pmp::Face face_of(const pmp::SurfaceMesh& mesh, uint32_t index)
{
    require(index < mesh.faces_size());
    pmp::Face f(index);
    require(!mesh.is_deleted(f));
    return f;
}
inline void store(float* out, const pmp::Point& value)
{
    require(out != nullptr);
    for (int i = 0; i != 3; ++i) out[i] = value[i];
}
} // namespace pmp_wasm

namespace pmp {
// The only access to private mesh storage. Does not expose STL object layouts.
struct WasmAccess {
    static PropertyContainer& properties(SurfaceMesh& mesh, uint32_t domain)
    {
        switch (domain) {
        case PMP_VERTEX: return mesh.vprops_;
        case PMP_HALFEDGE: return mesh.hprops_;
        case PMP_EDGE: return mesh.eprops_;
        case PMP_FACE: return mesh.fprops_;
        default: fail();
        }
    }
    static const PropertyContainer& properties(const SurfaceMesh& mesh, uint32_t domain)
    {
        switch (domain) {
        case PMP_VERTEX: return mesh.vprops_;
        case PMP_HALFEDGE: return mesh.hprops_;
        case PMP_EDGE: return mesh.eprops_;
        case PMP_FACE: return mesh.fprops_;
        default: fail();
        }
    }
    static void view(SurfaceMesh& mesh, pmp_mesh_view& out);
};
} // namespace pmp
