/* Implemented wasm32 development ABI 0; matches exports/core.json.
 * Unimplemented declarations are separate in design/pmp-proposed.h.
 * SPDX-License-Identifier: MIT
 * All pointers address the instance's linear memory. No C++ objects cross ABI.
 * PMP-reported errors / unrecoverable failures trap. Raw pointer validity is
 * the caller's responsibility. Discard the instance after a trap.
 */
#ifndef PMP_WASM_H
#define PMP_WASM_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PMP_ABI_VERSION 0u
#define PMP_INVALID_INDEX UINT32_MAX

typedef struct pmp_mesh pmp_mesh;

enum pmp_curvature_kind {
    PMP_CURVATURE_MIN = 0, PMP_CURVATURE_MAX = 1, PMP_CURVATURE_MEAN = 2,
    PMP_CURVATURE_GAUSS = 3, PMP_CURVATURE_MAX_ABS = 4
};
enum pmp_boundary_handling {
    PMP_BOUNDARY_INTERPOLATE = 0, PMP_BOUNDARY_PRESERVE = 1
};
enum pmp_domain { PMP_VERTEX = 0, PMP_HALFEDGE = 1, PMP_EDGE = 2, PMP_FACE = 3 };
enum pmp_property_type {
    PMP_BOOL = 0, PMP_I32 = 1, PMP_U32 = 2, PMP_F32 = 3,
    PMP_F64 = 4, PMP_VEC2F = 5, PMP_VEC3F = 6,
    PMP_VEC4F = 7, PMP_VEC4U32 = 8, PMP_VEC4U16 = 9, PMP_RGBA8 = 10
};
enum pmp_winding { PMP_CCW = 0, PMP_CW = 1 };
enum pmp_algorithm {
    PMP_DECIMATE = 0, PMP_UNIFORM_REMESH = 1, PMP_ADAPTIVE_REMESH = 2,
    PMP_CATMULL_CLARK = 3, PMP_LOOP = 4, PMP_QUAD_TRI = 5, PMP_LINEAR = 6,
    PMP_EXPLICIT_SMOOTH = 7, PMP_IMPLICIT_SMOOTH = 8, PMP_FILL_HOLE = 9,
    PMP_TRIANGULATE = 10, PMP_CURVATURE = 11, PMP_FAIR = 12,
    PMP_CONNECTED_COMPONENTS = 13
};

/* Read-only native connectivity: 16-byte records, no index-buffer conversion. */
typedef struct {
    uint32_t face, vertex, next_halfedge, prev_halfedge;
} pmp_halfedge;

typedef struct {
    uint32_t vertices_size, edges_size, faces_size;
    uint32_t n_vertices, n_edges, n_faces;
    float *positions;                         /* vertices_size * 3, writable */
    const uint32_t *vertex_halfedges;          /* vertices_size */
    const pmp_halfedge *halfedges;             /* edges_size * 2 */
    const uint32_t *face_halfedges;            /* faces_size */
    const uint8_t *deleted_vertices, *deleted_edges, *deleted_faces;
} pmp_mesh_view;

/* Minimal ownership, mesh construction, and data access. */
uint32_t pmp_abi_version(void);
void *pmp_alloc(uint32_t bytes);               /* at least 16-byte alignment */
void pmp_free(void *ptr);
pmp_mesh *pmp_mesh_create(void);
void pmp_mesh_destroy(pmp_mesh *mesh);
void pmp_mesh_clear(pmp_mesh *mesh);
void pmp_mesh_reserve(pmp_mesh *mesh, uint32_t vertices, uint32_t edges,
                      uint32_t faces);
uint32_t pmp_mesh_add_vertex(pmp_mesh *mesh, const float point[3]);
uint32_t pmp_mesh_add_triangle(pmp_mesh *mesh, uint32_t a, uint32_t b, uint32_t c);
/* All corners must be distinct, live vertex indices. Polygon uniqueness is a
 * caller precondition; only triangles/quads are fully checked for duplicates. */
uint32_t pmp_mesh_add_face(pmp_mesh *mesh, const uint32_t *vertices, uint32_t count);
/* Bulk new_vertex(): returns first index; initialize positions through view. */
uint32_t pmp_mesh_add_vertices(pmp_mesh *mesh, uint32_t count);
/* offsets[0] == 0; offsets has count + 1 entries; no staging vector copy. */
void pmp_mesh_add_faces(pmp_mesh *mesh, const uint32_t *vertices,
                        const uint32_t *offsets, uint32_t count);
/* Normalize input winding to CCW without reversing a copied index buffer.
 * Optional mapping[source_corner] = native halfedge targeting that corner.
 * Per-corner UV/color data uses halfedge properties, preserving seams.
 * Input indices, offsets and mapping must occupy independent storage. */
void pmp_mesh_add_faces_winding(pmp_mesh *mesh, const uint32_t *vertices,
                                const uint32_t *offsets, uint32_t count,
                                uint32_t winding, uint32_t *corner_halfedges);
void pmp_mesh_add_triangles(pmp_mesh *mesh, const uint32_t *vertices,
                            uint32_t count, uint32_t winding, uint32_t *corner_halfedges);
