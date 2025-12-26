// ADVANCED CODE EXAMPLES

// TORUS KNOT
// The number of times the thread passes through the donut hole.
const p = 1;
// The number of times the thread circles the donut.
const q = 3;
// Radius of the interior of the imaginary donut.
const majorRadius = 25;
// Radius of the small cross-section of the imaginary donut.
const minorRadius = 10;
// Radius of the small cross-section of the actual object.
const threadRadius = 3.75;
// Number of linear segments making up the threadRadius circle. Default is
// getCircularSegments(threadRadius).
const circularSegments = -1;
// Number of segments along the length of the knot. Default makes roughly
// square facets.
const linearSegments = -1;

function gcd(a, b) {
    return b == 0 ? a : gcd(b, a % b);
}

const kLoops = gcd(p, q);
const pk = p / kLoops;
const qk = q / kLoops;
const n = 100;
const m = 1000;

const offset = 2
const circle = CrossSection.circle(1, n).translate([offset, 0]);

function rotate2D(point, angleRad) {
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    return [point[0] * cosA - point[1] * sinA, point[0] * sinA + point[1] * cosA];
}

const func = (v) => {
    const psi = qk * Math.atan2(v[0], v[1]);
    const theta = psi * pk / qk;
    const x1 = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    const phi = Math.atan2(x1 - offset, v[2]);
    let p3 = [threadRadius * Math.cos(phi), 0, threadRadius * Math.sin(phi)];
    const r = majorRadius + minorRadius * Math.cos(theta);
    let p2 = rotate2D([p3[1], p3[2]], -Math.atan2(pk * minorRadius, qk * r));
    p3 = [p3[0] + minorRadius, p2[0], p2[1]];
    p2 = rotate2D([p3[0], p3[2]], -theta);
    p3 = [p2[0] + majorRadius, p3[1], p2[1]];
    p2 = rotate2D([p3[0], p3[1]], psi);
    v[0] = p2[0];
    v[1] = p2[1];
    v[2] = p3[2];
};

const result = Manifold.revolve(circle, m).warp(func);
return result;

// HEART
const func = (v) => {
    const x2 = v[0] * v[0];
    const y2 = v[1] * v[1];
    const z = v[2];
    const z2 = z * z;
    const a = x2 + 9 / 4 * y2 + z2;
    const b = z * z2 * (x2 + 9 / 80 * y2);
    const a2 = a * a;
    const a3 = a * a2;

    const step = (r) => {
        const r2 = r * r;
        const r4 = r2 * r2;
        // Taubin's function
        const f = a3 * r4 * r2 - b * r4 * r - 3 * a2 * r4 + 3 * a * r2 - 1;
        // Derivative
        const df =
            6 * a3 * r4 * r - 5 * b * r4 - 12 * a2 * r2 * r + 6 * a * r;
        return f / df;
    };
    // Newton's method for root finding
    let r = 1.5;
    let dr = 1;
    while (Math.abs(dr) > 0.0001) {
        dr = step(r);
        r -= dr;
    }
    // Update radius
    v[0] *= r;
    v[1] *= r;
    v[2] *= r;
};

const ball = Manifold.sphere(1, 200);

const heart = ball.warp(func);
const box = heart.boundingBox();
const scale = 100 / (box.max[0] - box.min[0]);

return heart;

// GYROID MODULE
// number of modules along pyramid edge (use 1 for print orientation)
const m = 4;
// module size
const size = 20;
// SDF resolution
const n = 20;

const pi = 3.14159;

function gyroid(p) {
    const x = p[0] - pi / 4;
    const y = p[1] - pi / 4;
    const z = p[2] - pi / 4;
    return Math.cos(x) * Math.sin(y) + Math.cos(y) * Math.sin(z) +
        Math.cos(z) * Math.sin(x);
}

function gyroidOffset(level) {
    const period = 2 * pi;
    const box = {
        min: [-period, -period, -period],
        max: [period, period, period]
    };
    return Manifold.levelSet(gyroid, box, period / n, level).scale(size / period);
};

