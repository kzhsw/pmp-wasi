/* Proposed wasm32 C ABI. Only exports/core.json is implemented as development
 * ABI 0; remaining declarations and ABI 1 are provisional. See DESIGN.md.
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

#define PMP_ABI_VERSION 1u
#define PMP_INVALID_INDEX UINT32_MAX

typedef struct pmp_mesh pmp_mesh;
typedef struct pmp_sparse_matrix pmp_sparse_matrix;
typedef struct pmp_diagonal_matrix pmp_diagonal_matrix;
typedef struct pmp_dense_matrix pmp_dense_matrix;
typedef struct pmp_vertex_buffer pmp_vertex_buffer;

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
    PMP_EXPLICIT_SMOOTH = 7, PMP_IMPLICIT_SMOOTH = 8, PMP_FILL_HOLE = 9
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

/* Matches PMP report fields; ABI bools are u32, never compiler bool layout. */
typedef struct {
    int32_t n_vertices, n_edges, n_faces;
    uint32_t has_boundary, is_manifold, is_triangle_mesh, is_quad_mesh;
    int32_t n_components, n_isolated_vertices, n_degenerate_faces;
    int32_t n_duplicate_vertices;
} pmp_mesh_analysis;

typedef struct {
    uint32_t rows, cols, nnz;
    const int32_t *outer;                      /* cols + 1, CSC column offsets */
    const int32_t *inner;                      /* nnz, row indices */
    const double *values;                     /* nnz */
} pmp_sparse_view;

typedef struct {
    uint32_t rows, cols;
    double *values;                           /* rows * cols, column-major */
} pmp_dense_view;

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

pmp_vertex_buffer *pmp_vertex_buffer_create(void);
void pmp_vertex_buffer_destroy(pmp_vertex_buffer *buffer);
const uint32_t *pmp_vertex_buffer_data(const pmp_vertex_buffer *buffer);
uint32_t pmp_vertex_buffer_size(const pmp_vertex_buffer *buffer);
pmp_sparse_matrix *pmp_sparse_matrix_create(void);
void pmp_sparse_matrix_destroy(pmp_sparse_matrix *matrix);
void pmp_sparse_matrix_get_view(const pmp_sparse_matrix *matrix, pmp_sparse_view *out);
pmp_diagonal_matrix *pmp_diagonal_matrix_create(void);
void pmp_diagonal_matrix_destroy(pmp_diagonal_matrix *matrix);
const double *pmp_diagonal_matrix_data(const pmp_diagonal_matrix *matrix);
uint32_t pmp_diagonal_matrix_size(const pmp_diagonal_matrix *matrix);
pmp_dense_matrix *pmp_dense_matrix_create(uint32_t rows, uint32_t cols);
void pmp_dense_matrix_destroy(pmp_dense_matrix *matrix);
void pmp_dense_matrix_get_view(pmp_dense_matrix *matrix, pmp_dense_view *out);

/* Algorithms: same names, parameter order, units and scalar precision as PMP.
 * C requires every defaulted argument explicitly. bool/enum/size_t -> u32.
 * Returned small structs use caller-owned output pointers.
 * Mesh indices must be compact: call garbage_collection explicitly when needed.
 * Const algorithms may allocate and replace memory.buffer; reacquire JS views. */
void pmp_analyze(const pmp_mesh *mesh, pmp_mesh_analysis *out);
void pmp_curvature(pmp_mesh *mesh, uint32_t kind, int32_t smoothing_steps,
                   uint32_t use_tensor, uint32_t use_two_ring);
void pmp_decimate(pmp_mesh *mesh, uint32_t n_vertices, float aspect_ratio,
                  float edge_length, uint32_t max_valence, float normal_deviation,
                  float hausdorff_error, float seam_threshold, float seam_angle_deviation);
/* C-only standalone math; not exported from the Wasm module. */
float pmp_clamp_cot(float v);
float pmp_clamp_cos(float v);
float pmp_angle(const float v0[3], const float v1[3]);
float pmp_sin(const float v0[3], const float v1[3]);
float pmp_cos(const float v0[3], const float v1[3]);
float pmp_cotan(const float v0[3], const float v1[3]);
float pmp_triangle_area(const float p0[3], const float p1[3], const float p2[3]);
/* Wasm mesh algorithms resume here. */
float pmp_face_area(const pmp_mesh *mesh, uint32_t face);
float pmp_surface_area(const pmp_mesh *mesh);
float pmp_voronoi_area(const pmp_mesh *mesh, uint32_t vertex);
float pmp_voronoi_area_mixed(const pmp_mesh *mesh, uint32_t vertex);
float pmp_edge_area(const pmp_mesh *mesh, uint32_t edge);
float pmp_volume(const pmp_mesh *mesh);
void pmp_centroid(const pmp_mesh *mesh, float out[3]);
void pmp_centroid_face(const pmp_mesh *mesh, uint32_t face, float out[3]);
void pmp_dual(pmp_mesh *mesh);
double pmp_cotan_weight(const pmp_mesh *mesh, uint32_t edge);
void pmp_laplace(const pmp_mesh *mesh, uint32_t vertex, float out[3]);
/* C-only standalone geometry; not exported from the Wasm module. */
float pmp_dist_point_line_segment(const float p[3], const float v0[3],
                                  const float v1[3], float nearest_point[3]);
