/**
 * Emit and parse a `solveContour({...})` call.
 *
 * The call is the contour. Dimension names are strings on the dimension,
 * not script bindings. Values are millimetres, or degrees for an angle.
 * A bare identifier is refused: a name does not escape the contour.
 */

function round4(n) {
  const r = Math.round(Number(n) * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}

function emitNum(n) {
  const r = round4(n);
  return Object.is(r, -0) ? '0' : String(r);
}

function emitString(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

function emitAt(at) {
  const parts = [];
  for (const [id, uv] of Object.entries(at)) {
    if (uv.length >= 2) parts.push(`${id}: [${emitNum(uv[0])}, ${emitNum(uv[1])}]`);
    else parts.push(`${id}: [${emitNum(uv[0])}]`);
  }
  return `{ ${parts.join(', ')} }`;
}

function emitItem(item) {
  const fields = [`id: ${emitString(item.id)}`, `kind: ${emitString(item.kind)}`];
  if (item.edge) fields.push(`edge: ${emitString(item.edge)}`);
  if (item.arc) fields.push(`arc: ${emitString(item.arc)}`);
  if (item.point) fields.push(`point: ${emitString(item.point)}`);
  if (item.a) fields.push(`a: ${emitString(item.a)}`);
  if (item.b) fields.push(`b: ${emitString(item.b)}`);
  if (item.items) fields.push(`items: [${item.items.map(emitString).join(', ')}]`);
  if (item.value != null) fields.push(`value: ${emitNum(item.value)}`);
  if (item.name) fields.push(`name: ${emitString(item.name)}`);
  if (item.side != null) fields.push(`side: ${item.side < 0 ? -1 : 1}`);
  if (item.sense != null) fields.push(`sense: ${item.sense < 0 ? -1 : 1}`);
  if (item.at) fields.push(`at: ${emitAt(item.at)}`);
  return `{ ${fields.join(', ')} }`;
}

function emitArc(arc) {
  const fields = [
    `id: ${emitString(arc.id)}`,
    `center: ${emitString(arc.center)}`,
    `radius: ${emitNum(arc.radius)}`,
  ];
  if (arc.full) fields.push('full: true');
  else {
    fields.push(`start: ${emitString(arc.start)}`);
    fields.push(`end: ${emitString(arc.end)}`);
  }
  if (arc.sweep) fields.push(`sweep: ${emitString(arc.sweep)}`);
  if (arc.segments != null) fields.push(`segments: ${Math.round(arc.segments)}`);
  return `{ ${fields.join(', ')} }`;
}

function emitPoint(p) {
  return `{ id: ${emitString(p.id)}, at: [${emitNum(p.at[0])}, ${emitNum(p.at[1])}] }`;
}

function emitLine(l) {
  return `{ id: ${emitString(l.id)}, a: ${emitString(l.a)}, b: ${emitString(l.b)} }`;
}

/**
 * The source of the call, not the solved return value. Seeds are rounded
 * to 4 decimals, matching the other contour emitters.
 */
export function emitSolveContour(model) {
  const spec = model || {};
  const body = [
    `points: [${(spec.points || []).map(emitPoint).join(', ')}]`,
    `lines: [${(spec.lines || []).map(emitLine).join(', ')}]`,
    `arcs: [${(spec.arcs || []).map(emitArc).join(', ')}]`,
    `dimensions: [${(spec.dimensions || []).map(emitItem).join(', ')}]`,
    `constraints: [${(spec.constraints || []).map(emitItem).join(', ')}]`,
  ];
  return `solveContour({ ${body.join(', ')} })`;
}

class Parser {
  constructor(text) {
    this.s = String(text || '');
    this.i = 0;
  }

  peek() {
    return this.s[this.i];
  }

  skip() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1;
  }

  fail(message) {
    throw new Error(`solveContour: ${message}`);
  }

  parseValue() {
    this.skip();
    const c = this.peek();
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"' || c === '\'') return this.parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    if (this.s.startsWith('true', this.i)) { this.i += 4; return true; }
    if (this.s.startsWith('false', this.i)) { this.i += 5; return false; }
    if (this.s.startsWith('null', this.i)) { this.i += 4; return null; }
    if (/[A-Za-z_$]/.test(c || '')) {
      this.fail('expected a number or a string, not a name. A dimension name stays inside the contour.');
    }
    this.fail('expected a value');
  }

  parseObject() {
    this.i += 1;
    const obj = {};
    for (;;) {
      this.skip();
      if (this.peek() === '}') { this.i += 1; return obj; }
      const key = this.parseKey();
      this.skip();
      if (this.peek() !== ':') this.fail('expected :');
      this.i += 1;
      obj[key] = this.parseValue();
      this.skip();
      if (this.peek() === ',') { this.i += 1; continue; }
      if (this.peek() === '}') { this.i += 1; return obj; }
      this.fail('expected , or }');
    }
  }

  parseKey() {
    this.skip();
    if (this.peek() === '"' || this.peek() === '\'') return this.parseString();
    const start = this.i;
    if (!/[A-Za-z_$]/.test(this.peek() || '')) this.fail('expected a field name');
    while (/[\w$]/.test(this.peek() || '')) this.i += 1;
    return this.s.slice(start, this.i);
  }

  parseArray() {
    this.i += 1;
    const arr = [];
    for (;;) {
      this.skip();
      if (this.peek() === ']') { this.i += 1; return arr; }
      arr.push(this.parseValue());
      this.skip();
      if (this.peek() === ',') { this.i += 1; continue; }
      if (this.peek() === ']') { this.i += 1; return arr; }
      this.fail('expected , or ]');
    }
  }

  parseString() {
    const q = this.s[this.i];
    this.i += 1;
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== q) {
      if (this.s[this.i] === '\\') {
        this.i += 1;
        out += this.s[this.i] || '';
        this.i += 1;
        continue;
      }
      out += this.s[this.i];
      this.i += 1;
    }
    if (this.s[this.i] !== q) this.fail('unterminated string');
    this.i += 1;
    return out;
  }

  parseNumber() {
    const start = this.i;
    if (this.peek() === '-') this.i += 1;
    while (/[0-9.]/.test(this.peek() || '')) this.i += 1;
    const n = Number(this.s.slice(start, this.i));
    if (!Number.isFinite(n)) this.fail('bad number');
    return n;
  }
}

function objectOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('solveContour: expected a contour object');
  }
  return value;
}

/**
 * Parse a `solveContour({...})` call or the object itself.
 * Returns the contour spec (points, lines, arcs, dimensions, constraints).
 */
export function parseSolveContour(source) {
  const text = String(source || '');
  const at = text.indexOf('solveContour');
  const body = at >= 0 ? text.slice(at) : text;
  const parser = new Parser(body);
  if (at >= 0) {
    parser.skip();
    if (!body.startsWith('solveContour')) parser.fail('expected solveContour');
    parser.i = 'solveContour'.length;
    parser.skip();
    if (parser.peek() !== '(') parser.fail('expected (');
    parser.i += 1;
  }
  const value = objectOf(parser.parseValue());
  return {
    points: value.points || [],
    lines: value.lines || [],
    arcs: value.arcs || [],
    dimensions: value.dimensions || [],
    constraints: value.constraints || [],
  };
}
