// SPDX-License-Identifier: MIT
// This module runs unchanged in Node and Chromium against public JS/Wasm entry points.
import { attributeView, Domain, instantiate, meshView, Property } from '../../src/index.js';

const INVALID = 0xffffffff;
const TOLERANCE = 2e-5;
const operations = ['pmp_decimate', 'pmp_uniform_remeshing', 'pmp_adaptive_remeshing',
  'pmp_catmull_clark_subdivision', 'pmp_loop_subdivision', 'pmp_quad_tri_subdivision',
  'pmp_linear_subdivision', 'pmp_explicit_smoothing', 'pmp_implicit_smoothing', 'pmp_fill_hole'];
const derived = [['v:normal', Property.VEC3F, Domain.VERTEX], ['f:normal', Property.VEC3F, Domain.FACE],
  ['v:curv', Property.F32, Domain.VERTEX], ['geodesic:distance', Property.F32, Domain.VERTEX],
  ['v:component', Property.I32, Domain.VERTEX]];

export async function runAlgorithms(source, fixtures) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const cases = [];
  let assertions = 0;
  const check = (condition, label) => {
    ++assertions;
    if (!condition) throw new Error(label);
  };
  const equal = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  const near = (actual, expected, label, tolerance = TOLERANCE) => {
    equal(actual.length, expected.length, `${label} length`);
    for (let i = 0; i < expected.length; ++i)
      check(Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) <=
        tolerance * Math.max(1, Math.abs(expected[i])), `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
  };
  const run = async (name, body) => cases.push({ name, output: await body() });
  const canonical = polygon => {
    const first = polygon.indexOf(Math.min(...polygon));
    return polygon.map((_, i) => polygon[(first + i) % polygon.length]);
  };
  const upload = (e, values) => {
    const pointer = e.pmp_alloc(values.length * 4) >>> 0;
    new Uint32Array(e.memory.buffer, pointer, values.length).set(values);
    return pointer;
  };
  const halfedge = (view, from, to) => {
    for (let h = 0; h < view.edges * 2; ++h)
      if (view.halfedges[h * 4 + 1] === to && view.halfedges[(h ^ 1) * 4 + 1] === from) return h;
    throw new Error(`Missing halfedge ${from} -> ${to}`);
  };
  const construct = (e, mesh, input) => {
    equal(e.pmp_mesh_add_vertices(mesh, input.positions.length / 3), 0, 'first new vertex');
    meshView(e, mesh).positions.set(input.positions);
    const offsets = [0];
    for (const face of input.faces) offsets.push(offsets[offsets.length - 1] + face.length);
    const indices = upload(e, input.faces.flat()), starts = upload(e, offsets);
    e.pmp_mesh_add_faces(mesh, indices, starts, input.faces.length);
    e.pmp_free(indices);
    e.pmp_free(starts);
    if (input.featureEdges && input.featureEdges.length) {
      attributeView(e, mesh, 'v:feature', Property.BOOL, Domain.VERTEX, true);
      attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE, true);
      const markedEdges = input.featureEdges.map(([a, b]) => halfedge(meshView(e, mesh), a, b) >> 1);
      const vertices = attributeView(e, mesh, 'v:feature', Property.BOOL);
      for (const [a, b] of input.featureEdges) vertices[a] = vertices[b] = 1;
      // Reacquire after helper metadata allocations, which may grow memory.
      const currentEdges = attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE);
      for (const edge of markedEdges) currentEdges[edge] = 1;
    }
  };
  const addDerived = (e, mesh) => {
    for (const [name, type, domain] of derived)
      attributeView(e, mesh, name, type, domain, true).fill(42);
  };
  const checkDerivedRemoved = (e, mesh) => {
    for (const [name, type, domain] of derived)
      equal(attributeView(e, mesh, name, type, domain), null, `removed stale ${name}`);
  };
  const snapshot = (view, label) => {
    const { vertices, edges, faces, halfedges } = view;
    equal([view.liveVertices, view.liveEdges, view.liveFaces], [vertices, edges, faces], `${label}: compact mesh`);
    for (const deleted of [view.deletedVertices, view.deletedEdges, view.deletedFaces])
      check(deleted.every(value => value === 0), `${label}: no deleted slots`);
    for (const value of view.positions) check(Number.isFinite(value), `${label}: finite position`);
    const outgoing = Array.from({ length: vertices }, () => []);
    let boundaryEdges = 0;
    for (let edge = 0; edge < edges; ++edge) {
      const a = halfedges[edge * 8], b = halfedges[edge * 8 + 4];
      check(a !== INVALID || b !== INVALID, `${label}: edge has an incident face`);
      if (a === INVALID || b === INVALID) ++boundaryEdges;
    }
    for (let h = 0; h < edges * 2; ++h) {
      const [face, vertex, next, previous] = halfedges.subarray(h * 4, h * 4 + 4);
      check((face === INVALID || face < faces) && vertex < vertices && next < edges * 2 &&
        previous < edges * 2, `${label}: connectivity indices in range`);
      equal(halfedges[next * 4 + 3], h, `${label}: next/previous inverse`);
      equal(halfedges[previous * 4 + 2], h, `${label}: previous/next inverse`);
      equal(halfedges[(next ^ 1) * 4 + 1], vertex, `${label}: adjoining endpoints`);
      equal(halfedges[next * 4], face, `${label}: consistent face cycle`);
      outgoing[halfedges[(h ^ 1) * 4 + 1]].push(h);
    }
    for (let v = 0; v < vertices; ++v) {
      const incident = outgoing[v];
      if (!incident.length) equal(view.vertexHalfedges[v], INVALID, `${label}: isolated vertex`);
      else {
        check(incident.includes(view.vertexHalfedges[v]), `${label}: outgoing vertex halfedge`);
        if (incident.some(h => halfedges[h * 4] === INVALID))
          equal(halfedges[view.vertexHalfedges[v] * 4], INVALID, `${label}: boundary outgoing halfedge`);
      }
    }
    const polygons = [], owned = new Set();
    let surfaceArea = 0;
    for (let f = 0; f < faces; ++f) {
      const polygon = [], first = view.faceHalfedges[f];
      let h = first;
      do {
        check(h < edges * 2 && polygon.length < edges * 2 && !owned.has(h), `${label}: face cycle closes`);
        equal(halfedges[h * 4], f, `${label}: face owns halfedge`);
        owned.add(h);
        polygon.push(halfedges[h * 4 + 1]);
        h = halfedges[h * 4 + 2];
      } while (h !== first);
      check(polygon.length >= 3 && new Set(polygon).size === polygon.length, `${label}: simple polygon corners`);
      const area = [0, 0, 0];
      for (let i = 0; i < polygon.length; ++i) {
        const a = polygon[i] * 3, b = polygon[(i + 1) % polygon.length] * 3, p = view.positions;
        area[0] += p[a + 1] * p[b + 2] - p[a + 2] * p[b + 1];
        area[1] += p[a + 2] * p[b] - p[a] * p[b + 2];
        area[2] += p[a] * p[b + 1] - p[a + 1] * p[b];
      }
      surfaceArea += Math.hypot(...area) / 2;
      polygons.push(canonical(polygon));
    }
    equal(owned.size, [...halfedges].filter((_, i) => i % 4 === 0 && halfedges[i] !== INVALID).length,
      `${label}: all face halfedges traversed`);
    const uniqueEdges = new Set(polygons.flatMap(face => face.map((a, i) => {
      const b = face[(i + 1) % face.length];
      return `${Math.min(a, b)},${Math.max(a, b)}`;
    })));
    equal(uniqueEdges.size, edges, `${label}: unique polygon edge count`);
    check(Number.isFinite(surfaceArea) && surfaceArea > 0, `${label}: finite positive surface area`);
    return { positions: [...view.positions], faces: polygons, counts: [vertices, edges, faces], boundaryEdges, surfaceArea };
  };
  // Destruction follows success only. A trapped instance must never be entered again.
  const withMesh = async body => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create(), scratch = e.pmp_alloc(52) >>> 0;
    const result = await body(e, mesh, () => meshView(e, mesh, scratch));
    e.pmp_free(scratch);
    e.pmp_mesh_destroy(mesh);
    return result;
  };

  check(Array.isArray(fixtures) && fixtures.length === 22, 'all 22 native algorithm fixtures supplied');
  equal(new Set(fixtures.map(fixture => fixture.name)).size, fixtures.length, 'unique fixture names');
  for (const fixture of fixtures) await run(fixture.name, () => withMesh((e, mesh, view) => {
    check(typeof e[fixture.operation] === 'function', `${fixture.name}: direct algorithm export`);
    construct(e, mesh, fixture.input);
    if (fixture.input.boundaryFromTo) {
      const h = halfedge(view(), ...fixture.input.boundaryFromTo);
      equal(h, fixture.args[0], `${fixture.name}: native boundary index`);
      equal(view().halfedges[h * 4], INVALID, `${fixture.name}: chosen halfedge is boundary`);
    }
    addDerived(e, mesh);
    equal(e.pmp_mesh_unsupported_properties(mesh, operations.indexOf(fixture.operation)), 0, 'derived channels are accepted');
    e[fixture.operation](mesh, ...fixture.args);
    checkDerivedRemoved(e, mesh);
    const output = snapshot(view(), fixture.name), expected = fixture.output;
    const tolerance = fixture.name === 'uniform-remesh-small-scale-fallback' ? 1e-9 : TOLERANCE;
    near(output.positions, expected.positions, `${fixture.name}: native positions`, tolerance);
    equal(output.counts, expected.counts, `${fixture.name}: native entity counts`);
    equal(output.faces, expected.faces.map(canonical), `${fixture.name}: native indexed face topology`);
    equal(output.boundaryEdges, expected.boundaryEdges, `${fixture.name}: native boundary edge count`);
    near([output.surfaceArea], [expected.surfaceArea], `${fixture.name}: native surface area`, tolerance);
    check(JSON.stringify(output.positions) !== JSON.stringify(fixture.input.positions) ||
      JSON.stringify(output.faces) !== JSON.stringify(fixture.input.faces.map(canonical)), `${fixture.name}: meaningful mutation`);
    if (fixture.operation === 'pmp_fill_hole') {
      const incidence = new Map();
      for (const face of fixture.input.faces) for (let i = 0; i < face.length; ++i) {
        const a = face[i], b = face[(i + 1) % face.length], key = `${Math.min(a, b)},${Math.max(a, b)}`;
        incidence.set(key, (incidence.get(key) || 0) + 1);
      }
      const originalBoundary = [...incidence.values()].filter(count => count === 1).length;
      check(output.boundaryEdges < originalBoundary, `${fixture.name}: hole filling reduces the open boundary`);
      if (fixture.name === 'hole-annulus-refine-fair')
        check(output.counts[0] > fixture.input.positions.length / 3, 'hole refinement inserted interior vertices');
    } else {
      // A second call on the same mesh detects scratch properties left behind by the first call.
      e[fixture.operation](mesh, ...fixture.args);
      checkDerivedRemoved(e, mesh);
      const repeated = snapshot(view(), `${fixture.name}: repeated call`);
      if (fixture.operation.includes('smoothing')) equal(repeated.faces, output.faces, 'smoothing retains topology');
      if (fixture.operation.includes('subdivision'))
        check(repeated.counts[0] > output.counts[0] && repeated.counts[2] > output.counts[2], 'repeated subdivision refines');
    }
    return output;
  }));

  await run('repeated hole filling and mesh lifetimes', () => withMesh((e, mesh, view) => {
    const tetra = fixtures.find(fixture => fixture.name === 'hole-tetrahedron').input;
    for (let lifetime = 0; lifetime < 3; ++lifetime) {
      if (lifetime) e.pmp_mesh_clear(mesh);
      const positions = [...tetra.positions, ...tetra.positions.map((value, i) => i % 3 === 0 ? value + 5 : value)];
      const faces = [...tetra.faces, ...tetra.faces.map(face => face.map(v => v + 4))];
      construct(e, mesh, { positions, faces });
      for (const offset of [0, 4]) {
        const [from, to] = tetra.boundaryFromTo;
        const boundary = halfedge(view(), from + offset, to + offset);
        equal(view().halfedges[boundary * 4], INVALID, 'unfilled component remains open');
        e.pmp_fill_hole(mesh, boundary);
      }
      const result = snapshot(view(), 'two independently filled tetrahedra');
      equal(result.counts, [8, 12, 8], 'both tetrahedra are complete');
      equal(result.boundaryEdges, 0, 'both hole calls close their component');
    }
    return { lifetimes: 3, counts: [8, 12, 8], boundaryEdges: 0 };
  }));

  await run('property preflight reports each unsupported domain without mutation', () => withMesh((e, mesh, view) => {
    construct(e, mesh, fixtures[0].input);
    const before = snapshot(view(), 'before read-only property preflight'), masks = [];
    for (let domain = 0; domain < 4; ++domain) {
      attributeView(e, mesh, `user:domain${domain}`, Property.U32, domain, true).fill(domain + 17);
      const buffer = e.memory.buffer;
      const actual = operations.map((_, operation) => e.pmp_mesh_unsupported_properties(mesh, operation));
      const accumulated = (1 << (domain + 1)) - 1;
      equal(actual, operations.map((_, operation) => operation === 7 || operation === 8 ? 0 :
        operation === 0 ? accumulated & ~1 : accumulated), 'domain-specific preflight mask');
      check(e.memory.buffer === buffer, 'preflight does not grow memory');
      equal(snapshot(view(), 'after read-only property preflight'), before, 'preflight preserves geometry and topology');
      equal([...attributeView(e, mesh, `user:domain${domain}`, Property.U32, domain)],
        Array(domain === 0 ? before.counts[0] : domain === 1 ? before.counts[1] * 2 :
          domain === 2 ? before.counts[1] : before.counts[2]).fill(domain + 17), 'preflight preserves property values');
      masks.push(actual);
    }
    return { masks };
  }));

  const smoothingChannels = [
    ['user:uv1', Property.VEC2F, Domain.VERTEX], ['user:colors', Property.RGBA8, Domain.VERTEX],
    ['user:matricesIndices', Property.VEC4U16, Domain.VERTEX], ['user:matricesWeights', Property.VEC4F, Domain.VERTEX],
    ['user:cornerNormals', Property.VEC3F, Domain.HALFEDGE], ['user:edgeIds', Property.U32, Domain.EDGE],
    ['user:materials', Property.I32, Domain.FACE], ['v:tex', Property.VEC2F, Domain.VERTEX],
    ['h:tex', Property.VEC2F, Domain.HALFEDGE], ['v:selected', Property.BOOL, Domain.VERTEX],
    ['v:feature', Property.BOOL, Domain.VERTEX], ['e:feature', Property.BOOL, Domain.EDGE],
  ];
  for (const operation of [7, 8]) await run(`${operations[operation]} preserves custom and native channels`, () => withMesh((e, mesh, view) => {
    const fixture = fixtures.find(entry => entry.operation === operations[operation]);
    construct(e, mesh, fixture.input);
    const saved = smoothingChannels.map(([name, type, domain]) => {
      const channel = attributeView(e, mesh, name, type, domain, true);
      for (let i = 0; i < channel.length; ++i) channel[i] = type === Property.BOOL ? i % 2 :
        type === Property.RGBA8 || type === Property.VEC4U16 || type === Property.U32 || type === Property.I32 ?
          (i * 7 + 13) % 251 : (i % 17) * 0.125;
      return [...channel];
    });
    equal(e.pmp_mesh_unsupported_properties(mesh, operation), 0, 'smoothing accepts all custom domains');
    addDerived(e, mesh);
    e[fixture.operation](mesh, ...fixture.args);
    checkDerivedRemoved(e, mesh);
    for (let i = 0; i < smoothingChannels.length; ++i) {
      const [name, type, domain] = smoothingChannels[i];
      equal([...attributeView(e, mesh, name, type, domain)], saved[i], `smoothing retains ${name}`);
    }
    const output = snapshot(view(), 'smoothing with arbitrary channels');
    near(output.positions, fixture.output.positions, 'channels do not change smoothing');
    equal(output.faces, fixture.output.faces.map(canonical), 'smoothing topology');
    return { counts: output.counts, channels: smoothingChannels.length };
  }));

  await run('decimation retains endpoint channels and remaps continuous corner UVs', () => withMesh((e, mesh, view) => {
    const fixture = fixtures[0];
    construct(e, mesh, fixture.input);
    const channels = [['user:source', Property.U32, 1], ['user:jointIds', Property.VEC4U16, 4],
      ['user:jointWeights', Property.VEC4F, 4], ['v:tex', Property.VEC2F, 2]];
    const saved = channels.map(([name, type, components]) => {
      const channel = attributeView(e, mesh, name, type, Domain.VERTEX, true);
      for (let v = 0; v < fixture.input.positions.length / 3; ++v)
        for (let component = 0; component < components; ++component)
          channel[v * components + component] = name === 'user:source' ? v :
            name === 'v:tex' ? fixture.input.positions[v * 3 + component] :
              type === Property.VEC4U16 ? v * 4 + component : (v + component) * 0.03125;
      return [...channel];
    });
    const corners = attributeView(e, mesh, 'h:tex', Property.VEC2F, Domain.HALFEDGE, true);
    const current = view();
    for (let h = 0; h < current.edges * 2; ++h) {
      const vertex = current.halfedges[h * 4 + 1];
      corners[h * 2] = fixture.input.positions[vertex * 3];
      corners[h * 2 + 1] = fixture.input.positions[vertex * 3 + 1];
    }
    equal(e.pmp_mesh_unsupported_properties(mesh, 0), 0, 'decimation accepts native UVs and custom vertex channels');
    e.pmp_decimate(mesh, ...fixture.args);
    const output = snapshot(view(), 'decimation with endpoint channels');
    near(output.positions, fixture.output.positions, 'continuous UVs do not constrain decimation');
    const sources = [...attributeView(e, mesh, 'user:source', Property.U32)];
    equal(new Set(sources).size, output.counts[0], 'each retained endpoint has a distinct source');
    for (let i = 0; i < channels.length; ++i) {
      const [name, type, components] = channels[i];
      const channel = [...attributeView(e, mesh, name, type)];
      for (let v = 0; v < sources.length; ++v) {
        equal(channel.slice(v * components, (v + 1) * components),
          saved[i].slice(sources[v] * components, (sources[v] + 1) * components), `endpoint row retained for ${name}`);
        near(output.positions.slice(v * 3, v * 3 + 3), fixture.input.positions.slice(sources[v] * 3, sources[v] * 3 + 3),
          'geometry follows the retained endpoint');
      }
    }
    const uv = attributeView(e, mesh, 'h:tex', Property.VEC2F, Domain.HALFEDGE), result = view();
    for (let h = 0; h < result.edges * 2; ++h) if (result.halfedges[h * 4] !== INVALID) {
      const vertex = result.halfedges[h * 4 + 1];
      near([...uv.subarray(h * 2, h * 2 + 2)], output.positions.slice(vertex * 3, vertex * 3 + 2), 'corner UV follows new target');
    }
    return { counts: output.counts, retainedSources: sources };
  }));

  await run('decimation protects a discontinuous corner UV chart while simplifying elsewhere', () => withMesh((e, mesh, view) => {
    const fixture = fixtures[0], protectedSources = fixture.input.faces[0];
    construct(e, mesh, fixture.input);
    const sourceChannel = attributeView(e, mesh, 'user:source', Property.U32, Domain.VERTEX, true);
    for (let vertex = 0; vertex < sourceChannel.length; ++vertex) sourceChannel[vertex] = vertex;
    const uv = attributeView(e, mesh, 'h:tex', Property.VEC2F, Domain.HALFEDGE, true), before = view();
    // Fill boundary entries too: native seam detection reads the complete h:tex buffer.
    for (let h = 0; h < before.edges * 2; ++h) {
      const vertex = before.halfedges[h * 4 + 1], chart = before.halfedges[h * 4] === 0;
      uv[h * 2] = fixture.input.positions[vertex * 3] + (chart ? 10 : 0);
      uv[h * 2 + 1] = fixture.input.positions[vertex * 3 + 1] + (chart ? 20 : 0);
    }
    e.pmp_decimate(mesh, ...fixture.args);
    const output = snapshot(view(), 'decimation with a discontinuous UV chart');
    equal(output.counts[0], fixture.args[0], 'UV seam protection still permits the requested simplification');
    const sources = [...attributeView(e, mesh, 'user:source', Property.U32)];
    for (const source of protectedSources) check(sources.includes(source), 'every seam corner retains its source vertex');
    const removedWithoutSeam = protectedSources.filter(source => !Array.from({ length: fixture.output.counts[0] }, (_, v) => v)
      .some(vertex => [0, 1, 2].every(component => Math.abs(fixture.output.positions[vertex * 3 + component] -
        fixture.input.positions[source * 3 + component]) < 1e-6)));
    check(removedWithoutSeam.length > 0, 'the native geometry-only fixture collapses vertices protected by this UV seam');
    const currentUV = attributeView(e, mesh, 'h:tex', Property.VEC2F, Domain.HALFEDGE), current = view();
    const chartFaces = [];
    for (let face = 0; face < current.faces; ++face) {
      const first = current.faceHalfedges[face], chartSources = [];
      const firstVertex = current.halfedges[first * 4 + 1];
      const chart = Math.abs(currentUV[first * 2] - current.positions[firstVertex * 3]) > 1;
      let h = first;
      do {
        const vertex = current.halfedges[h * 4 + 1];
        near([...currentUV.subarray(h * 2, h * 2 + 2)],
          [current.positions[vertex * 3] + (chart ? 10 : 0), current.positions[vertex * 3 + 1] + (chart ? 20 : 0)],
          'each face retains its UV chart without blending across the seam');
        chartSources.push(sources[vertex]);
        h = current.halfedges[h * 4 + 2];
      } while (h !== first);
      if (chart) chartFaces.push(canonical(chartSources));
    }
    equal(chartFaces, [canonical(protectedSources)], 'the separated UV triangle retains all original corners');
    return { counts: output.counts, protectedSources, removedWithoutSeam, chartFaces };
  }));

  for (const operation of [1, 2]) await run(`${operations[operation]} retains selection rows and locks new vertices on the next call`,
    () => withMesh((e, mesh, view) => {
      const input = fixtures[0].input, originalVertices = input.positions.length / 3;
      construct(e, mesh, input);
      attributeView(e, mesh, 'v:selected', Property.BOOL, Domain.VERTEX, true).fill(1);
      // Equal adaptive bounds exercise the same refinement scale while retaining its separate native path.
      const args = operation === 1 ? [0.3, 1, 0] : [0.3, 0.3, 0.025, 1, 0];
      e[operations[operation]](mesh, ...args);
      const first = snapshot(view(), 'first selected remeshing call');
      const selection = [...attributeView(e, mesh, 'v:selected', Property.BOOL)];
      check(first.counts[0] > originalVertices, 'selected remeshing creates new vertices');
      equal(selection.slice(0, originalVertices), Array(originalVertices).fill(1), 'surviving original selection rows retain their flags');
      equal(selection.slice(originalVertices), Array(first.counts[0] - originalVertices).fill(0), 'new split vertices have the native false selection default');
      e[operations[operation]](mesh, ...args);
      const repeated = snapshot(view(), 'repeated remeshing with unchanged selection');
      equal(repeated.counts, first.counts, 'locked new vertices prevent further refinement in this fixture');
      equal([...attributeView(e, mesh, 'v:selected', Property.BOOL)], selection, 'repeated call retains the selection mask');
      for (let vertex = originalVertices; vertex < first.counts[0]; ++vertex)
        equal(repeated.positions.slice(vertex * 3, vertex * 3 + 3), first.positions.slice(vertex * 3, vertex * 3 + 3),
          'each newly unselected vertex stays exactly fixed on the next call');
      // Callers can explicitly refresh the native selection before requesting more work.
      attributeView(e, mesh, 'v:selected', Property.BOOL).fill(1);
      e[operations[operation]](mesh, ...args);
      const refreshed = snapshot(view(), 'remeshing after caller refreshes selection');
      check(JSON.stringify(refreshed.positions) !== JSON.stringify(repeated.positions), 'refreshing selection enables remeshing again');
      return { firstCounts: first.counts, repeatedCounts: repeated.counts, refreshedCounts: refreshed.counts,
        originalSelected: originalVertices, newUnselected: first.counts[0] - originalVertices };
    }));

  for (const operation of [3, 4]) await run(`${operations[operation]} propagates paired crease features`, () => withMesh((e, mesh, view) => {
    const input = fixtures.find(entry => entry.name === 'decimation-constraints-features').input;
    construct(e, mesh, input);
    equal(e.pmp_mesh_unsupported_properties(mesh, operation), 0, 'paired features are supported');
    e[operations[operation]](mesh, 0);
    const edges = [...attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE)];
    const vertices = [...attributeView(e, mesh, 'v:feature', Property.BOOL)], current = view();
    equal(edges.filter(Boolean).length, 4, 'each crease edge produces two marked edges');
    equal(vertices.filter(Boolean).length, 5, 'crease vertices and the two new edge vertices are marked');
    for (let edge = 0; edge < edges.length; ++edge) if (edges[edge])
      check(vertices[current.halfedges[edge * 8 + 1]] && vertices[current.halfedges[edge * 8 + 5]],
        'both endpoints of every crease edge are marked');
    const expected = [0, 1, 2].map(component => (6 * input.positions[7 * 3 + component] +
      input.positions[6 * 3 + component] + input.positions[8 * 3 + component]) / 8);
    near([...current.positions.subarray(21, 24)], expected, 'interior crease vertex follows the native crease rule');
    const output = snapshot(current, 'subdivision with crease features');
    return { counts: output.counts, featureEdges: 4, featureVertices: 5 };
  }));

  const captureStorage = (e, mesh) => {
    const view = meshView(e, mesh);
    return ['positions', 'vertexHalfedges', 'halfedges', 'faceHalfedges', 'deletedVertices', 'deletedEdges', 'deletedFaces']
      .map(name => ({ name, offset: view[name].byteOffset, bytes: [...new Uint8Array(e.memory.buffer,
        view[name].byteOffset, view[name].byteLength)] }));
  };
  const trappedWithoutMutation = (e, mesh, body, label) => {
    const saved = captureStorage(e, mesh);
    let error;
    try { body(); } catch (caught) { error = caught; }
    check(error instanceof WebAssembly.RuntimeError, `${label}: traps`);
    // Inspect linear memory directly, without calling any export after the trap.
    for (const { name, offset, bytes } of saved)
      equal([...new Uint8Array(e.memory.buffer, offset, bytes.length)], bytes, `${label}: ${name} unchanged before rejection`);
  };
  for (const operation of [0, 1, 2, 3, 4, 5, 6, 9]) await run(`${operations[operation]} rejects unsupported channels before mutation`, async () => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create();
    const fixture = fixtures.find(entry => entry.operation === operations[operation]);
    construct(e, mesh, fixture.input);
    const channel = attributeView(e, mesh, 'user:unsupportedCorners', Property.VEC2F, Domain.HALFEDGE, true);
    channel.fill(0.75);
    const offset = channel.byteOffset, length = channel.length;
    equal(e.pmp_mesh_unsupported_properties(mesh, operation), 2, 'halfedge domain is unsupported');
    trappedWithoutMutation(e, mesh, () => e[fixture.operation](mesh, ...fixture.args), fixture.operation);
    equal([...new Float32Array(e.memory.buffer, offset, length)], Array(length).fill(0.75), 'rejection retains attached channel');
    return { unsupported: 2, trappedBeforeMutation: true };
  });

  for (const state of ['edge-only', 'vertex-only', 'inconsistent-endpoints']) await run(`feature preflight rejects ${state} constraints`, async () => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create();
    construct(e, mesh, fixtures[0].input);
    if (state !== 'edge-only') attributeView(e, mesh, 'v:feature', Property.BOOL, Domain.VERTEX, true).fill(0);
    if (state !== 'vertex-only') attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE, true)[0] = 1;
    const masks = [0, 1, 2, 3, 4].map(operation => e.pmp_mesh_unsupported_properties(mesh, operation));
    equal(masks, [5, 5, 5, 5, 5], 'feature flags need paired properties and marked endpoints');
    trappedWithoutMutation(e, mesh, () => e.pmp_loop_subdivision(mesh, 0), `${state} feature flags`);
    return { masks, trappedBeforeMutation: true };
  });

  for (const channel of ['v:tex', 'h:tex', 'v:selected', 'paired-features'])
    await run(`native ${channel} has operation-specific transfer policy`, () => withMesh((e, mesh) => {
      construct(e, mesh, fixtures[0].input);
      if (channel === 'paired-features') {
        attributeView(e, mesh, 'v:feature', Property.BOOL, Domain.VERTEX, true);
        attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE, true);
      } else attributeView(e, mesh, channel, channel === 'v:selected' ? Property.BOOL : Property.VEC2F,
        channel === 'h:tex' ? Domain.HALFEDGE : Domain.VERTEX, true);
      const masks = operations.map((_, operation) => e.pmp_mesh_unsupported_properties(mesh, operation));
      const accepted = channel === 'paired-features' ? [0, 1, 2, 3, 4, 7, 8] :
        channel === 'v:selected' ? [0, 1, 2, 7, 8] : [0, 7, 8];
      const domainMask = channel === 'paired-features' ? 5 : channel === 'h:tex' ? 2 : 1;
      equal(masks, operations.map((_, operation) => accepted.includes(operation) ? 0 : domainMask),
        `${channel} transfer support is explicit`);
      return { masks };
    }));

  const invalidArguments = [
    ['negative decimation aspect', 'pmp_decimate', [15, -1, 0, 0, 0, 0, 0.01, 1]],
    ['non-finite decimation threshold', 'pmp_decimate', [15, 0, 0, 0, 0, 0, NaN, 1]],
    ['zero uniform target length', 'pmp_uniform_remeshing', [0, 1, 0]],
    ['invalid uniform projection flag', 'pmp_uniform_remeshing', [0.45, 1, 2]],
    ['reversed adaptive length bounds', 'pmp_adaptive_remeshing', [0.8, 0.2, 0.025, 1, 0]],
    ['zero adaptive approximation error', 'pmp_adaptive_remeshing', [0.2, 0.8, 0, 1, 0]],
    ['invalid adaptive projection flag', 'pmp_adaptive_remeshing', [0.2, 0.8, 0.025, 1, 2]],
    ['invalid Catmull-Clark boundary mode', 'pmp_catmull_clark_subdivision', [2]],
    ['invalid Loop boundary mode', 'pmp_loop_subdivision', [2]],
    ['invalid quad-tri boundary mode', 'pmp_quad_tri_subdivision', [2]],
    ['invalid explicit Laplace flag', 'pmp_explicit_smoothing', [1, 2]],
    ['negative implicit timestep', 'pmp_implicit_smoothing', [-0.1, 1, 0, 0]],
    ['non-finite implicit timestep', 'pmp_implicit_smoothing', [Infinity, 1, 0, 0]],
    ['invalid implicit Laplace flag', 'pmp_implicit_smoothing', [0.03, 1, 2, 0]],
    ['invalid implicit rescale flag', 'pmp_implicit_smoothing', [0.03, 1, 0, 2]],
    ['invalid hole halfedge', 'pmp_fill_hole', [INVALID]],
    ['invalid property preflight operation', 'pmp_mesh_unsupported_properties', [10]],
  ];
  for (const [name, operation, args] of invalidArguments) await run(name, async () => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create();
    construct(e, mesh, fixtures[0].input);
    trappedWithoutMutation(e, mesh, () => e[operation](mesh, ...args), name);
    return { trappedBeforeMutation: true };
  });
  for (const operation of [0, 1, 2, 4]) await run(`${operations[operation]} requires triangle input`, async () => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create();
    construct(e, mesh, fixtures.find(entry => entry.operation === 'pmp_catmull_clark_subdivision').input);
    const fixture = fixtures.find(entry => entry.operation === operations[operation]);
    trappedWithoutMutation(e, mesh, () => e[fixture.operation](mesh, ...fixture.args), 'triangle precondition');
    return { trappedBeforeMutation: true };
  });
  await run('hole filling requires a boundary halfedge', async () => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create();
    construct(e, mesh, fixtures[0].input);
    const current = meshView(e, mesh);
    const interior = Array.from({ length: current.edges * 2 }, (_, h) => h)
      .find(h => current.halfedges[h * 4] !== INVALID);
    trappedWithoutMutation(e, mesh, () => e.pmp_fill_hole(mesh, interior), 'non-boundary hole halfedge');
    return { trappedBeforeMutation: true };
  });
  for (const operation of operations) await run(`${operation} rejects non-finite coordinates`, async () => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create();
    const fixture = fixtures.find(entry => entry.operation === operation);
    construct(e, mesh, fixture.input);
    meshView(e, mesh).positions[0] = NaN;
    trappedWithoutMutation(e, mesh, () => e[operation](mesh, ...fixture.args), 'non-finite coordinates');
    return { trappedBeforeMutation: true };
  });

  for (const operation of ['pmp_explicit_smoothing', 'pmp_implicit_smoothing', 'pmp_fill_hole'])
    await run(`${operation} rejects oversized polygon matrices before mutation`, async () => {
      const e = await instantiate(module), mesh = e.pmp_mesh_create(), corners = 20000;
      const input = { positions: [], faces: [Array.from({ length: corners }, (_, vertex) => vertex)] };
      for (let vertex = 0; vertex < corners; ++vertex) {
        const angle = 2 * Math.PI * vertex / corners;
        input.positions.push(3 * Math.cos(angle), 3 * Math.sin(angle), 0);
      }
      let args = operation === 'pmp_explicit_smoothing' ? [1, 0] : [0.03, 1, 0, 0];
      if (operation === 'pmp_fill_hole') {
        const tetra = fixtures.find(fixture => fixture.name === 'hole-tetrahedron').input;
        input.positions.push(...tetra.positions.map((value, component) => component % 3 === 0 ? value + 10 : value));
        input.faces.push(...tetra.faces.map(face => face.map(vertex => vertex + corners)));
      }
      // The ring has distinct, ordered corners. Large polygon uniqueness remains a caller precondition.
      construct(e, mesh, input);
      const before = meshView(e, mesh);
      equal(before.vertices, corners + (operation === 'pmp_fill_hole' ? 4 : 0), 'large polygon is constructed successfully');
      equal(before.faces, input.faces.length, 'the oversized polygon and optional hole faces are present');
      check((corners + 1) ** 2 > 0x7fffffff / 8, 'polygon matrix would overflow the signed Eigen allocation dimension');
      if (operation === 'pmp_fill_hole') {
        const tetra = fixtures.find(fixture => fixture.name === 'hole-tetrahedron').input;
        const boundary = halfedge(before, ...tetra.boundaryFromTo.map(vertex => vertex + corners));
        equal(before.halfedges[boundary * 4], INVALID, 'disconnected tetrahedron has a valid hole');
        args = [boundary];
      }
      const saved = captureStorage(e, mesh);
      let error;
      try { e[operation](mesh, ...args); } catch (caught) { error = caught; }
      check(error instanceof WebAssembly.RuntimeError, `${operation}: oversized polygon is rejected by a Wasm trap`);
      // Compare directly rather than stringify these large buffers; never re-enter the trapped instance.
      for (const { name, offset, bytes } of saved) {
        const current = new Uint8Array(e.memory.buffer, offset, bytes.length);
        check(current.every((value, index) => value === bytes[index]), `${name} stays unchanged before the size rejection`);
      }
      return { corners, vertices: input.positions.length / 3, trappedBeforeMutation: true };
    });

  await run('remeshing handles a 50000-valence fan without squared-energy overflow', () => withMesh((e, mesh, view) => {
    const count = 50000, radius = Math.SQRT1_2;
    e.pmp_mesh_reserve(mesh, count + 1, count * 2, count);
    e.pmp_mesh_add_vertices(mesh, count + 1);
    const positions = view().positions;
    positions.fill(0);
    for (let i = 0; i < count; ++i) {
      const angle = 2 * Math.PI * i / count, offset = (i + 1) * 3;
      positions[offset] = radius * Math.cos(angle);
      positions[offset + 1] = radius * Math.sin(angle);
      positions[offset + 2] = (i % 2 ? 1 : -1) * radius;
    }
    const pointer = e.pmp_alloc(count * 12) >>> 0;
    const triangles = new Uint32Array(e.memory.buffer, pointer, count * 3);
    for (let i = 0; i < count; ++i) triangles.set([0, i + 1, (i + 1) % count + 1], i * 3);
    e.pmp_mesh_add_triangles(mesh, pointer, count, 0, 0);
    e.pmp_free(pointer);
    const before = view();
    equal(before.halfedges.filter((value, i) => i % 4 === 1 && value === 0).length, count, 'initial center degree exceeds signed square limit');
    // All radial/rim edges start within the split/collapse thresholds. Flipping
    // therefore encounters the large degree before those passes can reduce it.
    e.pmp_uniform_remeshing(mesh, 1.1, 1, 0);
    const current = view(), hconn = current.halfedges;
    const counts = [current.vertices, current.edges, current.faces];
    equal(counts, [count + 1, count * 2, count], 'stress remeshing preserves entity counts');
    equal([current.liveVertices, current.liveEdges, current.liveFaces], counts, 'stress result is compact');
    check(current.positions.every(Number.isFinite), 'stress positions remain finite');
    let degree = 0, boundary = 0;
    for (let h = 0; h < current.edges * 2; ++h) {
      const face = hconn[h * 4], vertex = hconn[h * 4 + 1], next = hconn[h * 4 + 2], previous = hconn[h * 4 + 3];
      check(vertex < current.vertices && next < current.edges * 2 && previous < current.edges * 2 &&
        (face === INVALID || face < current.faces) && hconn[next * 4 + 3] === h && hconn[previous * 4 + 2] === h &&
        hconn[next * 4] === face && hconn[(next ^ 1) * 4 + 1] === vertex, 'stress halfedge connectivity is valid');
      if (vertex === 0) ++degree;
      if (face === INVALID) ++boundary;
    }
    for (let face = 0; face < current.faces; ++face) {
      const a = current.faceHalfedges[face], b = hconn[a * 4 + 2], c = hconn[b * 4 + 2];
      check(hconn[c * 4 + 2] === a && hconn[a * 4] === face && hconn[b * 4] === face && hconn[c * 4] === face &&
        hconn[a * 4 + 1] !== hconn[b * 4 + 1] && hconn[b * 4 + 1] !== hconn[c * 4 + 1] &&
        hconn[c * 4 + 1] !== hconn[a * 4 + 1], 'stress face is a valid triangle');
    }
    equal(boundary, count, 'stress boundary is preserved');
    check(degree >= 3 && degree < count, 'edge flipping meaningfully reduces center degree');
    return { counts, boundary, degreeBefore: count, degreeAfter: degree };
  }));

  return { cases, assertions };
}
