// SPDX-License-Identifier: MIT
// Bounded model-based C11 fuzz harness. Compile the port with ASan and UBSan.
#include "pmp.h"
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t seed, state;
static uint64_t assertions;
static const char* stage = "setup";
static const char* families[] = {
    "decimate", "uniform_remeshing", "adaptive_remeshing", "catmull_clark_subdivision",
    "loop_subdivision", "quad_tri_subdivision", "linear_subdivision", "explicit_smoothing",
    "implicit_smoothing", "fill_hole", "triangulate", "curvature", "fair", "connected_components"
};

static void verify(int condition, const char* expression, int line)
{
    ++assertions;
    if (!condition) {
        fprintf(stderr, "C fuzz failed: seed=%" PRIu32 " stage=%s line=%d: %s\n", seed, stage, line, expression);
        exit(1);
    }
}
#define CHECK(expression) verify(!!(expression), #expression, __LINE__)
static void phase(const char* name)
{
    stage = name;
    fprintf(stderr, "FUZZ seed=%" PRIu32 " stage=%s\n", seed, stage);
    fflush(stderr);
}
static uint32_t random_u32(void)
{
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
}
static float unit(void) { return (float)((double)random_u32() / 4294967296.0); }
static void near(double actual, double expected)
{
    CHECK(isfinite(actual) && fabs(actual - expected) <= 5e-5 * fmax(1.0, fabs(expected)));
}
static pmp_mesh_view view(pmp_mesh* mesh)
{
    pmp_mesh_view result;
    pmp_mesh_get_view(mesh, &result);
    return result;
}

static void inspect(pmp_mesh* mesh, int euler)
{
    const pmp_mesh_view m = view(mesh);
    CHECK(m.vertices_size == m.n_vertices && m.edges_size == m.n_edges && m.faces_size == m.n_faces);
    CHECK((int64_t)m.n_vertices - m.n_edges + m.n_faces == euler);
    for (uint32_t i = 0; i < m.n_vertices * 3; ++i) CHECK(isfinite(m.positions[i]));
    for (uint32_t v = 0; v < m.n_vertices; ++v) {
        CHECK(!m.deleted_vertices[v]);
        const uint32_t h = m.vertex_halfedges[v];
        CHECK(h == PMP_INVALID_INDEX || (h < m.n_edges * 2 && m.halfedges[h ^ 1].vertex == v));
    }
    uint32_t boundary = 0;
    for (uint32_t h = 0; h < m.n_edges * 2; ++h) {
        const pmp_halfedge c = m.halfedges[h];
        CHECK((c.face == PMP_INVALID_INDEX || c.face < m.n_faces) && c.vertex < m.n_vertices);
        CHECK(c.next_halfedge < m.n_edges * 2 && c.prev_halfedge < m.n_edges * 2);
        CHECK(m.halfedges[c.next_halfedge].prev_halfedge == h);
        CHECK(m.halfedges[c.prev_halfedge].next_halfedge == h);
        CHECK(m.halfedges[c.next_halfedge ^ 1].vertex == c.vertex);
        CHECK(m.halfedges[c.next_halfedge].face == c.face);
        boundary += c.face == PMP_INVALID_INDEX;
    }
    unsigned char* owned = calloc(m.n_edges * 2, 1);
    CHECK(owned != NULL);
    uint32_t visited = 0;
    for (uint32_t f = 0; f < m.n_faces; ++f) {
        CHECK(!m.deleted_faces[f]);
        const uint32_t first = m.face_halfedges[f];
        uint32_t h = first, count = 0;
        do {
            CHECK(h < m.n_edges * 2 && count < m.n_edges * 2 && !owned[h]);
            CHECK(m.halfedges[h].face == f);
            owned[h] = 1;
            ++visited;
            ++count;
            h = m.halfedges[h].next_halfedge;
        } while (h != first);
        CHECK(count >= 3);
    }
    for (uint32_t e = 0; e < m.n_edges; ++e) CHECK(!m.deleted_edges[e]);
    CHECK(visited + boundary == m.n_edges * 2);
    free(owned);
}

