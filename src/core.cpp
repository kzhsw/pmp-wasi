// SPDX-License-Identifier: MIT
#include "mesh.hpp"
#include "pmp/algorithms/normals.h"
#include "pmp/algorithms/features.h"

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string_view>
#include <type_traits>

using namespace pmp_wasm;

namespace {
void check_face(const pmp::SurfaceMesh& mesh, const uint32_t* indices, uint32_t count)
{
    require(count >= 3 && count < UINT32_MAX / 3 && indices != nullptr);
    for (uint32_t i = 0; i < count; ++i) {
        vertex_of(mesh, indices[i]);
        require(indices[i] != indices[(i + 1) % count]);
        // Full uniqueness is a raw input precondition. Check common small faces
        // cheaply without a quadratic scan or copied index buffer for large ones.
        if (count <= 4)
            for (uint32_t j = 0; j < i; ++j) require(indices[i] != indices[j]);
    }
}
void add_wound_face(pmp::SurfaceMesh& mesh, const uint32_t* indices, uint32_t count,
                   bool reverse, uint32_t* mapping)
{
    check_face(mesh, indices, count);
    const auto face = mesh.add_face(indices, count, reverse);
    if (mapping) {
        auto h = mesh.halfedge(face);
        for (uint32_t i = 0; i < count; ++i) {
            mapping[reverse ? count - 1 - i : i] = h.idx();
            h = mesh.next_halfedge(h);
        }
    }
}
struct NamedProperty { std::string_view name; uint32_t domain, type; };
constexpr NamedProperty public_properties[] = {
    {"v:point", PMP_VERTEX, PMP_VEC3F}, {"v:normal", PMP_VERTEX, PMP_VEC3F},
    {"f:normal", PMP_FACE, PMP_VEC3F}, {"v:tex", PMP_VERTEX, PMP_VEC2F},
    {"h:tex", PMP_HALFEDGE, PMP_VEC2F}, {"v:curv", PMP_VERTEX, PMP_F32},
    {"geodesic:distance", PMP_VERTEX, PMP_F32}, {"v:component", PMP_VERTEX, PMP_I32},
    {"v:selected", PMP_VERTEX, PMP_BOOL}, {"v:feature", PMP_VERTEX, PMP_BOOL},
    {"e:feature", PMP_EDGE, PMP_BOOL}
};
void property_name(const char* name, uint32_t domain, uint32_t type, bool removing)
{
    require(name != nullptr && domain <= PMP_FACE);
    std::string_view key(name);
    for (const auto& property : public_properties) {
        if (key != property.name) continue;
        require(domain == property.domain);
        require(removing ? key != "v:point" : type == property.type);
        return;
    }
    // Algorithm scratch/core names are never writable through the public ABI.
    require(key.starts_with("user:") && key.size() > 5);
}
template<class T>
void* property_data(pmp::PropertyContainer& container, std::string_view name, bool create)
{
    auto property = container.get<T>(name);
    if (!property) {
        require(!container.exists(name));
        if (!create) return nullptr;
        property = container.add<T>(std::string(name), T{});
    }
    auto& data = property.vector();
    return data.empty() ? nullptr : data.data();
}
} // namespace

namespace pmp {
void WasmAccess::view(SurfaceMesh& mesh, pmp_mesh_view& out)
{
    using VC = SurfaceMesh::VertexConnectivity;
    using HC = SurfaceMesh::HalfedgeConnectivity;
    using FC = SurfaceMesh::FaceConnectivity;
    static_assert(sizeof(VC) == 4 && sizeof(HC) == 16 && sizeof(FC) == 4);
    static_assert(alignof(VC) == 4 && alignof(HC) == 4 && alignof(FC) == 4);
    static_assert(std::is_standard_layout_v<VC> && std::is_standard_layout_v<HC> &&
                  std::is_standard_layout_v<FC>);
    static_assert(std::is_trivially_copyable_v<VC> && std::is_trivially_copyable_v<HC> &&
                  std::is_trivially_copyable_v<FC>);
    static_assert(offsetof(VC, halfedge_) == 0 && offsetof(FC, halfedge_) == 0);
    static_assert(offsetof(HC, face_) == 0 && offsetof(HC, vertex_) == 4 &&
                  offsetof(HC, next_halfedge_) == 8 && offsetof(HC, prev_halfedge_) == 12);
    out = {uint32_t(mesh.vertices_size()), uint32_t(mesh.edges_size()), uint32_t(mesh.faces_size()),
           uint32_t(mesh.n_vertices()), uint32_t(mesh.n_edges()), uint32_t(mesh.n_faces()),
           mesh.positions().empty() ? nullptr : mesh.positions().front().data(),
           reinterpret_cast<const uint32_t*>(mesh.vconn_.data()),
           reinterpret_cast<const pmp_halfedge*>(mesh.hconn_.data()),
           reinterpret_cast<const uint32_t*>(mesh.fconn_.data()),
           mesh.vdeleted_.data(), mesh.edeleted_.data(), mesh.fdeleted_.data()};
}
} // namespace pmp