function rhombicDodecahedron() {
    const box = Manifold.cube([1, 1, 2], true).scale(size * Math.sqrt(2));
    const result = box.rotate([90, 45, 0]).intersect(box.rotate([90, 45, 90]));
    return result.intersect(box.rotate([0, 0, 45]));
}

const gyroidModule = rhombicDodecahedron()
    .intersect(gyroidOffset(-0.4))
    .subtract(gyroidOffset(0.4));

return gyroidModule;

// AUGER
const outerRadius = 20;
const beadRadius = 2;
const height = 40;
const twist = 90;

const { revolve, sphere, union, extrude } = Manifold;
const { circle } = CrossSection;
setMinCircularEdgeLength(0.1);

const bead1 =
    revolve(circle(beadRadius).translate([outerRadius, 0]), 50, 90)
        .add(sphere(beadRadius).translate([outerRadius, 0, 0]))
        .translate([0, -outerRadius, 0]);

const beads = [];
for (let i = 0; i < 3; i++) {
    beads.push(bead1.rotate(0, 0, 120 * i));
}
const bead = union(beads);

const auger = extrude(bead.slice(0), height, 50, twist);

const result =
    auger.add(bead).add(bead.translate(0, 0, height).rotate(0, 0, twist));
return result;


// FRAME DRAWER
// Demonstrates how at 90-degree intersections, the sphere and cylinder
// facets match up perfectly, for any choice of global resolution
// parameters.
const { sphere, cylinder, union, cube } = Manifold;

function roundedFrame(edgeLength, radius, circularSegments = 0) {
    const edge = cylinder(edgeLength, radius, -1, circularSegments);
    const corner = sphere(radius, circularSegments);

    const edge1 = union(corner, edge).rotate([-90, 0, 0]).translate([
        -edgeLength / 2, -edgeLength / 2, 0
    ]);

    const edge2 = union(
        union(edge1, edge1.rotate([0, 0, 180])),
        edge.translate([-edgeLength / 2, -edgeLength / 2, 0]));

    const edge4 = union(edge2, edge2.rotate([0, 0, 90])).translate([
        0, 0, -edgeLength / 2
    ]);

    return union(edge4, edge4.rotate([180, 0, 0]));
}

setMinCircularAngle(3);
setMinCircularEdgeLength(0.5);
const result = roundedFrame(100, 10);

// Demonstrate how you can use the .split method to perform
// a subtraction and an intersection at once
const [inside, outside] = result.split(cube(100, true));

const newInside = inside.translate(100,0,0)

const finalResult = union(newInside,outside)

return finalResult;

// TETRAHEDRON
const edgeLength = 50;  // Length of each edge of the overall tetrahedron.
const gap = 0.2;  // Spacing between the two halves to allow sliding.
const nDivisions = 50;  // Divisions (both ways) in the screw surface.

const scale = edgeLength / (2 * Math.sqrt(2));

const tet = Manifold.tetrahedron().intersect(
    Manifold.tetrahedron().rotate([0, 0, 90]).scale(2.5));

return tet;

// MENGER SPONGE
// This example demonstrates how symbolic perturbation correctly creates
// holes even though the subtracted objects are exactly coplanar.
function fractal(holes, hole, w, position, depth, maxDepth) {
    w /= 3;
    holes.push(
        hole.scale([w, w, 1.0]).translate([position[0], position[1], 0.0]));
    if (depth == maxDepth) return;
    const offsets = [
        [-w, -w], [-w, 0.0], [-w, w], [0.0, w], [w, w], [w, 0.0], [w, -w], [0.0, -w]
    ];
    for (let offset of offsets) {
        offset[0] += position[0];
        offset[1] += position[1];
        fractal(holes, hole, w, offset, depth + 1, maxDepth);
    }
}

function mengerSponge(n) {
    let result = Manifold.cube([1, 1, 1], true);
    const holes = [];
    fractal(holes, result, 1.0, [0.0, 0.0], 1, n);

    const hole = Manifold.compose(holes);

    result = Manifold.difference([
        result,
        hole,
        hole.rotate([90, 0, 0]),
        hole.rotate([0, 90, 0]),
    ]);
    return result;
}

const result = mengerSponge(3)
    .trimByPlane([1, 1, 1], 0)

return result;