static void construct(pmp_mesh* mesh, const float* points, uint32_t vertices,
                      const uint32_t* corners, const uint32_t* offsets, uint32_t faces, uint32_t winding)
{
    CHECK(pmp_mesh_add_vertices(mesh, vertices) == 0);
    memcpy(view(mesh).positions, points, vertices * 3 * sizeof(float));
    uint32_t* input = malloc(offsets[faces] * sizeof(uint32_t));
    uint32_t* mapping = malloc(offsets[faces] * sizeof(uint32_t));
    CHECK(input && mapping);
    for (uint32_t f = 0; f < faces; ++f)
        for (uint32_t i = offsets[f]; i < offsets[f + 1]; ++i)
            input[i] = corners[winding ? offsets[f] + offsets[f + 1] - 1 - i : i];
    pmp_mesh_add_faces_winding(mesh, input, offsets, faces, winding, mapping);
    const pmp_mesh_view m = view(mesh);
    for (uint32_t f = 0; f < faces; ++f)
        for (uint32_t i = offsets[f]; i < offsets[f + 1]; ++i) {
            CHECK(mapping[i] < m.n_edges * 2);
            CHECK(m.halfedges[mapping[i]].vertex == input[i] && m.halfedges[mapping[i]].face == f);
        }
    free(mapping);
    free(input);
}

static void measurements(pmp_mesh* mesh)
{
    pmp_mesh_view m = view(mesh);
    float bounds[6], center[3];
    pmp_bounds(mesh, bounds);
    pmp_centroid(mesh, center);
    for (uint32_t axis = 0; axis < 3; ++axis) {
        float lo = m.positions[axis], hi = lo;
        for (uint32_t v = 0; v < m.n_vertices; ++v) {
            lo = fminf(lo, m.positions[v * 3 + axis]);
            hi = fmaxf(hi, m.positions[v * 3 + axis]);
        }
        CHECK(bounds[axis] == lo && bounds[axis + 3] == hi);
        CHECK(center[axis] >= lo - 1e-5f && center[axis] <= hi + 1e-5f);
    }
    double area_sum = 0, edge_sum = 0, min_edge = INFINITY, min_area = INFINITY;
    for (uint32_t e = 0; e < m.n_edges; ++e) {
        const float* a = m.positions + m.halfedges[e * 2].vertex * 3;
        const float* b = m.positions + m.halfedges[e * 2 + 1].vertex * 3;
        double squared = 0;
        for (uint32_t i = 0; i < 3; ++i) squared += (double)(a[i] - b[i]) * (a[i] - b[i]);
        const double length = sqrt(squared);
        edge_sum += length;
        min_edge = fmin(min_edge, length);
    }
    for (uint32_t f = 0; f < m.n_faces; ++f) {
        const uint32_t h = m.face_halfedges[f], next = m.halfedges[h].next_halfedge;
        CHECK(m.halfedges[m.halfedges[next].next_halfedge].next_halfedge == h);
        const float* a = m.positions + m.halfedges[h].vertex * 3;
        const float* b = m.positions + m.halfedges[next].vertex * 3;
        const float* c = m.positions + m.halfedges[m.halfedges[next].next_halfedge].vertex * 3;
        double u[3], v[3], cross[3];
        for (uint32_t i = 0; i < 3; ++i) { u[i] = b[i] - a[i]; v[i] = c[i] - a[i]; }
        for (uint32_t i = 0; i < 3; ++i) cross[i] = u[(i + 1) % 3] * v[(i + 2) % 3] - u[(i + 2) % 3] * v[(i + 1) % 3];
        const double area = 0.5 * sqrt(cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]);
        CHECK(area > 0);
        area_sum += area;
        min_area = fmin(min_area, area);
    }
    const float area = pmp_surface_area(mesh), mean = pmp_mean_edge_length(mesh);
    near(area, area_sum);
    near(mean, edge_sum / m.n_edges);
    near(pmp_min_edge_length(mesh), min_edge);
    near(pmp_min_face_area(mesh), min_area);
    float* saved = malloc(m.n_vertices * 3 * sizeof(float));
    CHECK(saved != NULL);
    memcpy(saved, m.positions, m.n_vertices * 3 * sizeof(float));
    const float shift[] = {0.5f, -0.25f, 0.75f};
    for (uint32_t i = 0; i < m.n_vertices * 3; ++i) m.positions[i] = 1.25f * saved[i] + shift[i % 3];
    near(pmp_surface_area(mesh), area * 1.25 * 1.25);
    near(pmp_mean_edge_length(mesh), mean * 1.25);
    float moved[3];
    pmp_centroid(mesh, moved);
    for (uint32_t i = 0; i < 3; ++i) near(moved[i], 1.25 * center[i] + shift[i]);
    memcpy(view(mesh).positions, saved, m.n_vertices * 3 * sizeof(float));
    free(saved);
}