static_assert(sizeof(pmp::Scalar) == 4 && sizeof(pmp::IndexType) == 4);
static_assert(sizeof(pmp::Point) == 12 && alignof(pmp::Point) == 4);
static_assert(sizeof(pmp::TexCoord) == 8 && alignof(pmp::TexCoord) == 4);
static_assert(sizeof(pmp::vec4) == 16 && sizeof(pmp::Vector<uint32_t, 4>) == 16);
static_assert(sizeof(pmp::Vector<uint16_t, 4>) == 8 && sizeof(pmp::Vector<uint8_t, 4>) == 4);
static_assert(std::is_standard_layout_v<pmp::Point> && std::is_trivially_copyable_v<pmp::Point>);
static_assert(sizeof(pmp::Vertex) == 4 && sizeof(pmp::Halfedge) == 4 && sizeof(pmp::Face) == 4);
#ifdef __wasm__
static_assert(sizeof(void*) == 4 && sizeof(pmp_mesh_view) == 52);
static_assert(offsetof(pmp_mesh_view, positions) == 24 && offsetof(pmp_mesh_view, deleted_faces) == 48);
#endif

extern "C" {
// ABI 0 identifies this development subset; v1 is frozen only with full coverage.
uint32_t pmp_abi_version() { return 0; }
void* pmp_alloc(uint32_t bytes)
{
    if (!bytes) return nullptr;
    require(bytes <= UINT32_MAX - 15);
    void* ptr = std::aligned_alloc(16, (size_t(bytes) + 15) & ~size_t(15));
    require(ptr != nullptr);
    return ptr;
}
void pmp_free(void* ptr) { std::free(ptr); }
pmp_mesh* pmp_mesh_create() { return reinterpret_cast<pmp_mesh*>(new pmp::SurfaceMesh); }
void pmp_mesh_destroy(pmp_mesh* mesh) { delete reinterpret_cast<pmp::SurfaceMesh*>(mesh); }
void pmp_mesh_clear(pmp_mesh* mesh) { mesh_of(mesh).clear(); }
void pmp_mesh_reserve(pmp_mesh* handle, uint32_t vertices, uint32_t edges, uint32_t faces)
{
    require(vertices < UINT32_MAX / 12 && edges < UINT32_MAX / 32 && faces < UINT32_MAX / 4);
    mesh_of(handle).reserve(vertices, edges, faces);
}
uint32_t pmp_mesh_add_vertices(pmp_mesh* handle, uint32_t count)
{
    auto& mesh = mesh_of(handle);
    const uint32_t first = uint32_t(mesh.vertices_size());
    require(count < UINT32_MAX / 12 && first < UINT32_MAX / 12 - count);
    for (uint32_t i = 0; i < count; ++i) mesh.new_vertex();
    return first;
}
uint32_t pmp_mesh_add_vertex(pmp_mesh* handle, const float point[3])
{
    require(point != nullptr);
    // Read before allocation in case the argument is a borrowed position.
    const pmp::Point p(point[0], point[1], point[2]);
    return mesh_of(handle).add_vertex(p).idx();
}
uint32_t pmp_mesh_add_face(pmp_mesh* handle, const uint32_t* vertices, uint32_t count)
{
    auto& mesh = mesh_of(handle);
    check_face(mesh, vertices, count);
    return mesh.add_face(vertices, count).idx();
}
uint32_t pmp_mesh_add_triangle(pmp_mesh* handle, uint32_t a, uint32_t b, uint32_t c)
{
    const uint32_t indices[]{a, b, c};
    return pmp_mesh_add_face(handle, indices, 3);
}
void pmp_mesh_add_faces(pmp_mesh* handle, const uint32_t* vertices, const uint32_t* offsets, uint32_t count)
{
    pmp_mesh_add_faces_winding(handle, vertices, offsets, count, PMP_CCW, nullptr);
}
void pmp_mesh_add_faces_winding(pmp_mesh* handle, const uint32_t* vertices, const uint32_t* offsets,
                              uint32_t count, uint32_t winding, uint32_t* mapping)
{
    auto& mesh = mesh_of(handle);
    require(winding <= PMP_CW);
    if (!count) return;
    require(vertices != nullptr && offsets != nullptr && count < UINT32_MAX / 4);
    require(offsets[0] == 0);
    for (uint32_t i = 0; i < count; ++i) {
        require(offsets[i + 1] >= offsets[i] && offsets[i + 1] < UINT32_MAX / 4);
        const uint32_t n = offsets[i + 1] - offsets[i];
        add_wound_face(mesh, vertices + offsets[i], n, winding == PMP_CW,
                       mapping ? mapping + offsets[i] : nullptr);
    }
}
void pmp_mesh_add_triangles(pmp_mesh* handle, const uint32_t* vertices, uint32_t count,
                           uint32_t winding, uint32_t* mapping)
{
    auto& mesh = mesh_of(handle);
    require(winding <= PMP_CW && count < UINT32_MAX / 12);
    require(count == 0 || vertices != nullptr);
    for (uint32_t i = 0; i < count; ++i)
        add_wound_face(mesh, vertices + i * 3, 3, winding == PMP_CW,
                       mapping ? mapping + i * 3 : nullptr);
}
void pmp_mesh_garbage_collection(pmp_mesh* mesh) { mesh_of(mesh).garbage_collection(); }
void pmp_mesh_get_view(pmp_mesh* mesh, pmp_mesh_view* out)
{
    require(out != nullptr);
    pmp::WasmAccess::view(mesh_of(mesh), *out);
}
void* pmp_mesh_property(pmp_mesh* handle, uint32_t domain, uint32_t type, const char* name, uint32_t create)
{
    require(create <= 1);
    property_name(name, domain, type, false);
    auto& properties = pmp::WasmAccess::properties(mesh_of(handle), domain);
    switch (type) {
    case PMP_BOOL: return property_data<bool>(properties, name, create);
    case PMP_I32: return property_data<int32_t>(properties, name, create);
    case PMP_U32: return property_data<uint32_t>(properties, name, create);
    case PMP_F32: return property_data<float>(properties, name, create);
    case PMP_F64: return property_data<double>(properties, name, create);
    case PMP_VEC2F: return property_data<pmp::TexCoord>(properties, name, create);
    case PMP_VEC3F: return property_data<pmp::Point>(properties, name, create);
    case PMP_VEC4F: return property_data<pmp::vec4>(properties, name, create);
    case PMP_VEC4U32: return property_data<pmp::Vector<uint32_t, 4>>(properties, name, create);
    case PMP_VEC4U16: return property_data<pmp::Vector<uint16_t, 4>>(properties, name, create);
    case PMP_RGBA8: return property_data<pmp::Vector<uint8_t, 4>>(properties, name, create);
    default: pmp::fail();
    }
}
uint32_t pmp_mesh_remove_property(pmp_mesh* handle, uint32_t domain, const char* name)
{
    property_name(name, domain, 0, true);
    return pmp::WasmAccess::properties(mesh_of(handle), domain).remove(name);
}
void pmp_vertex_normals(pmp_mesh* handle)
{
    auto& mesh = mesh_of(handle); compact(mesh); pmp::vertex_normals(mesh);
}
void pmp_face_normals(pmp_mesh* handle)
{
    auto& mesh = mesh_of(handle); compact(mesh); pmp::face_normals(mesh);
}
void pmp_vertex_normal(const pmp_mesh* handle, uint32_t index, float out[3])
{
    const auto& mesh = mesh_of(handle); compact(mesh);
    store(out, pmp::vertex_normal(mesh, vertex_of(mesh, index)));
}
void pmp_face_normal(const pmp_mesh* handle, uint32_t index, float out[3])
{
    const auto& mesh = mesh_of(handle); compact(mesh);
    store(out, pmp::face_normal(mesh, face_of(mesh, index)));
}
void pmp_corner_normal(const pmp_mesh* handle, uint32_t index, float angle, float out[3])
{
    const auto& mesh = mesh_of(handle); compact(mesh);
    require(index < mesh.halfedges_size() && std::isfinite(angle) && angle >= 0);
    pmp::Halfedge h(index);
    require(!mesh.is_deleted(mesh.edge(h)) && !mesh.is_boundary(h));
    store(out, pmp::corner_normal(mesh, h, angle));
}
uint32_t pmp_detect_features(pmp_mesh* handle, float angle)
{
    auto& mesh = mesh_of(handle); compact(mesh);
    require(std::isfinite(angle) && angle >= 0 && angle <= 180);
    return uint32_t(pmp::detect_features(mesh, angle));
}
uint32_t pmp_detect_boundary(pmp_mesh* handle)
{
    auto& mesh = mesh_of(handle); compact(mesh); return uint32_t(pmp::detect_boundary(mesh));
}
void pmp_clear_features(pmp_mesh* handle)
{
    auto& mesh = mesh_of(handle); compact(mesh); pmp::clear_features(mesh);
}
} // extern "C"
