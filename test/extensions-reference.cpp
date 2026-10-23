// SPDX-License-Identifier: MIT
// Host-only fixtures from the pinned, unmodified upstream PMP sources.
#include "pmp/surface_mesh.h"
#include "pmp/algorithms/curvature.h"
#include "pmp/algorithms/differential_geometry.h"
#include "pmp/algorithms/fairing.h"
#include "pmp/algorithms/smoothing.h"
#include "pmp/algorithms/triangulation.h"
#include "pmp/algorithms/utilities.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

struct Input
{
    std::vector<std::array<float, 3>> positions;
    std::vector<std::vector<uint32_t>> faces;
    std::vector<uint32_t> selected;
};

template <class Range> void array(const Range& values)
{
    std::cout << '[';
    bool comma = false;
    for (const auto& value : values)
    {
        if (comma) std::cout << ',';
        comma = true;
        std::cout << value;
    }
    std::cout << ']';
}

template <class Range> void nested(const Range& values)
{
    std::cout << '[';
    bool comma = false;
    for (const auto& value : values)
    {
        if (comma) std::cout << ',';
        comma = true;
        array(value);
    }
    std::cout << ']';
}

void positions(const std::vector<std::array<float, 3>>& points)
{
    std::cout << '[';
    bool comma = false;
    for (const auto& point : points) for (const auto value : point)
    {
        if (!std::isfinite(value)) throw std::runtime_error("Non-finite fixture position");
        if (comma) std::cout << ',';
        comma = true;
        std::cout << value;
    }
    std::cout << ']';
}

void geometry(const pmp::SurfaceMesh& mesh)
{
    std::vector<std::array<float, 3>> points;
    std::vector<std::vector<uint32_t>> faces;
    for (auto v : mesh.vertices())
    {
        const auto p = mesh.position(v);
        points.push_back({p[0], p[1], p[2]});
    }
    for (auto f : mesh.faces())
    {
        std::vector<uint32_t> polygon;
        for (auto v : mesh.vertices(f)) polygon.push_back(v.idx());
        faces.push_back(polygon);
    }
    std::cout << "\"positions\":";
    positions(points);
    std::cout << ",\"faces\":";
    nested(faces);
    std::cout << ",\"counts\":[" << mesh.n_vertices() << ',' << mesh.n_edges() << ',' << mesh.n_faces() << ']';
}

void fixture(const std::string& name, const std::string& operation,
             const std::vector<double>& args, const Input& input)
{
    pmp::SurfaceMesh mesh;
    for (const auto& p : input.positions) mesh.add_vertex(pmp::Point(p[0], p[1], p[2]));
    for (const auto& polygon : input.faces)
    {
        std::vector<pmp::Vertex> vertices;
        for (auto i : polygon) vertices.emplace_back(i);
        mesh.add_face(vertices);
    }
    if (!input.selected.empty())
    {
        auto selected = mesh.vertex_property<bool>("v:selected", false);
        for (auto i : input.selected) selected[pmp::Vertex(i)] = true;
    }
    int components = 0;
    try
    {
        if (operation == "pmp_triangulate") pmp::triangulate(mesh);
        else if (operation == "pmp_triangulate_face") pmp::triangulate(mesh, pmp::Face(args[0]));
        else if (operation == "pmp_connected_components") components = pmp::connected_components(mesh);
        else if (operation == "pmp_curvature")
            pmp::curvature(mesh, static_cast<pmp::Curvature>(int(args[0])), args[1], args[2], args[3]);
        else if (operation == "pmp_fair") pmp::fair(mesh, args[0]);
        else if (operation == "pmp_minimize_area") pmp::minimize_area(mesh);
        else if (operation == "pmp_minimize_curvature") pmp::minimize_curvature(mesh);
        else if (operation != "measurements") throw std::runtime_error("Unknown fixture operation");
    }
    catch (const std::exception& error) { throw std::runtime_error(name + ": " + error.what()); }
    static bool comma = false;
    if (comma) std::cout << ',';
    comma = true;
    std::cout << "{\"name\":\"" << name << "\",\"operation\":\"" << operation << "\",\"args\":";
    array(args);
    std::cout << ",\"input\":{\"positions\":";
    positions(input.positions);
    std::cout << ",\"faces\":";
    nested(input.faces);
    if (!input.selected.empty()) { std::cout << ",\"selected\":"; array(input.selected); }
    std::cout << "},\"output\":{";
    geometry(mesh);
    if (operation == "pmp_connected_components")
    {
        std::cout << ",\"components\":" << components << ",\"values\":";
        std::vector<int> values;
        const auto property = mesh.get_vertex_property<int>("v:component");
        for (auto v : mesh.vertices()) values.push_back(property[v]);
        array(values);
    }
    else if (operation == "pmp_curvature")
    {
        std::cout << ",\"values\":";
        std::vector<float> values;
        const auto property = mesh.get_vertex_property<pmp::Scalar>("v:curv");
        for (auto v : mesh.vertices())
        {
            if (!std::isfinite(property[v])) throw std::runtime_error(name + ": Non-finite curvature");
            values.push_back(property[v]);
        }
        array(values);
    }
    else if (operation == "measurements")
    {
        const auto box = pmp::bounds(mesh);
        const auto center = pmp::centroid(mesh);
        std::cout << ",\"bounds\":";
        array(std::array<float, 6>{box.min()[0], box.min()[1], box.min()[2], box.max()[0], box.max()[1], box.max()[2]});
        std::cout << ",\"surfaceArea\":" << pmp::surface_area(mesh);
        if (mesh.is_triangle_mesh()) std::cout << ",\"volume\":" << pmp::volume(mesh);
        std::cout << ",\"centroid\":";
        array(std::array<float, 3>{center[0], center[1], center[2]});
        std::cout << ",\"meanEdgeLength\":" << pmp::mean_edge_length(mesh)
                  << ",\"minEdgeLength\":" << pmp::min_edge_length(mesh)
                  << ",\"minFaceArea\":" << pmp::min_face_area(mesh);
    }
    std::cout << "}}";
}

