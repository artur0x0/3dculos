// Artur's iPhone repro: 3.175 mm SST316 hat bracket, four 90° bends at
// r = 3.81, one tab, one hole. The study is Aluminum 6061-T6, face 1 fixed,
// 200 N in +Y on face 8, mesh target auto.

export const SHEET_METALLICA_SCRIPT = `// --- sheet-metal begin ---
// SendCutSend Stainless Steel (316 Series) · SST316-125 — edit in Sheet Metal mode
const sheetSpec = {"v":1,"sku":"SST316-125","material":"Stainless Steel (316 Series)","t":3.175,"r":3.81,"k":0.38,"limits":{"bendable":true,"services":["bending","deburring","dimple_forming","hardware","powder","tapping","tumbling"],"minFlange":18.796,"maxAngle":120,"minAngle":null,"reliefDepth":7.493,"cornerRelief":0.508,"maxBendLength":457.2,"bendDeduction":6.096,"minFlat":[9.525,38.1],"maxFlat":[1117.6,762],"maxPart":[1117.6,762],"minPart":[9.525,6.35],"minHole":1.27,"minBridge":1.27,"minHoleToEdge":0.9652,"minHoleToBend":13.462},"plane":"XZ","width":100,"height":60,"bends":[{"id":"b1","panel":"base","edge":"u-","angle":90,"length":28.2,"flip":true},{"id":"b2","panel":"b1","edge":"u+","angle":90,"length":28.2,"flip":false},{"id":"b3","panel":"base","edge":"u+","angle":90,"length":28.2,"flip":true},{"id":"b4","panel":"b3","edge":"u+","angle":90,"length":28.2,"flip":false}],"tabs":[{"id":"t1","panel":"base","edge":"v+","width":25,"depth":10,"centered":true,"offset":37.5}],"holes":[{"id":"h1","panel":"base","u":-23.93,"v":1.91,"d":5,"type":"hole"}]};
let part = sheetMetalSolid(sheetSpec);
// --- sheet-metal end ---
return part;
// --- fea-study begin ---
// @fea-study {"v":1,"id":"s1","name":"Static 1","type":"linear-static","units":{"length":"mm","force":"N","stress":"MPa","note":"Length is mm, force is N, and stress, pressure, modulus, and yield are MPa. Face area is mm^2 and the face point at is mm."},"material":{"id":"al-6061-t6"},"model":"auto","fixtures":[{"kind":"fixed","faces":[{"faceID":1,"at":[74.89500045776367,38.994998931884766,0],"n":[0,1,0],"area":1692.0002746582031}]}],"loads":[{"kind":"force","faces":[{"faceID":8,"at":[-74.89500045776367,38.994998931884766,0],"n":[0,1,0],"area":1692.0002746582031}],"vector":[0,200,0]}],"mesh":{"target":"auto"},"result":null}
// --- fea-study end ---
`;

/** Outer flange face the study fixes. Inward is -Y, through the 3.175 mm gauge. */
export const SHEET_FLANGE_PROBE = Object.freeze({
  at: [74.89500045776367, 38.994998931884766, 0],
  inward: [0, -1, 0],
  gaugeMm: 3.175,
});