struct channel { char name[32]; uint32_t domain, type; size_t bytes; void* saved; };
static void channels(pmp_mesh* mesh, uint32_t n)
{
    static const uint32_t components[] = {1, 1, 1, 1, 1, 2, 3, 4, 4, 4, 4};
    static const uint32_t sizes[] = {1, 4, 4, 4, 8, 4, 4, 4, 4, 2, 1};
    struct channel channels[11];
    for (uint32_t type = 0; type <= PMP_RGBA8; ++type) {
        struct channel* c = channels + type;
        c->type = type;
        c->domain = random_u32() % 4;
        snprintf(c->name, sizeof(c->name), "user:fuzz-%" PRIu32, type);
        const pmp_mesh_view m = view(mesh);
        const uint32_t count = c->domain == PMP_VERTEX ? m.n_vertices : c->domain == PMP_HALFEDGE ? m.n_edges * 2 :
                               c->domain == PMP_EDGE ? m.n_edges : m.n_faces;
        void* data = pmp_mesh_property(mesh, c->domain, type, c->name, 1);
        c->bytes = (size_t)count * components[type] * sizes[type];
        CHECK(data != NULL && (uintptr_t)data % sizes[type] == 0);
        for (size_t i = 0; i < c->bytes; ++i) CHECK(((unsigned char*)data)[i] == 0);
        for (uint32_t i = 0; i < count * components[type]; ++i) {
            if (type == PMP_BOOL) ((uint8_t*)data)[i] = random_u32() & 1;
            else if (type == PMP_I32) ((int32_t*)data)[i] = (int32_t)(random_u32() % 65536) - 32768;
            else if (type == PMP_U32 || type == PMP_VEC4U32) ((uint32_t*)data)[i] = random_u32();
            else if (type == PMP_F64) ((double*)data)[i] = ((double)unit() - 0.5) * 1e20;
            else if (type == PMP_VEC4U16) ((uint16_t*)data)[i] = (uint16_t)random_u32();
            else if (type == PMP_RGBA8) ((uint8_t*)data)[i] = (uint8_t)random_u32();
            else ((float*)data)[i] = ((int)(random_u32() % 257) - 128) / 16.0f;
        }
        c->saved = malloc(c->bytes);
        CHECK(c->saved != NULL);
        memcpy(c->saved, data, c->bytes);
    }
    pmp_mesh_reserve(mesh, n * n * 3, n * n * 8, n * n * 4);
    pmp_mesh_garbage_collection(mesh);
    pmp_vertex_normals(mesh);
    pmp_face_normals(mesh);
    CHECK(pmp_detect_boundary(mesh) == 4 * (n - 1));
    pmp_clear_features(mesh);
    pmp_explicit_smoothing(mesh, 1 + random_u32() % 2, random_u32() & 1);
    for (uint32_t type = 0; type <= PMP_RGBA8; ++type) {
        const struct channel* c = channels + type;
        const void* current = pmp_mesh_property(mesh, c->domain, c->type, c->name, 0);
        CHECK(current != NULL && memcmp(current, c->saved, c->bytes) == 0);
        CHECK(pmp_mesh_remove_property(mesh, c->domain, c->name) == 1);
        free(c->saved);
    }
    CHECK(pmp_mesh_remove_property(mesh, PMP_VERTEX, "v:feature") == 1);
    CHECK(pmp_mesh_remove_property(mesh, PMP_EDGE, "e:feature") == 1);
}