Input grid(unsigned n, bool quads = false)
{
    Input input;
    for (unsigned y = 0; y < n; ++y) for (unsigned x = 0; x < n; ++x)
        input.positions.push_back({0.6f * x + 0.013f * ((7 * x + 3 * y) % 5),
                                   0.55f * y + 0.017f * ((2 * x + 11 * y) % 7),
                                   0.018f * x * (n - 1 - x) * y * (n - 1 - y) +
                                       0.021f * ((3 * x + y) % 5)});
    for (unsigned y = 0; y + 1 < n; ++y) for (unsigned x = 0; x + 1 < n; ++x)
    {
        const auto a = y * n + x, b = a + 1, c = a + n + 1, d = a + n;
        if (quads) input.faces.push_back({a, b, c, d});
        else { input.faces.push_back({a, b, c}); input.faces.push_back({a, c, d}); }
    }
    return input;
}

// A procedural descriptor and selected samples keep this large solver
// reference compact. Positions are rounded to float exactly as on Wasm input.
void large_solver_reference()
{
    constexpr unsigned n = 96;
    constexpr double pi = 3.141592653589793238462643383279502884;
    pmp::SurfaceMesh mesh;
    mesh.reserve((n + 1) * (n + 1), 3 * n * n + 2 * n, 2 * n * n);
    for (unsigned y = 0; y <= n; ++y) for (unsigned x = 0; x <= n; ++x)
        mesh.add_vertex(pmp::Point(float(double(x) / n), float(double(y) / n),
            float(0.05 * std::sin(pi * x / n) * std::sin(pi * y / n))));
    for (unsigned y = 0; y < n; ++y) for (unsigned x = 0; x < n; ++x)
    {
        const auto a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
        mesh.add_triangle(pmp::Vertex(a), pmp::Vertex(b), pmp::Vertex(c));
        mesh.add_triangle(pmp::Vertex(a), pmp::Vertex(c), pmp::Vertex(d));
    }
    std::vector<uint32_t> samples;
    for (unsigned y : {0u, 1u, 2u, 24u, 48u, 72u, 94u, 95u, 96u})
        for (unsigned x : {0u, 1u, 2u, 24u, 48u, 72u, 94u, 95u, 96u})
            samples.push_back(y * (n + 1) + x);
    std::cout << ",{\"name\":\"large-solver-stack-regression\",\"operation\":\"large_solver\","
                 "\"input\":{\"generator\":\"curved-triangle-grid\",\"cells\":96},\"output\":{\"counts\":["
              << mesh.n_vertices() << ',' << mesh.n_edges() << ',' << mesh.n_faces() << "],\"sampleVertices\":";
    array(samples);
    std::cout << ",\"phases\":[";
    for (unsigned phase = 0; phase < 2; ++phase)
    {
        if (phase == 0) pmp::implicit_smoothing(mesh, float(0.1 / (n * n)), 1, false, false);
        else pmp::fair(mesh, 2);
        if (phase) std::cout << ',';
        std::vector<std::array<float, 3>> points;
        for (auto index : samples)
        {
            const auto p = mesh.position(pmp::Vertex(index));
            points.push_back({p[0], p[1], p[2]});
        }
        std::array<double, 3> sums{};
        float minimum = 1, maximum = -1;
        for (auto v : mesh.vertices())
        {
            const auto p = mesh.position(v);
            for (unsigned c = 0; c < 3; ++c) sums[c] += p[c];
            minimum = std::min(minimum, p[2]);
            maximum = std::max(maximum, p[2]);
        }
        std::cout << "{\"samples\":";
        positions(points);
        std::cout << ",\"surfaceArea\":" << pmp::surface_area(mesh) << ",\"heightRange\":";
        array(std::array<float, 2>{minimum, maximum});
        std::cout << ",\"coordinateSums\":";
        array(sums);
        std::cout << '}';
    }
    std::cout << "]}}";
}

