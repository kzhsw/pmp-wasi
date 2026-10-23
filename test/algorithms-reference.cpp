// SPDX-License-Identifier: MIT
// Host-only fixtures generated from the pinned, unmodified upstream PMP sources.
// args mirrors the named C export after its mesh argument. featureEdges marks
// both endpoint vertex features and the edge feature. boundaryFromTo identifies
// the original boundary halfedge whose native index is also recorded in args.
#include "pmp/surface_mesh.h"
#include "pmp/algorithms/decimation.h"
#include "pmp/algorithms/differential_geometry.h"
#include "pmp/algorithms/hole_filling.h"
#include "pmp/algorithms/remeshing.h"
#include "pmp/algorithms/smoothing.h"
#include "pmp/algorithms/subdivision.h"
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

struct Input
{
    std::vector<std::array<float, 3>> positions;
    std::vector<std::vector<uint32_t>> faces;
    std::vector<std::array<uint32_t, 2>> feature_edges;
    std::optional<std::array<uint32_t, 2>> boundary;
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

void apply(pmp::SurfaceMesh& mesh, const std::string& operation, const std::vector<double>& args)
{
    if (operation == "pmp_decimate")
        pmp::decimate(mesh, args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
    else if (operation == "pmp_uniform_remeshing")
        pmp::uniform_remeshing(mesh, args[0], args[1], args[2]);
    else if (operation == "pmp_adaptive_remeshing")
        pmp::adaptive_remeshing(mesh, args[0], args[1], args[2], args[3], args[4]);
    else if (operation == "pmp_catmull_clark_subdivision")
        pmp::catmull_clark_subdivision(mesh, static_cast<pmp::BoundaryHandling>(int(args[0])));
    else if (operation == "pmp_loop_subdivision")
        pmp::loop_subdivision(mesh, static_cast<pmp::BoundaryHandling>(int(args[0])));
    else if (operation == "pmp_quad_tri_subdivision")
        pmp::quad_tri_subdivision(mesh, static_cast<pmp::BoundaryHandling>(int(args[0])));
    else if (operation == "pmp_linear_subdivision") pmp::linear_subdivision(mesh);
    else if (operation == "pmp_explicit_smoothing")
        pmp::explicit_smoothing(mesh, args[0], args[1]);
    else if (operation == "pmp_implicit_smoothing")
        pmp::implicit_smoothing(mesh, args[0], args[1], args[2], args[3]);
    else if (operation == "pmp_fill_hole") pmp::fill_hole(mesh, pmp::Halfedge(args[0]));
    else throw std::runtime_error("Unknown fixture operation");
}

void fixture(const std::string& name, const std::string& operation,
             std::vector<double> args, const Input& input, bool require_refinement = false)
{
    pmp::SurfaceMesh mesh;
    for (const auto& p : input.positions) mesh.add_vertex(pmp::Point(p[0], p[1], p[2]));
    for (const auto& polygon : input.faces)
    {
        std::vector<pmp::Vertex> vertices;
        for (auto index : polygon) vertices.emplace_back(index);
        mesh.add_face(vertices);
    }
    if (!input.feature_edges.empty())
    {
        auto vertices = mesh.vertex_property<bool>("v:feature", false);
        auto edges = mesh.edge_property<bool>("e:feature", false);
        for (const auto& endpoints : input.feature_edges)
        {
            const pmp::Vertex a(endpoints[0]), b(endpoints[1]);
            const auto halfedge = mesh.find_halfedge(a, b);
            if (!halfedge.is_valid()) throw std::runtime_error("Missing fixture feature edge");
            edges[mesh.edge(halfedge)] = vertices[a] = vertices[b] = true;
        }
    }
    if (input.boundary)
    {
        const auto h = mesh.find_halfedge(pmp::Vertex((*input.boundary)[0]), pmp::Vertex((*input.boundary)[1]));
        if (!h.is_valid() || !mesh.is_boundary(h)) throw std::runtime_error("Missing fixture boundary halfedge");
        args = {double(h.idx())};
    }
    try { apply(mesh, operation, args); }
    catch (const std::exception& error) { throw std::runtime_error(name + ": " + error.what()); }
    if (mesh.vertices_size() != mesh.n_vertices() || mesh.edges_size() != mesh.n_edges() ||
        mesh.faces_size() != mesh.n_faces()) throw std::runtime_error(name + ": algorithm left garbage");
    std::vector<std::array<float, 3>> result_positions;
    std::vector<std::vector<uint32_t>> result_faces;
    for (auto v : mesh.vertices())
    {
        const auto p = mesh.position(v);
        result_positions.push_back({p[0], p[1], p[2]});
    }
    for (auto f : mesh.faces())
    {
        std::vector<uint32_t> polygon;
        for (auto v : mesh.vertices(f)) polygon.push_back(v.idx());
        result_faces.push_back(polygon);
    }
    if (result_positions == input.positions && result_faces == input.faces)
        throw std::runtime_error(name + ": fixture did not change");
    if (require_refinement && result_positions.size() <= input.positions.size())
        throw std::runtime_error(name + ": hole refinement did not insert vertices");
    size_t boundary_edges = 0;
    for (auto e : mesh.edges()) if (mesh.is_boundary(e)) ++boundary_edges;
    const auto area = pmp::surface_area(mesh);
    if (!(area > 0) || !std::isfinite(area)) throw std::runtime_error(name + ": invalid surface area");
    static bool comma = false;
    if (comma) std::cout << ',';
    comma = true;
    std::cout << "{\"name\":\"" << name << "\",\"operation\":\"" << operation << "\",\"args\":";
    array(args);
    std::cout << ",\"input\":{\"positions\":";
    positions(input.positions);
    std::cout << ",\"faces\":";
    nested(input.faces);
    if (!input.feature_edges.empty()) { std::cout << ",\"featureEdges\":"; nested(input.feature_edges); }
    if (input.boundary) { std::cout << ",\"boundaryFromTo\":"; array(*input.boundary); }
    std::cout << "},\"output\":{\"positions\":";
    positions(result_positions);
    std::cout << ",\"faces\":";
    nested(result_faces);
    std::cout << ",\"counts\":[" << mesh.n_vertices() << ',' << mesh.n_edges() << ',' << mesh.n_faces()
              << "],\"boundaryEdges\":" << boundary_edges << ",\"surfaceArea\":" << area << "}}";
}

Input grid(unsigned n, bool quads = false)
{
    Input input;
    for (unsigned y = 0; y < n; ++y) for (unsigned x = 0; x < n; ++x)
        input.positions.push_back({0.6f * x + 0.013f * ((7 * x + 3 * y) % 5),
                                   0.55f * y + 0.017f * ((2 * x + 11 * y) % 7),
                                   0.025f * x * (n - 1 - x) * y * (n - 1 - y)});
    for (unsigned y = 0; y + 1 < n; ++y) for (unsigned x = 0; x + 1 < n; ++x)
    {
        const auto a = y * n + x, b = a + 1, c = a + n + 1, d = a + n;
        if (quads) input.faces.push_back({a, b, c, d});
        else { input.faces.push_back({a, b, c}); input.faces.push_back({a, c, d}); }
    }
    return input;
}

Input annulus()
{
    Input input;
    constexpr unsigned n = 12;
    for (unsigned ring = 0; ring < 2; ++ring) for (unsigned i = 0; i < n; ++i)
    {
        const float angle = 6.2831853071795864769 * i / n, radius = ring ? 2.75f : 2.0f;
        input.positions.push_back({radius * std::cos(angle), radius * std::sin(angle),
                                   0.13f * std::cos(2 * angle) + 0.07f * std::sin(3 * angle)});
    }
    for (unsigned i = 0; i < n; ++i)
    {
        const auto j = (i + 1) % n;
        input.faces.push_back({i, n + i, n + j});
        input.faces.push_back({i, n + j, j});
    }
    input.boundary = {{0, 1}};
    return input;
}

int main()
{
    try
    {
        std::cout << std::setprecision(9) << '[';
        const auto triangles = grid(5), quads = grid(3, true);
        auto featured = triangles;
        featured.feature_edges = {{6, 7}, {7, 8}};
        fixture("decimation-grid", "pmp_decimate", {15, 0, 0, 0, 0, 0, 0.01, 1}, triangles);
        fixture("decimation-constraints-features", "pmp_decimate", {18, 8, 1.75, 12, 90, 0.4, 0.01, 1}, featured);
        for (unsigned projection : {0u, 1u})
        {
            fixture("uniform-remesh-projection-" + std::to_string(projection), "pmp_uniform_remeshing",
                    {0.45, 2, double(projection)}, triangles);
            fixture("adaptive-remesh-projection-" + std::to_string(projection), "pmp_adaptive_remeshing",
                    {0.28, 0.8, 0.025, 2, double(projection)}, triangles);
        }
        // Native 3x3 inversion rejects these small determinants and remeshing
        // recovers through its weighted-centroid path. Triangles retain area.
        auto small = triangles;
        for (auto& point : small.positions) for (auto& value : point) value *= 1e-4f;
        fixture("uniform-remesh-small-scale-fallback", "pmp_uniform_remeshing", {0.000045, 2, 0}, small);
        const Input mixed{{{0, 0, 0}, {1, 0, 0.15f}, {2.2f, 0, 0}, {0, 1.1f, 0},
                            {1, 1, 0.3f}, {2, 1.2f, 0}}, {{0, 1, 4, 3}, {1, 2, 5}, {1, 5, 4}}, {}, {}};
        for (unsigned boundary : {0u, 1u})
        {
            fixture("catmull-clark-boundary-" + std::to_string(boundary), "pmp_catmull_clark_subdivision",
                    {double(boundary)}, quads);
            fixture("loop-boundary-" + std::to_string(boundary), "pmp_loop_subdivision", {double(boundary)}, grid(3));
            fixture("quad-tri-boundary-" + std::to_string(boundary), "pmp_quad_tri_subdivision", {double(boundary)}, mixed);
        }
        fixture("linear-mixed", "pmp_linear_subdivision", {}, mixed);
        for (unsigned uniform : {0u, 1u})
        {
            fixture("explicit-smoothing-uniform-" + std::to_string(uniform), "pmp_explicit_smoothing",
                    {3, double(uniform)}, triangles);
            for (unsigned rescale : {0u, 1u})
                fixture("implicit-smoothing-uniform-" + std::to_string(uniform) + "-rescale-" + std::to_string(rescale),
                        "pmp_implicit_smoothing", {0.03, 2, double(uniform), double(rescale)}, triangles);
        }
        const Input tetra{{{1, 1, 1}, {-1, -1, 1}, {-1, 1, -1}, {1, -1, -1}},
                          {{0, 2, 1}, {0, 1, 3}, {0, 3, 2}}, {}, {{1, 2}}};
        fixture("hole-tetrahedron", "pmp_fill_hole", {}, tetra);
        fixture("hole-annulus-refine-fair", "pmp_fill_hole", {}, annulus(), true);
        std::cout << "]\n";
    }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
