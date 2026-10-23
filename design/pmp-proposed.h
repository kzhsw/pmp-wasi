/* Unimplemented API design only. These declarations are not linkable exports.
 * The implemented ABI lives in include/pmp.h. No future ABI version is frozen.
 * SPDX-License-Identifier: MIT
 */
#ifndef PMP_PROPOSED_H
#define PMP_PROPOSED_H
#include "../include/pmp.h"
#ifdef __cplusplus
extern "C" {
#endif

typedef struct pmp_sparse_matrix pmp_sparse_matrix;
typedef struct pmp_diagonal_matrix pmp_diagonal_matrix;
typedef struct pmp_dense_matrix pmp_dense_matrix;
typedef struct pmp_vertex_buffer pmp_vertex_buffer;

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


/* Proposed declarations retain native PMP names/arguments. Standalone scalar
 * math helpers remain C-only proposals and are not in the Wasm allowlist. */
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
void pmp_analyze(const pmp_mesh *mesh, pmp_mesh_analysis *out);
float pmp_clamp_cot(float v);
float pmp_clamp_cos(float v);
float pmp_angle(const float v0[3], const float v1[3]);
float pmp_sin(const float v0[3], const float v1[3]);
float pmp_cos(const float v0[3], const float v1[3]);
float pmp_cotan(const float v0[3], const float v1[3]);
float pmp_triangle_area(const float p0[3], const float p1[3], const float p2[3]);
float pmp_face_area(const pmp_mesh *mesh, uint32_t face);
float pmp_voronoi_area(const pmp_mesh *mesh, uint32_t vertex);
float pmp_voronoi_area_mixed(const pmp_mesh *mesh, uint32_t vertex);
float pmp_edge_area(const pmp_mesh *mesh, uint32_t edge);
void pmp_centroid_face(const pmp_mesh *mesh, uint32_t face, float out[3]);
void pmp_dual(pmp_mesh *mesh);
double pmp_cotan_weight(const pmp_mesh *mesh, uint32_t edge);
void pmp_laplace(const pmp_mesh *mesh, uint32_t vertex, float out[3]);
float pmp_dist_point_line_segment(const float p[3], const float v0[3],
                                  const float v1[3], float nearest_point[3]);
float pmp_dist_point_triangle(const float p[3], const float v0[3],
                              const float v1[3], const float v2[3], float nearest_point[3]);
uint32_t pmp_geodesics(pmp_mesh *mesh, const uint32_t *seeds, uint32_t seed_count,
                       float maxdist, uint32_t maxnum, pmp_vertex_buffer *neighbors);
void pmp_geodesics_heat(pmp_mesh *mesh, const uint32_t *seeds, uint32_t seed_count);
void pmp_uniform_mass_matrix(const pmp_mesh *mesh, pmp_diagonal_matrix *out);
void pmp_uniform_laplace_matrix(const pmp_mesh *mesh, pmp_sparse_matrix *out);
void pmp_mass_matrix(const pmp_mesh *mesh, pmp_diagonal_matrix *out);
void pmp_laplace_matrix(const pmp_mesh *mesh, pmp_sparse_matrix *out, uint32_t clamp);
void pmp_gradient_matrix(const pmp_mesh *mesh, pmp_sparse_matrix *out);
void pmp_divergence_matrix(const pmp_mesh *mesh, pmp_sparse_matrix *out);
void pmp_coordinates_to_matrix(const pmp_mesh *mesh, pmp_dense_matrix *out);
void pmp_matrix_to_coordinates(const pmp_dense_matrix *matrix, pmp_mesh *mesh);
void pmp_harmonic_parameterization(pmp_mesh *mesh, uint32_t use_uniform_weights);
void pmp_lscm_parameterization(pmp_mesh *mesh);
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
void pmp_flip_faces(pmp_mesh *mesh);
float pmp_edge_length(const pmp_mesh *mesh, uint32_t edge);

#ifdef __cplusplus
}
#endif
#endif
