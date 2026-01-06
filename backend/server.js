// server.js - With Manifold mesh repair logic
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import Module from 'manifold-3d';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.step' || ext === '.stp') {
      cb(null, true);
    } else {
      cb(new Error('Only STEP files allowed'));
    }
  }
});

const MODEL_CONFIG = {
  model: 'meta-llama/llama-4-scout-17b-16e-instruct',
  temperature: 1,
  top_p: 1,
  max_tokens: 2048,
};

app.post('/api/generate', async (req, res) => {
  try {
    const { messages } = req.body;
    const messagesWithSystem = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ];
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({ ...MODEL_CONFIG, messages: messagesWithSystem })
    });
    
    if (!response.ok) throw new Error(`Groq API error: ${response.status}`);
    res.json(await response.json());
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Parse OBJ file
function parseOBJ(filePath) {
  return fs.readFile(filePath, 'utf8').then(text => {
    const vertices = [];
    const triangles = [];
    
    const lines = text.split('\n');
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      
      if (parts[0] === 'v' && parts.length >= 4) {
        vertices.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3])
        ]);
      } else if (parts[0] === 'f' && parts.length >= 4) {
        const v1 = parseInt(parts[1].split('/')[0]) - 1;
        const v2 = parseInt(parts[2].split('/')[0]) - 1;
        const v3 = parseInt(parts[3].split('/')[0]) - 1;
        triangles.push([v1, v2, v3]);
        
        if (parts.length > 4) {
          const v4 = parseInt(parts[4].split('/')[0]) - 1;
          triangles.push([v1, v3, v4]);
        }
      }
    }
    
    console.log(`[Server] Parsed ${vertices.length} vertices, ${triangles.length} triangles`);
    return { vertices, triangles };
  });
}

// Try to create a Manifold (mimics tryToMakeManifold from import-model.ts)
function tryToMakeManifold(wasm, mesh) {
  try {
    const manifold = new wasm.Manifold(mesh);
    if (manifold && !manifold.isEmpty()) {
      const vol = manifold.volume();
      console.log(`[Server] Manifold created, volume: ${vol}`);
      return manifold;
    }
  } catch (e) {
    if (e.message && e.message.includes('Not manifold')) {
      console.log('[Server] Mesh is not manifold');
      return null;
    }
    throw e; // Re-throw other errors
  }
  return null;
}

// Convert mesh to Manifold with repair strategies (mimics meshesToManifold)
function meshToManifold(wasm, meshData, tolerance) {
  const { vertProperties, triVerts, numProp } = meshData;
  
  // Create a Mesh object
  const mesh = new wasm.Mesh({
    numProp: numProp,
    vertProperties: vertProperties,
    triVerts: triVerts
  });
  
  console.log('[Server] Strategy 1: Direct Manifold construction...');
  let manifold = tryToMakeManifold(wasm, mesh);
  
  if (!manifold && typeof mesh.merge === 'function') {
    console.log('[Server] Strategy 2: Merge primitives and retry...');
    mesh.merge();
    manifold = tryToMakeManifold(wasm, mesh);
  }
  
  if (!manifold && tolerance && typeof mesh.merge === 'function') {
    console.log(`[Server] Strategy 3: Apply tolerance (${tolerance}) and merge...`);
    mesh.tolerance = tolerance;
    mesh.merge();
    manifold = tryToMakeManifold(wasm, mesh);
  }
  
  if (!manifold) {
    throw new Error('Could not create manifold geometry after all repair strategies');
  }
  
  return manifold;
}

// STEP to Manifold via OBJ with mesh repair
app.post('/api/convert-manifold', upload.single('file'), async (req, res) => {
  let inputPath = null;
  let outputObjPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    inputPath = req.file.path;
    const originalName = path.parse(req.file.originalname).name;
    outputObjPath = `/tmp/${originalName}_${Date.now()}.obj`;
    const deflection = req.body.deflection || '0.1';
    const tolerance = parseFloat(req.body.tolerance || '0.001');

    console.log(`[Server] Converting ${req.file.originalname} to OBJ...`);

    // Step 1: Convert STEP to OBJ
    const converterPath = path.join(__dirname, '..', 'obj_converter');
    const convertCommand = `LD_LIBRARY_PATH=/usr/local/lib ${converterPath} "${inputPath}" "${outputObjPath}" ${deflection}`;
    
    const { stdout, stderr } = await execAsync(convertCommand, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024
    });

    if (stdout) console.log('[Server]', stdout);
    if (stderr) console.error('[Server]', stderr);
    await fs.access(outputObjPath);
    console.log('[Server] OBJ conversion successful');

    // Step 2: Parse OBJ
    console.log('[Server] Parsing OBJ...');
    const { vertices, triangles } = await parseOBJ(outputObjPath);

    // Step 3: Initialize Manifold WASM
    console.log('[Server] Loading Manifold WASM...');
    const wasm = await Module();
    wasm.setup();
    
    // Flatten arrays
    const vertProperties = new Float32Array(vertices.length * 3);
    for (let i = 0; i < vertices.length; i++) {
      vertProperties[i * 3] = vertices[i][0];
      vertProperties[i * 3 + 1] = vertices[i][1];
      vertProperties[i * 3 + 2] = vertices[i][2];
    }
    
    const triVerts = new Uint32Array(triangles.length * 3);
    for (let i = 0; i < triangles.length; i++) {
      triVerts[i * 3] = triangles[i][0];
      triVerts[i * 3 + 1] = triangles[i][1];
      triVerts[i * 3 + 2] = triangles[i][2];
    }
    
    const meshData = {
      numProp: 3,
      vertProperties: vertProperties,
      triVerts: triVerts
    };
    
    // Step 4: Create Manifold with repair strategies
    console.log('[Server] Creating Manifold with repair strategies...');
    const manifold = meshToManifold(wasm, meshData, tolerance);
    
    const volume = manifold.volume();
    console.log(`[Server] ✓ Success! Volume: ${volume} mm³`);

    // Step 5: Get final mesh and serialize
    const finalMesh = manifold.getMesh();
    const manifoldData = {
      vertProperties: Array.from(finalMesh.vertProperties),
      triVerts: Array.from(finalMesh.triVerts),
      numProp: finalMesh.numProp || 3,
      volume: volume,
      boundingBox: manifold.boundingBox()
    };

    console.log(`[Server] Serialized: ${finalMesh.vertProperties.length / 3} vertices, ${finalMesh.triVerts.length / 3} triangles`);

    // Cleanup
    try {
      if (inputPath) await fs.unlink(inputPath).catch(() => {});
      if (outputObjPath) await fs.unlink(outputObjPath).catch(() => {});
    } catch (err) {
      console.error('[Server] Cleanup error:', err);
    }

    res.json({
      success: true,
      filename: req.file.originalname,
      data: manifoldData
    });

  } catch (error) {
    console.error('[Server] Error:', error);
    console.error('[Server] Stack:', error.stack);
    
    try {
      if (inputPath) await fs.unlink(inputPath).catch(() => {});
      if (outputObjPath) await fs.unlink(outputObjPath).catch(() => {});
    } catch (err) {}

    res.status(500).json({ 
      success: false,
      error: 'Conversion failed',
      details: error.message 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));