float pmp_dist_point_triangle(const float p[3], const float v0[3],
                              const float v1[3], const float v2[3], float nearest_point[3]);
/* Wasm mesh algorithms resume here. */
void pmp_minimize_area(pmp_mesh *mesh);
void pmp_minimize_curvature(pmp_mesh *mesh);
void pmp_fair(pmp_mesh *mesh, uint32_t k);
uint32_t pmp_detect_features(pmp_mesh *mesh, float angle);
uint32_t pmp_detect_boundary(pmp_mesh *mesh);
void pmp_clear_features(pmp_mesh *mesh);
uint32_t pmp_geodesics(pmp_mesh *mesh, const uint32_t *seeds, uint32_t seed_count,
                       float maxdist, uint32_t maxnum, pmp_vertex_buffer *neighbors);
void pmp_geodesics_heat(pmp_mesh *mesh, const uint32_t *seeds, uint32_t seed_count);
void pmp_fill_hole(pmp_mesh *mesh, uint32_t halfedge);
void pmp_uniform_mass_matrix(const pmp_mesh *mesh, pmp_diagonal_matrix *out);
void pmp_uniform_laplace_matrix(const pmp_mesh *mesh, pmp_sparse_matrix *out);
void pmp_mass_matrix(const pmp_mesh *mesh, pmp_diagonal_matrix *out);
void pmp_laplace_matrix(const pmp_mesh *mesh, pmp_sparse_matrix *out, uint32_t clamp);
void pmp_gradient_matrix(const pmp_mesh *mesh, pmp_sparse_matrix *out);
void pmp_divergence_matrix(const pmp_mesh *mesh, pmp_sparse_matrix *out);
void pmp_vertex_normals(pmp_mesh *mesh);
void pmp_face_normals(pmp_mesh *mesh);
void pmp_vertex_normal(const pmp_mesh *mesh, uint32_t vertex, float out[3]);
void pmp_face_normal(const pmp_mesh *mesh, uint32_t face, float out[3]);
void pmp_corner_normal(const pmp_mesh *mesh, uint32_t halfedge, float crease_angle,
                       float out[3]);
void pmp_coordinates_to_matrix(const pmp_mesh *mesh, pmp_dense_matrix *out);
void pmp_matrix_to_coordinates(const pmp_dense_matrix *matrix, pmp_mesh *mesh);
void pmp_harmonic_parameterization(pmp_mesh *mesh, uint32_t use_uniform_weights);
void pmp_lscm_parameterization(pmp_mesh *mesh);
void pmp_uniform_remeshing(pmp_mesh *mesh, float edge_length, uint32_t iterations,
                          uint32_t use_projection);
void pmp_adaptive_remeshing(pmp_mesh *mesh, float min_edge_length, float max_edge_length,
                           float approx_error, uint32_t iterations, uint32_t use_projection);
pmp_mesh *pmp_tetrahedron(void);
pmp_mesh *pmp_hexahedron(void);
pmp_mesh *pmp_octahedron(void);
pmp_mesh *pmp_dodecahedron(void);
pmp_mesh *pmp_icosahedron(void);
pmp_mesh *pmp_icosphere(uint32_t n_subdivisions);
pmp_mesh *pmp_quad_sphere(uint32_t n_subdivisions);
pmp_mesh *pmp_uv_sphere(const float center[3], float radius, uint32_t n_slices, uint32_t n_stacks);
pmp_mesh *pmp_plane(uint32_t resolution);
pmp_mesh *pmp_cone(uint32_t n_subdivisions, float radius, float height);
pmp_mesh *pmp_cylinder(uint32_t n_subdivisions, float radius, float height);
pmp_mesh *pmp_torus(uint32_t radial_resolution, uint32_t tubular_resolution,
                    float radius, float thickness);
void pmp_explicit_smoothing(pmp_mesh *mesh, uint32_t iterations, uint32_t use_uniform_laplace);
void pmp_implicit_smoothing(pmp_mesh *mesh, float timestep, uint32_t iterations,
                           uint32_t use_uniform_laplace, uint32_t rescale);
void pmp_catmull_clark_subdivision(pmp_mesh *mesh, uint32_t boundary_handling);
void pmp_loop_subdivision(pmp_mesh *mesh, uint32_t boundary_handling);
void pmp_quad_tri_subdivision(pmp_mesh *mesh, uint32_t boundary_handling);
void pmp_linear_subdivision(pmp_mesh *mesh);
void pmp_triangulate(pmp_mesh *mesh);
void pmp_triangulate_face(pmp_mesh *mesh, uint32_t face);
void pmp_bounds(const pmp_mesh *mesh, float out_min_max[6]);
void pmp_flip_faces(pmp_mesh *mesh);
float pmp_min_face_area(const pmp_mesh *mesh);
float pmp_edge_length(const pmp_mesh *mesh, uint32_t edge);
float pmp_mean_edge_length(const pmp_mesh *mesh);
float pmp_min_edge_length(const pmp_mesh *mesh);
int32_t pmp_connected_components(pmp_mesh *mesh);

#ifdef __cplusplus
}
#endif
#endif