static void run_seed(uint32_t value)
{
    seed = value;
    state = seed ? seed : UINT32_C(0x6d2b79f5);
    phase("construct");
    const uint32_t n = 5 + random_u32() % 2;
    const float scale = 0.8f + unit() * 0.4f, shift[] = {unit() * 2, -unit(), unit()};
    float positions[6 * 6 * 3];
    uint32_t corners[5 * 5 * 6], offsets[5 * 5 * 2 + 1], face_count = 0, corner_count = 0;
    const int quads = random_u32() & 1;
    for (uint32_t y = 0; y < n; ++y) for (uint32_t x = 0; x < n; ++x) {
        const uint32_t i = (y * n + x) * 3;
        positions[i] = scale * (x + 0.025f * unit()) + shift[0];
        positions[i + 1] = scale * (y + 0.025f * unit()) + shift[1];
        positions[i + 2] = scale * 0.018f * x * (n - 1 - x) * y * (n - 1 - y) + shift[2];
    }
    offsets[0] = 0;
    for (uint32_t y = 0; y + 1 < n; ++y) for (uint32_t x = 0; x + 1 < n; ++x) {
        const uint32_t a = y * n + x, b = a + 1, c = a + n + 1, d = a + n;
        const uint32_t quad[] = {a, b, c, d}, triangles[] = {a, b, c, a, c, d};
        const uint32_t* source = quads ? quad : triangles;
        for (uint32_t i = 0; i < (quads ? 4u : 6u); ++i) corners[corner_count++] = source[i];
        if (quads) offsets[++face_count] = corner_count;
        else { offsets[++face_count] = corner_count - 3; offsets[++face_count] = corner_count; }
    }
    pmp_mesh* mesh = pmp_mesh_create();
    construct(mesh, positions, n * n, corners, offsets, face_count, random_u32() & 1);
    inspect(mesh, 1);
    pmp_triangulate(mesh);
    CHECK(view(mesh).n_faces == 2 * (n - 1) * (n - 1));
    phase("measurements");
    measurements(mesh);
    phase("typed channels and storage");
    channels(mesh, n);
    pmp_mesh_view borrowed = view(mesh);
    float* alias = pmp_mesh_property(mesh, PMP_VERTEX, PMP_VEC3F, "v:point", 0);
    CHECK(alias == borrowed.positions);
    const float original = alias[0];
    alias[0] += 0.125f;
    CHECK(view(mesh).positions[0] == alias[0]);
    alias[0] = original;
    pmp_mesh* other = pmp_mesh_create();
    pmp_mesh_reserve(other, 4096 + random_u32() % 4096, 4096, 2048);
    CHECK(view(mesh).positions == alias && view(mesh).positions[0] == original);
    pmp_mesh_destroy(other);
    const uint32_t family = seed % 14;
    phase(families[family]);
    const pmp_mesh_view before = view(mesh);
    if (family == 0) pmp_decimate(mesh, n * n * 7 / 10, 0, 0, 0, 0, 0, 0.01f, 1);
    else if (family == 1) pmp_uniform_remeshing(mesh, scale * 0.65f, 1, random_u32() & 1);
    else if (family == 2) pmp_adaptive_remeshing(mesh, scale * 0.55f, scale * 1.1f, scale * 0.05f, 1, random_u32() & 1);
    else if (family == 3) pmp_catmull_clark_subdivision(mesh, random_u32() & 1);
    else if (family == 4) pmp_loop_subdivision(mesh, random_u32() & 1);
    else if (family == 5) pmp_quad_tri_subdivision(mesh, random_u32() & 1);
    else if (family == 6) pmp_linear_subdivision(mesh);
    else if (family == 7) pmp_explicit_smoothing(mesh, 2, random_u32() & 1);
    else if (family == 8) pmp_implicit_smoothing(mesh, 0.03f, 2, random_u32() & 1, 0);
    else if (family == 9) {
        pmp_mesh_clear(mesh);
        float points[] = {1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1};
        for (uint32_t i = 0; i < 12; ++i) points[i] *= scale;
        const uint32_t input[] = {0, 2, 1, 0, 1, 3, 0, 3, 2}, starts[] = {0, 3, 6, 9};
        construct(mesh, points, 4, input, starts, 3, 0);
        const pmp_mesh_view m = view(mesh);
        uint32_t h = 0;
        while (h < m.n_edges * 2 && m.halfedges[h].face != PMP_INVALID_INDEX) ++h;
        CHECK(h < m.n_edges * 2);
        pmp_fill_hole(mesh, h);
        CHECK(view(mesh).n_faces == 4 && view(mesh).n_vertices == 4);
        near(fabs(pmp_volume(mesh)), 8.0 / 3 * scale * scale * scale);
    } else if (family == 10) {
        pmp_mesh_clear(mesh);
        const uint32_t count = 5 + random_u32() % 5;
        float points[9 * 3];
        uint32_t polygon[9], starts[] = {0, count};
        for (uint32_t i = 0; i < count; ++i) {
            points[i * 3] = (float)cos(i * 6.283185307179586 / count);
            points[i * 3 + 1] = (float)sin(i * 6.283185307179586 / count);
            points[i * 3 + 2] = 0;
            polygon[i] = i;
        }
        construct(mesh, points, count, polygon, starts, 1, random_u32() & 1);
        ((uint32_t*)pmp_mesh_property(mesh, PMP_FACE, PMP_U32, "user:material", 1))[0] = seed;
        pmp_triangulate_face(mesh, 0);
        CHECK(view(mesh).n_faces == count - 2 && view(mesh).n_edges == 2 * count - 3);
        const uint32_t* materials = pmp_mesh_property(mesh, PMP_FACE, PMP_U32, "user:material", 0);
        for (uint32_t f = 0; f < count - 2; ++f) CHECK(materials[f] == seed);
        pmp_triangulate(mesh);
        CHECK(view(mesh).n_faces == count - 2);
    } else if (family == 11) {
        pmp_curvature(mesh, random_u32() % 5, random_u32() % 2, random_u32() & 1, random_u32() & 1);
        const float* curvature = pmp_mesh_property(mesh, PMP_VERTEX, PMP_F32, "v:curv", 0);
        CHECK(curvature != NULL);
        for (uint32_t i = 0; i < before.n_vertices; ++i) CHECK(isfinite(curvature[i]));
    } else if (family == 12) {
        pmp_fair(mesh, 1 + random_u32() % 2);
        pmp_minimize_area(mesh);
        pmp_minimize_curvature(mesh);
        CHECK(view(mesh).n_vertices == before.n_vertices && view(mesh).n_faces == before.n_faces);
    } else {
        pmp_mesh_add_vertices(mesh, 3);
        CHECK(pmp_connected_components(mesh) == 4);
        const int32_t* labels = pmp_mesh_property(mesh, PMP_VERTEX, PMP_I32, "v:component", 0);
        int32_t saved[6 * 6 + 3];
        memcpy(saved, labels, (n * n + 3) * sizeof(int32_t));
        for (uint32_t i = 0; i < n * n; ++i) CHECK(labels[i] == 0);
        for (uint32_t i = 0; i < 3; ++i) CHECK(labels[n * n + i] == (int32_t)i + 1);
        CHECK(pmp_connected_components(mesh) == 4);
        CHECK(memcmp(saved, pmp_mesh_property(mesh, PMP_VERTEX, PMP_I32, "v:component", 0), (n * n + 3) * sizeof(int32_t)) == 0);
    }
    inspect(mesh, family == 9 ? 2 : family == 13 ? 4 : 1);
    if (family == 0) CHECK(view(mesh).n_vertices < before.n_vertices);
    if (family >= 3 && family <= 6) CHECK(view(mesh).n_vertices > before.n_vertices && view(mesh).n_faces > before.n_faces);
    if (family == 7 || family == 8) CHECK(view(mesh).n_vertices == before.n_vertices && view(mesh).n_faces == before.n_faces);
    phase("clear reuse destroy");
    pmp_mesh_clear(mesh);
    CHECK(view(mesh).n_vertices == 0 && view(mesh).n_edges == 0 && view(mesh).n_faces == 0);
    const float triangle[] = {0, 0, 0, 1, 0, 0, 0, 1, 0};
    const uint32_t input[] = {0, 1, 2}, starts[] = {0, 3};
    construct(mesh, triangle, 3, input, starts, 1, 0);
    inspect(mesh, 1);
    pmp_mesh_destroy(mesh);
    const uint32_t bytes = 1 + random_u32() % 257;
    void* allocation = pmp_alloc(bytes);
    CHECK(allocation && (uintptr_t)allocation % 16 == 0);
    memset(allocation, (int)(seed & 255), bytes);
    pmp_free(allocation);
    CHECK(pmp_alloc(0) == NULL);
    pmp_free(NULL);
}

int main(int argc, char** argv)
{
    if (argc != 3) { fprintf(stderr, "usage: fuzz-native SEED COUNT\n"); return 2; }
    char *end_seed, *end_count;
    const unsigned long long first = strtoull(argv[1], &end_seed, 10), count = strtoull(argv[2], &end_count, 10);
    if (*end_seed || *end_count || first > UINT32_MAX || count < 1 || count > 256) return 2;
    CHECK(pmp_abi_version() == PMP_ABI_VERSION);
    for (uint32_t i = 0; i < count; ++i) run_seed((uint32_t)(first + i));
    printf("{\"seed\":%llu,\"seeds\":%llu,\"assertions\":%" PRIu64 "}\n", first, count, assertions);
    return 0;
}
