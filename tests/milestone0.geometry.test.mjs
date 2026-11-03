import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStrokeMesh } from '../src/geometry.ts';
import { createCloseupDocument, createDemoDocument, createDiagnosticDocument } from '../src/scene.ts';
import { lightingShader, substrateShader, surfaceShader } from '../src/shaders.ts';

function triangleArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5;
}

function assertValidMesh(mesh, label) {
  const vertexCount = mesh.vertices.length / 4;
  assert.equal(Number.isInteger(vertexCount), true, `${label}: packed vertex stride`);
  assert.equal(mesh.indices.length % 3, 0, `${label}: triangle index count`);
  for (let i = 0; i < mesh.vertices.length; i++) {
    assert.ok(Number.isFinite(mesh.vertices[i]), `${label}: vertex component ${i} is finite`);
  }
  let winding = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ia = mesh.indices[i];
    const ib = mesh.indices[i + 1];
    const ic = mesh.indices[i + 2];
    assert.ok(ia < vertexCount && ib < vertexCount && ic < vertexCount, `${label}: index ${i / 3} is in range`);
    const point = (index) => [mesh.vertices[index * 4], mesh.vertices[index * 4 + 1]];
    const a = point(ia);
    const b = point(ib);
    const c = point(ic);
    const signedArea2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    assert.ok(triangleArea(a, b, c) > 1e-8, `${label}: triangle ${i / 3} is not degenerate`);
    const triangleWinding = Math.sign(signedArea2);
    assert.ok(triangleWinding !== 0, `${label}: triangle ${i / 3} has defined winding`);
    if (winding === 0) winding = triangleWinding;
    assert.equal(triangleWinding, winding, `${label}: triangle ${i / 3} preserves mesh winding`);
  }
}

test('authored documents are byte-for-byte deterministic across generations', () => {
  assert.deepEqual(createDemoDocument(), createDemoDocument());
  assert.deepEqual(createDiagnosticDocument(), createDiagnosticDocument());
  assert.deepEqual(createCloseupDocument(), createCloseupDocument());
});

test('WGSL shaders do not reuse reserved identifiers that caused compilation failures', () => {
  for (const shader of [surfaceShader, substrateShader, lightingShader]) {
    const code = shader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /\b(?:smooth|macro|patch)\b/);
  }
  assert.match(surfaceShader, /smoothstep\(/, 'the smoothstep builtin remains available');
});

test('all authored strokes produce finite, indexed, non-degenerate ribbon geometry', () => {
  for (const document of [createDemoDocument(), createDiagnosticDocument(), createCloseupDocument()]) {
    assert.ok(document.strokes.length > 0);
    for (const stroke of document.strokes) {
      const mesh = buildStrokeMesh(stroke);
      assert.ok(mesh.vertices.length > 0, `${stroke.id}: generated mesh`);
      assertValidMesh(mesh, stroke.id);
    }
  }
});

test('diagnostic scene includes an intentional same-colour centerline crossing', () => {
  const document = createDiagnosticDocument();
  const a = document.strokes.find((stroke) => stroke.id === 'diag-base-ochre');
  const b = document.strokes.find((stroke) => stroke.id === 'diag-cross-ochre');
  assert.ok(a && b);
  assert.deepEqual(a.color, b.color);

  // The two centerline segments cross inside the shared coverage of both
  // ribbons, so this is a real ordering/compositing case for browser review.
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const crosses = (p1, p2, q1, q2) => orient(p1, p2, q1) * orient(p1, p2, q2) < 0 && orient(q1, q2, p1) * orient(q1, q2, p2) < 0;
  assert.ok(a.points.slice(0, -1).some((p, i) => b.points.slice(0, -1).some((q, j) => crosses(p, a.points[i + 1], q, b.points[j + 1]))));
});

test('color and relief metadata do not alter retained stroke mesh geometry', () => {
  const original = createDiagnosticDocument().strokes.find((stroke) => stroke.id === 'diag-base-ochre');
  const changed = { ...original, color: [1, 0, 1], height: original.height * 0.37 };
  const before = buildStrokeMesh(original);
  const after = buildStrokeMesh(changed);
  assert.deepEqual(after.vertices, before.vertices);
  assert.deepEqual(after.indices, before.indices);
});

test('duplicate and invalid points cannot create non-finite or degenerate geometry', () => {
  const base = createDiagnosticDocument().strokes[0];
  const stroke = {
    ...base,
    points: [[1, 1], [1, 1], [Number.NaN, 2], [20, 8], [36, 16], [36, 16]],
  };
  const mesh = buildStrokeMesh(stroke);
  assert.ok(mesh.vertices.length > 0);
  assertValidMesh(mesh, 'cleaned-input');
  assert.deepEqual(buildStrokeMesh({ ...stroke, points: [[3, 3], [3, 3], [Infinity, 1]] }), {
    vertices: new Float32Array(),
    indices: new Uint32Array(),
    arcLength: 0,
  });
});

test('unsafe reversals and nonadjacent centerline crossings are rejected', () => {
  const base = createDiagnosticDocument().strokes[0];
  const rejected = { vertices: new Float32Array(), indices: new Uint32Array(), arcLength: 0 };
  const reversal = buildStrokeMesh({ ...base, points: [[0, 0], [50, 0], [1, 0]], width: 34 });
  const crossing = buildStrokeMesh({ ...base, points: [[0, 0], [80, 80], [0, 80], [80, 0]], width: 24 });
  assert.deepEqual(reversal, rejected, 'near 180° reversal is rejected');
  assert.deepEqual(crossing, rejected, 'nonadjacent centerline self-intersection is rejected');
});

test('a tight smooth U bend is retained with a consistent, finite mesh', () => {
  const base = createDiagnosticDocument().strokes[0];
  const tightU = buildStrokeMesh({
    ...base,
    width: 38,
    points: [[0, 0], [18, 0], [32, 6], [41, 18], [42, 32], [34, 45], [20, 51], [5, 50]],
  });
  assert.ok(tightU.vertices.length > 0, 'smooth U bend stays renderable');
  assertValidMesh(tightU, 'tight-smooth-u');
});
