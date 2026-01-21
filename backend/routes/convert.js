// routes/convert.js
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import Module from 'manifold-3d';
import config from '../config/index.js';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();
const execAsync = promisify(exec);

// Very conservative upload settings
const upload = multer({
    dest: `${config.uploadFolder}`,
    limits: {
        fileSize: 64 * 1024 * 1024,     // 128 MB
        fields: 8,                      // very few form fields allowed
        files: 1,                       // exactly one file
        parts: 20                       // prevent many small mime parts (zip bomb style)
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.step' && ext !== '.stp') {
            return cb(new Error('Only .step / .stp files allowed'));
        }
        cb(null, true);
    }
});

// Minimal sanitization of deflection/tolerance parameters
function safeParseFloat(str, fallback, min, max) {
    const v = parseFloat(str);
    if (isNaN(v) || !isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
}

// Basic OBJ face line parser with strict limits
async function safeParseOBJ(filepath) {
  const text = await fs.readFile(filepath, 'utf8');
  
  const vertices = [];
  const triangles = [];

  const lines = text.split(/\r?\n/);
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];

    if (cmd === 'v') {
      if (parts.length < 4) continue;
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
        console.warn(`[OBJ] Invalid vertex on line ${lineNumber}`);
        continue;
      }
      vertices.push([x, y, z]);
      if (vertices.length > 400_000) {
        throw new Error('OBJ has too many vertices (>400k)');
      }
    }
    else if (cmd === 'f') {
      if (parts.length < 4) continue;
      const indices = [];
      for (let i = 1; i < parts.length; i++) {
        const idxStr = parts[i].split('/')[0];
        const idx = parseInt(idxStr, 10);
        if (!idx || isNaN(idx)) continue;
        indices.push(idx - 1);
      }
      if (indices.length < 3) continue;

      if (indices.length === 3) {
        triangles.push(indices);
      } else if (indices.length === 4) {
        triangles.push([indices[0], indices[1], indices[2]]);
        triangles.push([indices[0], indices[2], indices[3]]);
      } else {
        console.warn(`[OBJ] Skipping face with ${indices.length} vertices on line ${lineNumber}`);
      }

      if (triangles.length > 800_000) {
        throw new Error('OBJ has too many triangles (>800k)');
      }
    }
  }

  console.log(`[OBJ] Parsed ${vertices.length} verts, ${triangles.length} tris`);
  return { vertices, triangles };
}

function tryToMakeManifold(wasm, mesh) {
    try {
        const manifold = new wasm.Manifold(mesh);
        if (manifold && !manifold.isEmpty()) {
            const vol = manifold.volume();
            if (!isFinite(vol) || vol < 0) return null;
            return manifold;
        }
    } catch (e) {
        if (e.message?.includes('Not manifold')) {
            return null;
        }
        throw e;
    }
    return null;
}

function meshToManifold(wasm, meshData, tolerance) {
    const mesh = new wasm.Mesh({
        numProp: meshData.numProp,
        vertProperties: meshData.vertProperties,
        triVerts: meshData.triVerts
    });

    let manifold = tryToMakeManifold(wasm, mesh);
    if (manifold) return manifold;

    if (typeof mesh.merge === 'function') {
        mesh.merge();
        manifold = tryToMakeManifold(wasm, mesh);
        if (manifold) return manifold;
    }

    if (tolerance > 0 && typeof mesh.merge === 'function') {
        mesh.tolerance = tolerance;
        mesh.merge();
        manifold = tryToMakeManifold(wasm, mesh);
        if (manifold) return manifold;
    }

    throw new Error('Could not construct valid manifold geometry');
}

