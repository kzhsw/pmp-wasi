// Generate fixtures using unmodified upstream PMP on the host, not the port.
#include "pmp/surface_mesh.h"
#include "pmp/algorithms/normals.h"
#include "pmp/algorithms/features.h"
#include <array>
#include <iomanip>
#include <iostream>

void fixture(const char* name, std::vector<std::array<float, 3>> points,
             std::vector<std::vector<uint32_t>> faces)
{
    pmp::SurfaceMesh mesh;
    for (const auto& p : points) mesh.add_vertex(pmp::Point(p[0], p[1], p[2]));
    for (const auto& face : faces) {
        std::vector<pmp::Vertex> vertices;
        for (auto v : face) vertices.emplace_back(v);
        mesh.add_face(vertices);
    }
    std::cout << "{\"name\":\"" << name << "\",\"positions\":[";
    bool comma = false;
    for (const auto& p : points) for (int i = 0; i < 3; ++i) {
        if (comma) std::cout << ',';
        comma = true; std::cout << p[i];
    }
    std::cout << "],\"faces\":[";
    comma = false;
    for (const auto& face : faces) {
        if (comma) std::cout << ','; comma = true;
        std::cout << '[';
        for (size_t i = 0; i < face.size(); ++i) { if (i) std::cout << ','; std::cout << face[i]; }
        std::cout << ']';
    }
    std::cout << "],\"vertexNormals\":[";
    comma = false;
    for (auto v : mesh.vertices()) {
        auto n = pmp::vertex_normal(mesh, v);
        for (int i = 0; i < 3; ++i) { if (comma) std::cout << ','; comma = true; std::cout << n[i]; }
    }
    std::cout << "],\"faceNormals\":[";
    comma = false;
    for (auto f : mesh.faces()) {
        auto n = pmp::face_normal(mesh, f);
        for (int i = 0; i < 3; ++i) { if (comma) std::cout << ','; comma = true; std::cout << n[i]; }
    }
    std::cout << "],\"vertexHalfedges\":[";
    comma = false;
    for (auto v : mesh.vertices()) {
        if (comma) std::cout << ','; comma = true;
        std::cout << mesh.halfedge(v).idx();
    }
    std::cout << "],\"halfedges\":[";
    comma = false;
    for (auto h : mesh.halfedges()) {
        if (comma) std::cout << ','; comma = true;
        std::cout << '[' << mesh.face(h).idx() << ',' << mesh.to_vertex(h).idx()
                  << ',' << mesh.next_halfedge(h).idx() << ',' << mesh.prev_halfedge(h).idx() << ']';
    }
    std::cout << "],\"faceHalfedges\":[";
    comma = false;
    for (auto f : mesh.faces()) {
        if (comma) std::cout << ','; comma = true;
        std::cout << mesh.halfedge(f).idx();
    }
    std::cout << "],\"cornerNormals\":[";
    comma = false;
    for (auto h : mesh.halfedges()) if (!mesh.is_boundary(h)) {
        for (float angle : {0.0f, 0.8f, 180.0f}) {
            if (comma) std::cout << ','; comma = true;
            const auto n = pmp::corner_normal(mesh, h, angle);
            std::cout << "{\"halfedge\":" << h.idx() << ",\"angle\":" << angle
                      << ",\"normal\":[" << n[0] << ',' << n[1] << ',' << n[2] << "]}";
        }
    }
    std::cout << "],\"features30\":" << pmp::detect_features(mesh, 30)
              << ",\"boundary\":" << pmp::detect_boundary(mesh)
              << ",\"edges\":" << mesh.n_edges() << "}";
}
int main()
{
    std::cout << std::setprecision(9) << '[';
    fixture("quad", {{0,0,0},{1,0,0},{1,1,0},{0,1,0}}, {{0,1,2,3}});
    std::cout << ',';
    fixture("fold", {{0,0,0},{1,0,0},{0,1,0},{0,0,1}}, {{0,1,2},{1,0,3}});
    std::cout << ',';
    fixture("tetrahedron", {{1,1,1},{-1,-1,1},{-1,1,-1},{1,-1,-1}},
            {{0,2,1},{0,1,3},{0,3,2},{1,2,3}});
    std::cout << ',';
    fixture("degenerate-and-isolated", {{0,0,0},{1,0,0},{2,0,0},{4,2,1}}, {{0,1,2}});
    std::cout << "]\n";
}
