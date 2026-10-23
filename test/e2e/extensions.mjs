// SPDX-License-Identifier: MIT
// Shared unchanged by Node and Chromium; keep syntax compatible with Chrome 75.
import { Algorithm, attributeView, Curvature, Domain, instantiate, meshView, Property, Winding } from '../../src/index.js';

const INVALID = 0xffffffff;
const derived = [['v:normal', Property.VEC3F, Domain.VERTEX], ['f:normal', Property.VEC3F, Domain.FACE],
  ['v:curv', Property.F32, Domain.VERTEX], ['geodesic:distance', Property.F32, Domain.VERTEX],
  ['v:component', Property.I32, Domain.VERTEX]];
const layouts = [[Property.BOOL, 1], [Property.I32, 1], [Property.U32, 1], [Property.F32, 1],
  [Property.F64, 1], [Property.VEC2F, 2], [Property.VEC3F, 3], [Property.VEC4F, 4],
  [Property.VEC4U32, 4], [Property.VEC4U16, 4], [Property.RGBA8, 4]];

export async function runExtensions(source, fixtures) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const cases = [];
  let assertions = 0;
  const check = (condition, label) => {
    ++assertions;
    if (!condition) throw new Error(label);
  };
  const equal = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  const near = (actual, expected, label, tolerance = 3e-5) => {
    equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; ++i)
      check(Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) <=
        tolerance * Math.max(1, Math.abs(expected[i])), `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
  };
  const run = async (name, body) => cases.push({ name, output: await body() });
  const canonical = polygon => {
    if (!polygon.length) return [];
    const first = polygon.indexOf(Math.min.apply(null, polygon));
    return polygon.map((_, i) => polygon[(first + i) % polygon.length]);
  };
  const upload = (e, values) => {
    const pointer = e.pmp_alloc(values.length * 4) >>> 0;
    new Uint32Array(e.memory.buffer, pointer, values.length).set(values);
    return pointer;
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
    if (input.selected) {
      const selected = attributeView(e, mesh, 'v:selected', Property.BOOL, Domain.VERTEX, true);
      for (const vertex of input.selected) selected[vertex] = 1;
    }
  };
  const snapshot = (view, label) => {
    const counts = [view.vertices, view.edges, view.faces];
    equal([view.liveVertices, view.liveEdges, view.liveFaces], counts, `${label}: compact storage`);
    for (const flags of [view.deletedVertices, view.deletedEdges, view.deletedFaces])
      check(flags.every(value => value === 0), `${label}: no deleted slots`);
    check(view.positions.every(Number.isFinite), `${label}: finite coordinates`);
    const hconn = view.halfedges, polygons = [], used = new Set();
    for (let h = 0; h < view.edges * 2; ++h) {
      const face = hconn[h * 4], vertex = hconn[h * 4 + 1], next = hconn[h * 4 + 2], previous = hconn[h * 4 + 3];
      check((face === INVALID || face < view.faces) && vertex < view.vertices && next < view.edges * 2 &&
        previous < view.edges * 2, `${label}: halfedge indices`);
      equal(hconn[next * 4 + 3], h, `${label}: next/previous inverse`);
      equal(hconn[previous * 4 + 2], h, `${label}: previous/next inverse`);
      equal(hconn[next * 4], face, `${label}: consistent face cycle`);
      equal(hconn[(next ^ 1) * 4 + 1], vertex, `${label}: endpoints meet`);
    }
    for (let f = 0; f < view.faces; ++f) {
      const polygon = [], first = view.faceHalfedges[f];
      let h = first;
      do {
        check(h < view.edges * 2 && !used.has(h), `${label}: simple face cycle`);
        used.add(h);
        equal(hconn[h * 4], f, `${label}: face ownership`);
        polygon.push(hconn[h * 4 + 1]);
        h = hconn[h * 4 + 2];
      } while (h !== first);
      check(polygon.length >= 3 && new Set(polygon).size === polygon.length, `${label}: distinct polygon corners`);
      polygons.push(canonical(polygon));
    }
    return { positions: Array.from(view.positions), faces: polygons, counts };
  };
  const withMesh = async body => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create();
    const result = await body(e, mesh);
    e.pmp_mesh_destroy(mesh);
    return result;
  };
  const addDerived = (e, mesh) => {
    for (const [name, type, domain] of derived) {
      const values = attributeView(e, mesh, name, type, domain, true);
      if (values) values.fill(42);
    }
  };
  const checkDerived = (e, mesh, changed, removed) => {
    for (const [name, type, domain] of derived) {
      if (name === changed) continue;
      const values = attributeView(e, mesh, name, type, domain);
      if (removed) equal(values, null, `${name}: stale output removed`);
      else if (values) check(values.every(value => value === 42), `${name}: retained by read-only geometry operation`);
    }
  };
  const measure = (e, mesh, includeVolume) => {
    const pointer = e.pmp_alloc(24) >>> 0;
    e.pmp_bounds(mesh, pointer);
    const bounds = Array.from(new Float32Array(e.memory.buffer, pointer, 6));
    e.pmp_centroid(mesh, pointer);
    const centroid = Array.from(new Float32Array(e.memory.buffer, pointer, 3));
    const result = { bounds, centroid, surfaceArea: e.pmp_surface_area(mesh),
      meanEdgeLength: e.pmp_mean_edge_length(mesh), minEdgeLength: e.pmp_min_edge_length(mesh),
      minFaceArea: e.pmp_min_face_area(mesh) };
    if (includeVolume) result.volume = e.pmp_volume(mesh);
    e.pmp_free(pointer);
    return result;
  };
  const geometryMatches = (actual, expected, label) => {
    equal(actual.counts, expected.counts, `${label}: native counts`);
    equal(actual.faces, expected.faces.map(canonical), `${label}: native indexed topology`);
    near(actual.positions, expected.positions, `${label}: native positions`);
  };
  const algorithm = operation => operation.indexOf('triangulate') >= 0 ? Algorithm.TRIANGULATE :
    operation === 'pmp_curvature' ? Algorithm.CURVATURE : operation === 'pmp_connected_components' ?
      Algorithm.CONNECTED_COMPONENTS : Algorithm.FAIR;

  const largeSolver = fixture => withMesh((e, mesh) => {
    equal(fixture.input.generator, 'curved-triangle-grid', 'large solver procedural generator');
    const n = fixture.input.cells, positions = [], faces = [];
    equal(n, 96, 'regression retains the input that exceeded the production stack');
    for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x)
      positions.push(x / n, y / n, 0.05 * Math.sin(Math.PI * x / n) * Math.sin(Math.PI * y / n));
    for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x) {
      const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
      faces.push([a, b, c], [a, c, d]);
    }
    e.pmp_mesh_reserve(mesh, (n + 1) * (n + 1), 3 * n * n + 2 * n, 2 * n * n);
    construct(e, mesh, { positions, faces });
    const before = meshView(e, mesh), originalPositions = Array.from(before.positions);
    const targets = Array.from({ length: before.edges * 2 }, (_, h) => before.halfedges[h * 4 + 1]);
    const topology = ['vertexHalfedges', 'halfedges', 'faceHalfedges', 'deletedVertices', 'deletedEdges', 'deletedFaces']
      .map(name => [name, Array.from(before[name])]);
    const channels = [];
    for (const [name, type, components, domain] of [['user:uv0', Property.VEC2F, 2, Domain.VERTEX],
      ['user:uv1', Property.VEC2F, 2, Domain.VERTEX], ['user:color', Property.RGBA8, 4, Domain.VERTEX],
      ['user:joints', Property.VEC4U16, 4, Domain.VERTEX], ['user:weights', Property.VEC4F, 4, Domain.VERTEX],
      ['h:tex', Property.VEC2F, 2, Domain.HALFEDGE]]) {
      const values = attributeView(e, mesh, name, type, domain, true);
      for (let row = 0; row < values.length / components; ++row) for (let c = 0; c < components; ++c) {
        const vertex = domain === Domain.HALFEDGE ? targets[row] : row;
        values[row * components + c] = name === 'user:color' ? (c === 3 ? 255 : vertex % 251) :
          name === 'user:joints' ? (c === 0 ? vertex % 16 : 0) : name === 'user:weights' ? Number(c === 0) :
            originalPositions[vertex * 3 + c] * (name === 'user:uv1' ? 2 : 1);
      }
      channels.push([name, type, domain, Array.from(values)]);
    }
    const phases = [];
    let previousPositions = originalPositions;
    for (let phase = 0; phase < 2; ++phase) {
      equal(e.pmp_mesh_unsupported_properties(mesh, phase === 0 ? Algorithm.IMPLICIT_SMOOTH : Algorithm.FAIR), 0,
        'large solver supports the attached UV/color/skin channels');
      if (phase === 0) e.pmp_implicit_smoothing(mesh, 0.1 / (n * n), 1, 0, 0);
      else e.pmp_fair(mesh, 2);
      const view = meshView(e, mesh), expected = fixture.output.phases[phase];
      equal([view.vertices, view.edges, view.faces], fixture.output.counts, 'large solver retains entity counts');
      equal([view.liveVertices, view.liveEdges, view.liveFaces], fixture.output.counts, 'large solver retains compact live counts');
      for (const [name, values] of topology)
        check(view[name].length === values.length && view[name].every((value, i) => value === values[i]),
          `${name}: large solver retains exact native connectivity and deletion flags`);
      check(view.positions.every(Number.isFinite), 'large solver returns finite coordinates');
      check(view.positions.some((value, i) => Math.abs(value - previousPositions[i]) > 1e-9), 'large solver meaningfully changes the curved interior');
      check(view.positions.every((value, i) => {
        const vertex = Math.floor(i / 3), x = vertex % (n + 1), y = Math.floor(vertex / (n + 1));
        return Math.min(x, y, n - x, n - y) >= (phase === 0 ? 1 : 2) || value === previousPositions[i];
      }), phase === 0 ? 'implicit smoothing preserves the entire boundary' : 'fair(2) preserves both constrained boundary rings');
      const samples = fixture.output.sampleVertices.flatMap(vertex => Array.from(view.positions.subarray(vertex * 3, vertex * 3 + 3)));
      const sums = [0, 0, 0];
      let minimum = Infinity, maximum = -Infinity;
      for (let vertex = 0; vertex < view.vertices; ++vertex) {
        for (let c = 0; c < 3; ++c) sums[c] += view.positions[vertex * 3 + c];
        minimum = Math.min(minimum, view.positions[vertex * 3 + 2]);
        maximum = Math.max(maximum, view.positions[vertex * 3 + 2]);
      }
      const result = { samples, surfaceArea: e.pmp_surface_area(mesh), heightRange: [minimum, maximum], coordinateSums: sums };
      near(samples, expected.samples, `large solver phase ${phase}: untouched native position samples`, 5e-6);
      near([result.surfaceArea], [expected.surfaceArea], 'large solver native surface area', 3e-6);
      near(result.heightRange, expected.heightRange, 'large solver native height range', 5e-6);
      near(result.coordinateSums, expected.coordinateSums, 'large solver native whole-mesh coordinate sums', 2e-8);
      previousPositions = Array.from(view.positions);
      for (const [name, type, domain, expectedValues] of channels) {
        const values = attributeView(e, mesh, name, type, domain);
        check(values.buffer === e.memory.buffer && values.length === expectedValues.length &&
          values.every((value, i) => value === expectedValues[i]), `${name}: large solver preserves all attribute values`);
      }
      phases.push(result);
    }
    return { counts: fixture.output.counts, sampleVertices: fixture.output.sampleVertices, phases };
  });

  equal([Algorithm.TRIANGULATE, Algorithm.CURVATURE, Algorithm.FAIR, Algorithm.CONNECTED_COMPONENTS],
    [10, 11, 12, 13], 'new algorithm preflight identifiers');
  equal([Curvature.MIN, Curvature.MAX, Curvature.MEAN, Curvature.GAUSS, Curvature.MAX_ABS],
    [0, 1, 2, 3, 4], 'curvature enum mirrors native PMP');
  equal(fixtures.length, 43, 'all untouched native extension fixtures supplied');
  equal(new Set(fixtures.map(fixture => fixture.name)).size, fixtures.length, 'unique fixture names');
  for (const fixture of fixtures) await run(fixture.name, () => fixture.operation === 'large_solver' ? largeSolver(fixture) : withMesh((e, mesh) => {
    construct(e, mesh, fixture.input);
    addDerived(e, mesh);
    const operation = fixture.operation;
    let result;
    if (operation === 'measurements') {
      result = measure(e, mesh, fixture.output.volume !== undefined);
      for (const key of Object.keys(result))
        near(Array.isArray(result[key]) ? result[key] : [result[key]],
          Array.isArray(fixture.output[key]) ? fixture.output[key] : [fixture.output[key]], `${fixture.name}: ${key}`);
      equal(measure(e, mesh, fixture.output.volume !== undefined), result, 'repeated measurements are stable');
    } else {
      check(typeof e[operation] === 'function', `${operation}: direct Wasm export`);
      equal(e.pmp_mesh_unsupported_properties(mesh, algorithm(operation)), 0, 'derived outputs are accepted');
      const returned = e[operation](mesh, ...fixture.args);
      result = {};
      if (operation === 'pmp_curvature' || operation === 'pmp_connected_components') {
        const name = operation === 'pmp_curvature' ? 'v:curv' : 'v:component';
        const type = operation === 'pmp_curvature' ? Property.F32 : Property.I32;
        const values = attributeView(e, mesh, name, type);
        result.values = values ? Array.from(values) : [];
        if (operation === 'pmp_curvature') near(result.values, fixture.output.values, `${fixture.name}: native curvature`);
        else {
          result.components = returned;
          equal(returned, fixture.output.components, 'native component count');
          equal(result.values, fixture.output.values, 'native component labels including isolated vertices');
        }
        if (values) {
          check(values.buffer === e.memory.buffer, `${name}: native output view`);
          const pointer = values.byteOffset;
          values.fill(-123);
          e[operation](mesh, ...fixture.args);
          const repeated = attributeView(e, mesh, name, type);
          equal(repeated.byteOffset, pointer, `${name}: existing native property storage reused`);
          near(Array.from(repeated), result.values, `${name}: repeated call rewrites caller-modified output`);
        }
      }
    }
    const geometry = snapshot(meshView(e, mesh), fixture.name);
    geometryMatches(geometry, fixture.output, fixture.name);
    const mutates = operation.indexOf('triangulate') >= 0 || operation === 'pmp_fair' || operation.indexOf('minimize') >= 0;
    checkDerived(e, mesh, operation === 'pmp_curvature' ? 'v:curv' :
      operation === 'pmp_connected_components' ? 'v:component' : '', mutates);
    if (operation.indexOf('triangulate') >= 0) {
      e[operation](mesh, ...fixture.args);
      equal(snapshot(meshView(e, mesh), 'repeat triangulation'), geometry, 'triangulation is idempotent');
    }
    if (fixture.name.indexOf('fair-k-') === 0) {
      const n = Math.sqrt(geometry.counts[0]), k = fixture.args[0];
      for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x)
        if (Math.min(x, y, n - 1 - x, n - 1 - y) < k) {
          const offset = (y * n + x) * 3;
          near(geometry.positions.slice(offset, offset + 3), fixture.input.positions.slice(offset, offset + 3),
            `k=${k}: locked boundary ring`, 1e-6);
        }
    }
    if (fixture.input.selected) {
      const selected = Array.from(attributeView(e, mesh, 'v:selected', Property.BOOL));
      equal(selected, Array.from({ length: geometry.counts[0] }, (_, i) => Number(fixture.input.selected.includes(i))),
        'fairing retains selection storage');
      const unselected = fixture.input.positions.filter((_, i) => !fixture.input.selected.includes(Math.floor(i / 3)));
      const retained = geometry.positions.filter((_, i) => !fixture.input.selected.includes(Math.floor(i / 3)));
      near(retained, unselected, 'unselected positions remain constrained', 1e-6);
    }
    if (operation === 'pmp_fair' || operation.indexOf('minimize') >= 0) {
      e[operation](mesh, ...fixture.args);
      const repeated = snapshot(meshView(e, mesh), 'repeated fairing');
      equal(repeated.faces, geometry.faces, 'repeated fairing retains topology and clears scratch properties');
      checkDerived(e, mesh, '', true);
    }
    return Object.assign(geometry, result);
  }));

  await run('measurement and curvature mathematical invariants', () => {
    const tetra = cases.find(entry => entry.name === 'measurements-tetrahedron').output;
    const reversed = cases.find(entry => entry.name === 'measurements-reversed-tetrahedron').output;
    near([tetra.surfaceArea, tetra.minFaceArea], [8 * Math.sqrt(3), 2 * Math.sqrt(3)], 'regular tetrahedron face areas');
    near([tetra.volume], [8 / 3], 'regular tetrahedron determinant volume');
    near([tetra.meanEdgeLength, tetra.minEdgeLength], [Math.sqrt(8), Math.sqrt(8)], 'regular tetrahedron edge lengths');
    near(tetra.bounds, [-1, -1, -1, 1, 1, 1], 'regular tetrahedron bounds');
    near(tetra.centroid, [0, 0, 0], 'regular tetrahedron centroid');
    near([reversed.volume, reversed.surfaceArea], [tetra.volume, tetra.surfaceArea], 'measurement orientation invariance');
    const translated = cases.find(entry => entry.name === 'measurements-translated-scaled-tetrahedron').output;
    near(translated.centroid, [13.25, -4.5, 2.125], 'area centroid translates with closed symmetric geometry');
    near([translated.volume], [tetra.volume * 2.5 * 1.75 * 0.75], 'volume scales by determinant');
    for (let mode = 0; mode < 4; ++mode) {
      const values = [];
      for (let kind = 0; kind < 5; ++kind)
        values.push(cases.find(entry => entry.name === `curvature-kind-${kind}-mode-${mode}`).output.values);
      for (let vertex = 0; vertex < values[0].length; ++vertex) {
        const min = values[0][vertex], max = values[1][vertex];
        check(min <= max + 1e-6, 'minimum curvature does not exceed maximum');
        near([values[2][vertex], values[3][vertex], values[4][vertex]],
          [0.5 * (min + max), min * max, Math.max(Math.abs(min), Math.abs(max))], 'curvature kind identities');
      }
    }
    return { curvatureModes: 4, verticesPerMode: 25, tetrahedronVolume: tetra.volume };
  });

  await run('tensor curvature vanishes on a planar patch and obeys scaling', () => withMesh((e, mesh) => {
    const fixture = fixtures.find(entry => entry.name === 'curvature-kind-2-mode-3');
    const plane = Object.assign({}, fixture.input, { positions: fixture.input.positions.map((value, i) => i % 3 === 2 ? 0 : value) });
    construct(e, mesh, plane);
    for (let kind = 0; kind < 5; ++kind) {
      e.pmp_curvature(mesh, kind, 2, 1, 1);
      near(Array.from(attributeView(e, mesh, 'v:curv', Property.F32)), Array(25).fill(0), 'planar tensor curvature', 1e-6);
    }
    e.pmp_mesh_clear(mesh);
    const scaled = Object.assign({}, fixture.input, { positions: fixture.input.positions.map(value => value * 2) });
    construct(e, mesh, scaled);
    e.pmp_curvature(mesh, Curvature.MEAN, 2, 1, 1);
    near(Array.from(attributeView(e, mesh, 'v:curv', Property.F32)), fixture.output.values.map(value => value / 2),
      'mean curvature scales inversely with uniform geometry scale');
    return { planarKinds: 5, scale: 2 };
  }));

  // Every supported property layout is retained on every domain by operations
  // that only update positions or their own output property.
  for (const operation of ['pmp_curvature', 'pmp_connected_components', 'pmp_fair'])
    await run(`${operation} retains all attribute layouts and domains`, () => withMesh((e, mesh) => {
      const fixture = fixtures.find(entry => entry.name === 'fair-selected-region');
      construct(e, mesh, fixture.input);
      const channels = [];
      for (let domain = 0; domain < 4; ++domain) for (const [type] of layouts) {
        const name = `user:domain${domain}type${type}`;
        const values = attributeView(e, mesh, name, type, domain, true);
        for (let i = 0; i < values.length; ++i)
          values[i] = type === Property.BOOL ? i % 2 : type === Property.I32 ? -i - 17 :
            type === Property.U32 || type === Property.VEC4U32 ? 65536 + i : (i % 127 + 1) / 8;
        channels.push([name, type, domain, Array.from(values)]);
      }
      for (const [name, type, domain] of [['v:tex', Property.VEC2F, Domain.VERTEX],
        ['h:tex', Property.VEC2F, Domain.HALFEDGE], ['v:feature', Property.BOOL, Domain.VERTEX],
        ['e:feature', Property.BOOL, Domain.EDGE]]) {
        const values = attributeView(e, mesh, name, type, domain, true);
        values.fill(type === Property.BOOL ? 1 : 0.625);
        channels.push([name, type, domain, Array.from(values)]);
      }
      const selected = Array.from(attributeView(e, mesh, 'v:selected', Property.BOOL));
      channels.push(['v:selected', Property.BOOL, Domain.VERTEX, selected]);
      const before = snapshot(meshView(e, mesh), 'all property layouts');
      equal(e.pmp_mesh_unsupported_properties(mesh, algorithm(operation)), 0, 'all user/native channels supported');
      if (operation === 'pmp_curvature') e.pmp_curvature(mesh, Curvature.MEAN, 1, 1, 1);
      else if (operation === 'pmp_fair') e.pmp_fair(mesh, 1);
      else equal(e.pmp_connected_components(mesh), 1, 'connected grid');
      for (const [name, type, domain, expected] of channels) {
        const values = attributeView(e, mesh, name, type, domain);
        check(values.buffer === e.memory.buffer, `${name}: Wasm storage view`);
        equal(Array.from(values), expected, `${name}: exact retained values`);
      }
      const after = snapshot(meshView(e, mesh), operation);
      equal(after.faces, before.faces, 'topology retained with attached attributes');
      if (operation !== 'pmp_fair') equal(after.positions, before.positions, 'read-only geometry retained');
      return { attributes: channels.length, counts: after.counts };
    }));

  for (const winding of [Winding.CCW, Winding.CW]) for (const single of [false, true])
    await run(`triangulation maps ${winding === Winding.CW ? 'CW' : 'CCW'} seams ${single ? 'one face' : 'all faces'}`,
      () => withMesh((e, mesh) => {
        const fixture = fixtures.find(entry => entry.name === 'triangulate-adjacent-quads');
        const input = fixture.input, sourceFaces = input.faces.map(face => winding === Winding.CW ? face.slice().reverse() : face);
        e.pmp_mesh_add_vertices(mesh, input.positions.length / 3);
        meshView(e, mesh).positions.set(input.positions);
        const sourceCorners = sourceFaces.flat(), indices = upload(e, sourceCorners);
        const offsets = upload(e, [0, 4, 8]), mapping = upload(e, Array(8).fill(INVALID));
        e.pmp_mesh_add_faces_winding(mesh, indices, offsets, 2, winding, mapping);
        const corners = Array.from(new Uint32Array(e.memory.buffer, mapping, 8));
        equal(Array.from(new Uint32Array(e.memory.buffer, indices, 8)), sourceCorners, 'source corner indices untouched');
        equal(new Set(corners).size, 8, 'each polygon corner has distinct storage');
        const vertexChannels = [], faceChannels = [], cornerChannels = [];
        for (const [type, components] of layouts) {
          const name = `user:vertexType${type}`, values = attributeView(e, mesh, name, type, Domain.VERTEX, true);
          for (let i = 0; i < values.length; ++i)
            values[i] = type === Property.BOOL ? i % 2 : type === Property.VEC4U32 ? 65536 + i : (i % 100 + 1) / 8;
          vertexChannels.push([name, type, Array.from(values)]);
          const faceName = `user:faceType${type}`, faces = attributeView(e, mesh, faceName, type, Domain.FACE, true);
          for (let f = 0; f < 2; ++f) for (let c = 0; c < components; ++c)
            faces[f * components + c] = type === Property.BOOL ? f : 17 + f * 31 + c;
          faceChannels.push([faceName, type, components, Array.from(faces)]);
          const cornerName = `user:cornerType${type}`;
          const valuesByOrigin = sourceFaces.map(face => new Map(face.map(vertex => [vertex, []])));
          const cornerValues = attributeView(e, mesh, cornerName, type, Domain.HALFEDGE, true);
          // Include boundary storage in the old-halfedge preservation checks.
          cornerValues.fill(type === Property.BOOL ? 1 : 3);
          for (let i = 0; i < corners.length; ++i) {
            for (let c = 0; c < components; ++c)
              cornerValues[corners[i] * components + c] = type === Property.BOOL ? Math.floor(i / 4) : 21 + i * 7 + c;
            valuesByOrigin[Math.floor(i / 4)].set(sourceCorners[i],
              Array.from(cornerValues.subarray(corners[i] * components, (corners[i] + 1) * components)));
          }
          cornerChannels.push([cornerName, type, components, valuesByOrigin, Array.from(cornerValues)]);
        }
        for (const [name, type] of [['v:tex', Property.VEC2F], ['v:selected', Property.BOOL],
          ['user:matricesIndices', Property.VEC4U32], ['user:matricesIndicesExtra', Property.VEC4U16],
          ['user:matricesWeights', Property.VEC4F], ['user:matricesWeightsExtra', Property.VEC4F]]) {
          const values = attributeView(e, mesh, name, type, Domain.VERTEX, true);
          for (let i = 0; i < values.length; ++i)
            values[i] = type === Property.BOOL ? i % 2 : type === Property.VEC4U32 ? 65536 + i :
              type === Property.VEC4U16 ? i + 1 : (i % 4 + 1) / 16;
          vertexChannels.push([name, type, Array.from(values)]);
        }
        for (const [name, type, components] of [['h:tex', Property.VEC2F, 2], ['user:uv1', Property.VEC2F, 2],
          ['user:uv2', Property.VEC3F, 3], ['user:cornerColors', Property.RGBA8, 4]]) {
          const values = attributeView(e, mesh, name, type, Domain.HALFEDGE, true);
          values.fill(0);
          const origins = [new Map(), new Map()];
          for (let i = 0; i < corners.length; ++i) {
            for (let c = 0; c < components; ++c) values[corners[i] * components + c] = 10 * i + c + 0.25;
            origins[Math.floor(i / 4)].set(sourceCorners[i], Array.from(values.subarray(corners[i] * components, (corners[i] + 1) * components)));
          }
          cornerChannels.push([name, type, components, origins, Array.from(values)]);
        }
        attributeView(e, mesh, 'v:feature', Property.BOOL, Domain.VERTEX, true).fill(1);
        const edgeFlags = attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE, true);
        for (let edge = 0; edge < edgeFlags.length; ++edge) edgeFlags[edge] = edge % 2;
        const beforeFeatures = Array.from(edgeFlags), before = meshView(e, mesh);
        const originalEdges = before.edges, originalPositions = Array.from(before.positions), originalHalfedges = Array.from(before.halfedges);
        addDerived(e, mesh);
        equal(e.pmp_mesh_unsupported_properties(mesh, Algorithm.TRIANGULATE), 0, 'vertex/corner/face channels supported');
        if (single) e.pmp_triangulate_face(mesh, 1); else e.pmp_triangulate(mesh);
        checkDerived(e, mesh, '', true);
        const current = meshView(e, mesh), output = snapshot(current, 'attribute-preserving triangulation');
        equal(output.positions, originalPositions, 'all vertex coordinates unchanged');
        equal(output.counts, [6, originalEdges + (single ? 1 : 2), single ? 3 : 4], 'expected diagonal and face insertion');
        for (const [name, type, expected] of vertexChannels)
          equal(Array.from(attributeView(e, mesh, name, type)), expected, `${name}: skin/UV/color values unchanged`);
        const flags = Array.from(attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE));
        equal(flags.slice(0, originalEdges), beforeFeatures, 'old edge feature storage preserved');
        equal(flags.slice(originalEdges), Array(single ? 1 : 2).fill(0), 'new diagonals are not features');
        check(attributeView(e, mesh, 'v:feature', Property.BOOL).every(value => value === 1), 'vertex feature flags unchanged');
        const originForFace = output.faces.map(face => {
          const origins = input.faces.map((original, origin) => face.every(vertex => original.includes(vertex)) ? origin : -1)
            .filter(origin => origin >= 0);
          equal(origins.length, 1, 'each child face identifies one source polygon');
          return origins[0];
        });
        for (const [name, type, components, expected] of faceChannels) {
          const values = attributeView(e, mesh, name, type, Domain.FACE);
          for (let f = 0; f < current.faces; ++f)
            equal(Array.from(values.subarray(f * components, (f + 1) * components)),
              expected.slice(originForFace[f] * components, (originForFace[f] + 1) * components), `${name}: source face copied`);
        }
        const connectivity = Array.from(meshView(e, mesh).halfedges);
        for (const [name, type, components, origins, expectedOld] of cornerChannels) {
          const values = attributeView(e, mesh, name, type, Domain.HALFEDGE);
          for (let h = 0; h < originalEdges * 2; ++h)
            equal(Array.from(values.subarray(h * components, (h + 1) * components)),
              expectedOld.slice(h * components, (h + 1) * components), `${name}: original corner/boundary values preserved`);
          for (let h = originalEdges * 2; h < current.edges * 2; ++h) {
            const face = connectivity[h * 4], vertex = connectivity[h * 4 + 1];
            equal(Array.from(values.subarray(h * components, (h + 1) * components)),
              origins[originForFace[face]].get(vertex), `${name}: new corner copies same source polygon and target vertex`);
          }
        }
        for (let h = 0; h < originalEdges * 2; ++h)
          equal(connectivity[h * 4 + 1], originalHalfedges[h * 4 + 1], 'old halfedge target index preserved');
        e.pmp_free(indices); e.pmp_free(offsets); e.pmp_free(mapping);
        return { counts: output.counts, faceOrigins: originForFace, attributes: vertexChannels.length + faceChannels.length + cornerChannels.length };
      }));

  const capture = (e, mesh, channels) => {
    const save = (name, values) => ({ name, offset: values.byteOffset,
      bytes: Array.from(new Uint8Array(e.memory.buffer, values.byteOffset, values.byteLength)) });
    const view = meshView(e, mesh), saved = Object.keys(view).filter(key => ArrayBuffer.isView(view[key]))
      .map(key => save(key, view[key]));
    for (const [name, type, domain] of (channels || [])) {
      const values = attributeView(e, mesh, name, type, domain);
      if (values) saved.push(save(name, values));
    }
    return saved;
  };
  const trapped = async (input, operation, args, setup) => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create();
    construct(e, mesh, input);
    addDerived(e, mesh);
    const extra = setup ? setup(e, mesh) : [];
    const saved = capture(e, mesh, derived.concat(extra || []));
    let actualArgs = args;
    if (args.includes(null)) {
      const pointer = e.pmp_alloc(24) >>> 0;
      new Uint8Array(e.memory.buffer, pointer, 24).fill(123);
      actualArgs = args.map(argument => argument === null ? pointer : argument);
      saved.push({ name: 'caller output', offset: pointer, bytes: Array(24).fill(123) });
    }
    let error;
    try { e[operation](mesh, ...actualArgs); } catch (caught) { error = caught; }
    check(error instanceof WebAssembly.RuntimeError, `${operation}: expected Wasm trap`);
    // Only inspect memory after a trap. Never invoke another export on this instance.
    for (const entry of saved) {
      const values = new Uint8Array(e.memory.buffer, entry.offset, entry.bytes.length);
      check(values.every((value, i) => value === entry.bytes[i]), `${operation}: ${entry.name} unchanged before rejection`);
    }
    return { trappedBeforeMutation: true };
  };
  const grid = fixtures.find(entry => entry.name === 'curvature-kind-0-mode-0').input;
  const polygons = fixtures.find(entry => entry.name === 'triangulate-adjacent-quads').input;
  const tetra = fixtures.find(entry => entry.name === 'measurements-tetrahedron').input;
  const invalid = [
    ['curvature rejects enum above maximum', 'pmp_curvature', [5, 0, 0, 0]],
    ['curvature rejects negative enum', 'pmp_curvature', [-1, 0, 0, 0]],
    ['curvature rejects negative smoothing steps', 'pmp_curvature', [2, -1, 0, 0]],
    ['curvature rejects invalid tensor flag', 'pmp_curvature', [2, 0, 2, 0]],
    ['curvature rejects invalid two-ring flag', 'pmp_curvature', [2, 0, 0, 2]],
    ['fair rejects k=0', 'pmp_fair', [0]],
    ['triangulate_face rejects invalid face', 'pmp_triangulate_face', [INVALID]],
    ['preflight rejects first future algorithm', 'pmp_mesh_unsupported_properties', [14]],
  ];
  for (const [name, operation, args] of invalid) await run(name, () => trapped(grid, operation, args));
  await run('volume rejects polygon input before mutation', () => trapped(polygons, 'pmp_volume', []));
  for (const [operation, args] of [['pmp_fair', [1]], ['pmp_minimize_area', []], ['pmp_minimize_curvature', []]])
    await run(`${operation} rejects closed unconstrained mesh`, () => trapped(tetra, operation, args));
  await run('all-selected closed fairing still requires constraints', () => trapped(
    Object.assign({}, tetra, { selected: [0, 1, 2, 3] }), 'pmp_fair', [1]));
  await run('triangulation rejects custom edge interpolation before mutation', () => trapped(polygons, 'pmp_triangulate', [],
    (e, mesh) => {
      attributeView(e, mesh, 'user:edgeMaterial', Property.U32, Domain.EDGE, true).fill(99);
      equal(e.pmp_mesh_unsupported_properties(mesh, Algorithm.TRIANGULATE), 4, 'edge domain is explicitly unsupported');
      return [['user:edgeMaterial', Property.U32, Domain.EDGE]];
    }));
  for (const state of ['edge-only', 'vertex-only', 'inconsistent-endpoints'])
    await run(`triangulation rejects ${state} features`, () => trapped(polygons, 'pmp_triangulate', [], (e, mesh) => {
      const attached = [];
      if (state !== 'edge-only') {
        attributeView(e, mesh, 'v:feature', Property.BOOL, Domain.VERTEX, true).fill(0);
        attached.push(['v:feature', Property.BOOL, Domain.VERTEX]);
      }
      if (state !== 'vertex-only') {
        attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE, true)[0] = 1;
        attached.push(['e:feature', Property.BOOL, Domain.EDGE]);
      }
      equal(e.pmp_mesh_unsupported_properties(mesh, Algorithm.TRIANGULATE), 5, 'paired feature flags and endpoints required');
      return attached;
    }));
  const empty = { positions: [], faces: [] };
  await run('empty mesh has zero area volume and components', () => withMesh((e, mesh) => {
    equal(e.pmp_surface_area(mesh), 0, 'empty surface area');
    equal(e.pmp_volume(mesh), 0, 'empty volume');
    equal(e.pmp_connected_components(mesh), 0, 'empty component count');
    return { area: 0, volume: 0, components: 0 };
  }));
  for (const operation of ['pmp_mean_edge_length', 'pmp_min_edge_length', 'pmp_min_face_area', 'pmp_bounds', 'pmp_centroid'])
    await run(`${operation} rejects empty domain`, async () => {
      const e = await instantiate(module), mesh = e.pmp_mesh_create(), pointer = e.pmp_alloc(24) >>> 0;
      new Float32Array(e.memory.buffer, pointer, 6).fill(123);
      let error;
      try { e[operation](mesh, pointer); } catch (caught) { error = caught; }
      check(error instanceof WebAssembly.RuntimeError, 'undefined empty result traps');
      equal(Array.from(new Float32Array(e.memory.buffer, pointer, 6)), Array(6).fill(123), 'output sentinel unchanged');
      return { trappedBeforeMutation: true };
    });
  await run('centroid rejects zero total surface area', () => trapped(
    { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], faces: [[0, 1, 2]] }, 'pmp_centroid', [null]));
  const finiteOperations = [['pmp_triangulate', []], ['pmp_triangulate_face', [0]], ['pmp_curvature', [2, 0, 0, 0]],
    ['pmp_fair', [1]], ['pmp_minimize_area', []], ['pmp_minimize_curvature', []], ['pmp_connected_components', []],
    ['pmp_surface_area', []], ['pmp_volume', []], ['pmp_mean_edge_length', []], ['pmp_min_edge_length', []],
    ['pmp_min_face_area', []], ['pmp_bounds', [null]], ['pmp_centroid', [null]]];
  for (const [operation, args] of finiteOperations)
    await run(`${operation} rejects non-finite geometry`, () => trapped(grid, operation, args,
      (e, mesh) => { meshView(e, mesh).positions[0] = NaN; return []; }));

  // A detached triangle fan at one vertex is accepted by construction but has
  // two boundary gaps. Preflight must reject before triangulating any face.
  const nonmanifold = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    4, 0, 0, 5, 0, 0, 4, 1, 0, 3, 0, 0, 4, -1, 0],
  faces: [[0, 1, 2, 3], [4, 5, 6], [4, 7, 8]] };
  await run('triangulation rejects a later non-manifold face before any mutation', () => trapped(nonmanifold, 'pmp_triangulate', []));
  await run('triangulate_face rejects non-manifold polygon vertices', () => trapped(nonmanifold, 'pmp_triangulate_face', [1]));

  // Native PMP can skip diagonals that already exist outside the source face,
  // return successfully, and leave a quad. The wrapper must catch the failed
  // postcondition. This can happen after mutation, so abandon the instance.
  const blockedDiagonals = {
    positions: [0.5204026699066162, 0, 0, 0.5215778946876526, 0.9828557372093201, 0,
      -0.7050147652626038, 0.5304073691368103, 0, -0.99588942527771, 1.2838571025762036e-16, 0,
      -0.548050045967102, -1.11150062084198, 0, 0.26992714405059814, -1.0771634578704834, 0],
    faces: [[0, 1, 2, 3, 4, 5], [0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 5, 4]],
  };
  for (const [operation, args] of [['pmp_triangulate', []], ['pmp_triangulate_face', [0]]])
    await run(`${operation} traps when existing outside diagonals prevent complete triangulation`, async () => {
      const e = await instantiate(module), mesh = e.pmp_mesh_create();
      construct(e, mesh, blockedDiagonals);
      const view = meshView(e, mesh), before = snapshot(view, 'closed manifold hexagon with opposite fan');
      equal(before.counts, [6, 9, 5], 'the hexagon and four opposite fan triangles are present');
      for (let vertex = 0; vertex < view.vertices; ++vertex) {
        const outgoing = [];
        for (let h = 0; h < view.edges * 2; ++h) {
          check(view.halfedges[h * 4] !== INVALID, 'regression mesh is closed');
          if (view.halfedges[(h ^ 1) * 4 + 1] === vertex) outgoing.push(h);
        }
        const first = view.vertexHalfedges[vertex], orbit = new Set();
        let h = first;
        do {
          check(outgoing.includes(h) && !orbit.has(h), 'vertex link visits each outgoing halfedge once');
          orbit.add(h);
          h = view.halfedges[(h ^ 1) * 4 + 2];
        } while (h !== first);
        equal(orbit.size, outgoing.length, 'vertex has a single manifold link');
      }
      equal(e.pmp_mesh_unsupported_properties(mesh, Algorithm.TRIANGULATE), 0, 'property preflight accepts the regression input');
      let error;
      try { e[operation](mesh, ...args); } catch (caught) { error = caught; }
      check(error instanceof WebAssembly.RuntimeError, 'incomplete native triangulation must trap');
      // No export calls, memory inspection, or destruction after this trap.
      return { trapped: true, discardedInstance: true };
    });

  for (const [operation, args] of [['pmp_triangulate', []], ['pmp_triangulate_face', [0]],
    ['pmp_curvature', [2, 0, 0, 0]], ['pmp_fair', [1]]])
    await run(`${operation} rejects oversized polygon dimensions before mutation`, async () => {
      const count = operation.indexOf('triangulate') >= 0 ? 16384 : 20000;
      const input = { positions: [], faces: [Array.from({ length: count }, (_, i) => i)] };
      for (let i = 0; i < count; ++i) {
        const angle = 2 * Math.PI * i / count;
        input.positions.push(3 * Math.cos(angle), 3 * Math.sin(angle), 0);
      }
      check(count * count > 0x7fffffff / 8, 'triangulation allocation dimensions exceed the signed byte limit');
      check((count + 1) * (count + 1) > 0x7fffffff / 8, 'polygon numerical matrix exceeds the signed byte limit');
      return trapped(input, operation, args);
    });

  const overflow = { positions: [-1e20, -1e20, 0, 1e20, -1e20, 0, 1e20, 1e20, 0, -1e20, 1e20, 0],
    faces: [[0, 1, 2, 3]] };
  for (const [operation, args] of [['pmp_triangulate', []], ['pmp_triangulate_face', [0]]])
    await run(`${operation} rejects finite-coordinate weight overflow without invalid indexing`, () => trapped(overflow, operation, args));

  await run('curvature and component outputs survive growth and mesh reuse', async () => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create(), other = e.pmp_mesh_create();
    const output = [];
    for (let lifetime = 0; lifetime < 3; ++lifetime) {
      if (lifetime) e.pmp_mesh_clear(mesh);
      construct(e, mesh, grid);
      e.pmp_curvature(mesh, 2, 1, 1, 1);
      equal(e.pmp_connected_components(mesh), 1, 'reused mesh component count');
      const curves = attributeView(e, mesh, 'v:curv', Property.F32);
      const labels = attributeView(e, mesh, 'v:component', Property.I32);
      const expected = Array.from(curves), pointers = [curves.byteOffset, labels.byteOffset], previous = e.memory.buffer;
      e.pmp_mesh_reserve(other, Math.floor(previous.byteLength / 12) + 1, 0, 0);
      equal(previous.byteLength, 0, 'growth detaches previous memory');
      const currentCurves = attributeView(e, mesh, 'v:curv', Property.F32);
      const currentLabels = attributeView(e, mesh, 'v:component', Property.I32);
      equal([currentCurves.byteOffset, currentLabels.byteOffset], pointers, 'native output allocations survive unrelated growth');
      equal(Array.from(currentCurves), expected, 'curvature retained across memory growth');
      equal(Array.from(currentLabels), Array(grid.positions.length / 3).fill(0), 'component labels retained across memory growth');
      output.push({ vertices: currentLabels.length, components: 1 });
    }
    e.pmp_mesh_destroy(other); e.pmp_mesh_destroy(mesh);
    return { lifetimes: output.length, outputs: output };
  });
  return { cases, assertions };
}