int main()
{
    try
    {
        std::cout << std::setprecision(9) << '[';
        const Input concave{{{0, 0, 0}, {3, 0, 0}, {3, 2, 0}, {1.2f, 0.8f, 0}, {0, 2, 0}},
                            {{0, 1, 2, 3, 4}}, {}};
        const Input adjacent{{{0, 0, 0}, {1, 0, 0.1f}, {2.3f, 0, 0}, {0, 1.2f, 0},
                               {1, 1, 0.25f}, {2, 1.1f, 0}}, {{0, 1, 4, 3}, {1, 2, 5, 4}}, {}};
        fixture("triangulate-concave-pentagon", "pmp_triangulate", {}, concave);
        fixture("triangulate-adjacent-quads", "pmp_triangulate", {}, adjacent);
        fixture("triangulate-one-face", "pmp_triangulate_face", {1}, adjacent);
        fixture("triangulate-triangles-noop", "pmp_triangulate", {}, grid(3));
        fixture("components-empty", "pmp_connected_components", {}, {});
        const Input disconnected{{{0, 0, 0}, {1, 0, 0}, {0, 1, 0}, {3, 0, 0}, {4, 0, 0},
                                   {3, 1, 0}, {10, 2, 3}, {-4, 3, 7}}, {{0, 1, 2}, {3, 4, 5}}, {}};
        fixture("components-disconnected-isolated", "pmp_connected_components", {}, disconnected);
        fixture("components-polygons", "pmp_connected_components", {}, adjacent);
        const Input tetra{{{1, 1, 1}, {-1, -1, 1}, {-1, 1, -1}, {1, -1, -1}},
                          {{0, 2, 1}, {0, 1, 3}, {0, 3, 2}, {1, 2, 3}}, {}};
        fixture("measurements-tetrahedron", "measurements", {}, tetra);
        auto reversed = tetra;
        for (auto& f : reversed.faces) std::swap(f[0], f[2]);
        fixture("measurements-reversed-tetrahedron", "measurements", {}, reversed);
        auto translated = tetra;
        for (auto& p : translated.positions)
        {
            p[0] = 2.5f * p[0] + 13.25f;
            p[1] = 1.75f * p[1] - 4.5f;
            p[2] = 0.75f * p[2] + 2.125f;
        }
        fixture("measurements-translated-scaled-tetrahedron", "measurements", {}, translated);
        fixture("measurements-open-grid", "measurements", {}, grid(4));
        fixture("measurements-polygons", "measurements", {}, adjacent);
        for (unsigned kind = 0; kind < 5; ++kind)
            for (unsigned mode = 0; mode < 4; ++mode)
                fixture("curvature-kind-" + std::to_string(kind) + "-mode-" + std::to_string(mode),
                        "pmp_curvature", {double(kind), mode % 2 ? 2.0 : 0.0, mode >= 2 ? 1.0 : 0.0,
                                          mode % 2 ? 1.0 : 0.0}, grid(5));
        fixture("curvature-polygon-tensor", "pmp_curvature", {2, 1, 1, 1}, grid(5, true));
        fixture("curvature-closed-gauss", "pmp_curvature", {3, 0, 0, 0}, tetra);
        for (unsigned k = 1; k <= 3; ++k)
            fixture("fair-k-" + std::to_string(k), "pmp_fair", {double(k)}, grid(9));
        fixture("fair-minimize-area", "pmp_minimize_area", {}, grid(7));
        fixture("fair-minimize-curvature", "pmp_minimize_curvature", {}, grid(7));
        auto selected = grid(7);
        selected.selected = {16, 17, 18, 23, 24, 25, 30, 31, 32};
        fixture("fair-selected-region", "pmp_fair", {1}, selected);
        auto selected_tetra = tetra;
        selected_tetra.selected = {0};
        fixture("fair-selected-closed-mesh", "pmp_fair", {1}, selected_tetra);
        fixture("fair-polygons", "pmp_fair", {1}, grid(5, true));
        large_solver_reference();
        std::cout << "]\n";
    }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