router.post('/step',
  upload.single('file'),
  async (req, res) => {
    let inputPath = null;
    let outputPath = null;
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      const deflection = safeParseFloat(req.body.deflection, 0.1, 0.01, 5.0);
      const tolerance = safeParseFloat(req.body.tolerance, 0.001, 1e-6, 0.1);
      
      // ────────────────────────────────────────────────
      // Execute external converter with timeout + nice
      // ────────────────────────────────────────────────

      inputPath = req.file.path;
      const tempDir = path.dirname(inputPath);
      const name = path.parse(req.file.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const outputName = `conv_${name}_${Date.now()}.obj`;
      outputPath = path.join(tempDir, outputName);
      const converterPath = path.join(config.workingFolder, 'obj_converter');

      const firejailArgs = [
        'firejail',
        '--quiet',
        '--noprofile',
        '--net=none',
        '--seccomp',
        '--nonewprivs',
        '--rlimit-cpu=40',
        '--rlimit-as=600000000',
        '--timeout=00:00:42',
        `--whitelist=${config.workingFolder}`,
        '--env=LD_LIBRARY_PATH=/usr/local/lib',
        '--',
        converterPath,
        inputPath,
        outputPath,
        deflection.toFixed(4)
      ];

      console.log(`[Convert] firejail cmd: ${firejailArgs.join(' ')}`);
      let stdoutData = '';
      let stderrData = '';
      try {
        const { stdout, stderr } = await execAsync(firejailArgs.join(' '), {
          shell: '/bin/bash',
          timeout: 40000,
          maxBuffer: 1024 * 1024 * 6,
          encoding: 'utf8'
        });
        stdoutData = stdout || '';
        stderrData = stderr || '';
        if (stdoutData.trim()) {
          console.log('[obj_converter stdout]', stdoutData.trim().slice(0, 800));
        }
        if (stderrData.trim()) {
          console.warn('[obj_converter stderr]', stderrData.trim().slice(0, 2000));
        }
      } catch (execErr) {
        // Capture real exit code & full output even on non-zero exit
        stdoutData = execErr.stdout || '';
        stderrData = execErr.stderr || '';
        console.error('[firejail failed]', {
          message: execErr.message,
          code: execErr.code,
          signal: execErr.signal,
          stdout: stdoutData.slice(0, 1000),
          stderr: stderrData.slice(0, 2000)
        });
        throw new Error(`Converter process failed (code ${execErr.code || 'unknown'})`);
      }
      // After exec – check file
      let stats;
      try {
        stats = await fs.stat(outputPath);
      } catch (e) {
        console.error('[Convert] Output file missing after execution', {
          path: outputPath,
          stdout: stdoutData.slice(0, 600),
          stderr: stderrData.slice(0, 1500)
        });
        throw new Error('OBJ file was not created by converter');
      }
      if (stats.size < 200) {
        throw new Error('OBJ file created but too small (likely empty/invalid)');
      }
      // ────────────────────────────────────────────────
      // Parse OBJ defensively
      // ────────────────────────────────────────────────
      const { vertices, triangles } = await safeParseOBJ(outputPath);
      if (vertices.length === 0 || triangles.length === 0) {
        throw new Error('OBJ file contains no geometry');
      }
      // ────────────────────────────────────────────────
      // Prepare typed arrays for Manifold
      // ────────────────────────────────────────────────
      const vertProperties = new Float32Array(vertices.length * 3);
      for (let i = 0; i < vertices.length; i++) {
        vertProperties[i * 3 + 0] = vertices[i][0];
        vertProperties[i * 3 + 1] = vertices[i][1];
        vertProperties[i * 3 + 2] = vertices[i][2];
      }
      const triVerts = new Uint32Array(triangles.length * 3);
      for (let i = 0; i < triangles.length; i++) {
        triVerts[i * 3 + 0] = triangles[i][0];
        triVerts[i * 3 + 1] = triangles[i][1];
        triVerts[i * 3 + 2] = triangles[i][2];
      }
      const meshData = {
        numProp: 3,
        vertProperties,
        triVerts
      };
      // ────────────────────────────────────────────────
      // Manifold conversion with repair attempts
      // ────────────────────────────────────────────────
      const wasm = await Module();
      wasm.setup();
      const manifold = meshToManifold(wasm, meshData, tolerance);
      const volume = manifold.volume();
      if (!isFinite(volume) || volume <= 0) {
        throw new Error('Invalid volume after manifold construction');
      }
      const finalMesh = manifold.getMesh();
      const result = {
        success: true,
        filename: req.file.originalname,
        data: {
          vertProperties: Array.from(finalMesh.vertProperties),
          triVerts: Array.from(finalMesh.triVerts),
          numProp: finalMesh.numProp || 3,
          volume,
          boundingBox: manifold.boundingBox()
        }
      };
      res.json(result);
    }
    catch (err) {
      console.error('[Convert] Failed:', err.message);
      res.status(422).json({
        success: false,
        error: 'STEP conversion failed',
        details: err.message.substring(0, 300)
      });
    }
    finally {
        // Aggressive cleanup – ignore errors
        [inputPath, outputPath].forEach(p => {
            if (p) fs.unlink(p).catch(() => { });
        });
    }
  }
);

export default router;