void pmp_mesh_garbage_collection(pmp_mesh *mesh);
void pmp_mesh_get_view(pmp_mesh *mesh, pmp_mesh_view *out);
/* Named PMP properties; create=0 returns NULL if absent, create=1 zero-fills a
 * new property. Type mismatch traps. Bool storage is u8 containing 0 or 1.
 * Internal connectivity/deletion properties cannot be accessed through here.
 * Custom channels use a user: prefix, e.g. user:uv1, user:colors,
 * user:matricesIndices, user:matricesWeights. More than four skin influences
 * use additional four-component channels. Values are not implicitly converted. */
void *pmp_mesh_property(pmp_mesh *mesh, uint32_t domain, uint32_t type,
                        const char *name, uint32_t create);
/* Returns 1 if removed, 0 if absent. Core and scratch names are reserved. */
uint32_t pmp_mesh_remove_property(pmp_mesh *mesh, uint32_t domain, const char *name);
/* Allocation-free preflight. Returns a bitmask of domains containing unsupported
 * attached properties: 1<<PMP_VERTEX, 1<<PMP_HALFEDGE, 1<<PMP_EDGE, 1<<PMP_FACE.
 * An incomplete/inconsistent feature pair also marks vertex+edge. A zero result
 * checks property support only, not geometry/numerical preconditions. Algorithms
 * trap before mutation if this mask is nonzero. See DESIGN.md for transfer rules. */
uint32_t pmp_mesh_unsupported_properties(const pmp_mesh *mesh, uint32_t algorithm);

/* Algorithms: same names, parameter order, units and scalar precision as PMP.
 * C requires every defaulted argument explicitly. bool/enum/size_t -> u32.
 * Returned small structs use caller-owned output pointers.
 * Mesh indices must be compact: call garbage_collection explicitly when needed.
 * Const algorithms may allocate and replace memory.buffer; reacquire JS views. */

void pmp_curvature(pmp_mesh *mesh, uint32_t kind, int32_t smoothing_steps,
                   uint32_t use_tensor, uint32_t use_two_ring);
void pmp_decimate(pmp_mesh *mesh, uint32_t n_vertices, float aspect_ratio,
                  float edge_length, uint32_t max_valence, float normal_deviation,
                  float hausdorff_error, float seam_threshold, float seam_angle_deviation);

/* Area/volume of an empty mesh are zero. Volume is absolute and requires
 * triangle input; enclosed-volume interpretation requires a closed surface. */
float pmp_surface_area(const pmp_mesh *mesh);
float pmp_volume(const pmp_mesh *mesh);
/* Centroid requires finite positive total surface area. */
void pmp_centroid(const pmp_mesh *mesh, float out[3]);

/* Fairing requires boundary/selection constraints; k must be at least one. */
void pmp_minimize_area(pmp_mesh *mesh);
void pmp_minimize_curvature(pmp_mesh *mesh);
void pmp_fair(pmp_mesh *mesh, uint32_t k);
uint32_t pmp_detect_features(pmp_mesh *mesh, float angle);
uint32_t pmp_detect_boundary(pmp_mesh *mesh);
void pmp_clear_features(pmp_mesh *mesh);

void pmp_fill_hole(pmp_mesh *mesh, uint32_t halfedge);

void pmp_vertex_normals(pmp_mesh *mesh);
void pmp_face_normals(pmp_mesh *mesh);
void pmp_vertex_normal(const pmp_mesh *mesh, uint32_t vertex, float out[3]);
void pmp_face_normal(const pmp_mesh *mesh, uint32_t face, float out[3]);
void pmp_corner_normal(const pmp_mesh *mesh, uint32_t halfedge, float crease_angle,
                       float out[3]);

void pmp_uniform_remeshing(pmp_mesh *mesh, float edge_length, uint32_t iterations,
                          uint32_t use_projection);
void pmp_adaptive_remeshing(pmp_mesh *mesh, float min_edge_length, float max_edge_length,
                           float approx_error, uint32_t iterations, uint32_t use_projection);

void pmp_explicit_smoothing(pmp_mesh *mesh, uint32_t iterations, uint32_t use_uniform_laplace);
void pmp_implicit_smoothing(pmp_mesh *mesh, float timestep, uint32_t iterations,
                           uint32_t use_uniform_laplace, uint32_t rescale);
void pmp_catmull_clark_subdivision(pmp_mesh *mesh, uint32_t boundary_handling);
void pmp_loop_subdivision(pmp_mesh *mesh, uint32_t boundary_handling);
void pmp_quad_tri_subdivision(pmp_mesh *mesh, uint32_t boundary_handling);
void pmp_linear_subdivision(pmp_mesh *mesh);
/* Copies source polygon user face/corner channels and h:tex; preserves vertex
 * rows. Unsupported edge channels trap. Numerical/topological failure may
 * follow partial mutation; discard the instance after any trap. */
void pmp_triangulate(pmp_mesh *mesh);
void pmp_triangulate_face(pmp_mesh *mesh, uint32_t face);
/* Bounds requires vertices; edge/face statistics require a nonempty domain. */
void pmp_bounds(const pmp_mesh *mesh, float out_min_max[6]);

float pmp_min_face_area(const pmp_mesh *mesh);
float pmp_mean_edge_length(const pmp_mesh *mesh);
float pmp_min_edge_length(const pmp_mesh *mesh);
/* Writes zero-copy native v:component (I32); isolated vertices count separately. */
int32_t pmp_connected_components(pmp_mesh *mesh);

#ifdef __cplusplus
}
#endif
#endif
