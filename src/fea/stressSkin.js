/**
 * Lit von Mises skin for the active part.
 *
 * Same child-mesh idea as the face-color skin: unwelded triangles, vertex
 * colours, no raycast, depth write off. Render order sits above the paint
 * skin and under the contact-seam lines, so a pick highlight (6) stays on
 * top. The paint skin is order 2 with polygon offset
 * -1/-2. While this skin is visible the paint skin is hidden and its
 * previous visibility is put back on detach. The offset here is -2/-4 so a
 * frame where both are visible does not z-fight.
 *
 * Colours come from stressMap, keyed by this geometry and by faceID. A
 * rebuild that hands over a new geometry detaches the skin and tells the
 * study the result is stale. Stale colours are never left on screen.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { stressColor } from './colormap.js';
import {
  getStressSkinSource,
  stressAt,
  subscribeStressSkin,
} from './stressMap.js';

export { subscribeStressSkin };

/** Above the paint skin (2), under contact-seam lines (3) and pick highlights (6). */
export const STRESS_SKIN_RENDER_ORDER = 2.5;

const SKIN_NAME = 'stress-color-skin';
const HEADLIGHT_KEY = 'stress-color-skin-lit-v1';

function makeStressMaterial(side) {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    metalness: 0,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    side,
  });
  material.customProgramCacheKey = () => HEADLIGHT_KEY;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb = mix(
          pow((diffuseColor.rgb + vec3(0.055)) / vec3(1.055), vec3(2.4)),
          diffuseColor.rgb * vec3(1.0 / 12.92),
          vec3(lessThanEqual(diffuseColor.rgb, vec3(0.04045)))
        );`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        material.specularColor = vec3(0.0);`,
      )
      .replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
        {
          IncidentLight stressHeadlight;
          stressHeadlight.color = vec3(PI);
          stressHeadlight.direction = normalize(vViewPosition);
          stressHeadlight.visible = true;
          RE_Direct(stressHeadlight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
        }`,
      );
  };
  return material;
}

function hostSide(host) {
  const material = host?.material;
  const side = Array.isArray(material) ? material[0]?.side : material?.side;
  return side === DoubleSide ? DoubleSide : FrontSide;
}

function hidePaintSkin(host) {
  const paint = host?.userData?.faceColorSkin;
  if (!paint) return;
  const saved = host.userData.stressPaintHidden;
  if (!saved) {
    host.userData.stressPaintHidden = { visible: paint.visible !== false };
  }
  paint.visible = false;
}

function restorePaintSkin(host) {
  const saved = host?.userData?.stressPaintHidden;
  if (!saved) return;
  host.userData.stressPaintHidden = null;
  const paint = host?.userData?.faceColorSkin;
  if (paint) paint.visible = saved.visible;
}

function faceIdsOf(geometry) {
  return geometry?.getAttribute?.('faceID')?.array || geometry?.attributes?.faceID?.array || null;
}

function buildGeometry(geometry, field, scale) {
  const index = geometry?.index?.array;
  const src = geometry?.attributes?.position?.array;
  const faceIDs = faceIdsOf(geometry);
  if (!index?.length || !src?.length || !faceIDs?.length) return null;
  const triangles = Math.floor(index.length / 3);
  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  let w = 0;
  for (let t = 0; t < triangles; t++) {
    const face = faceIDs[t];
    for (let k = 0; k < 3; k++) {
      const vertex = index[t * 3 + k];
      const vi = vertex * 3;
      const rgb = stressColor(stressAt(field, face, vertex), scale);
      positions[w] = src[vi] ?? 0;
      colors[w] = rgb[0];
      w += 1;
      positions[w] = src[vi + 1] ?? 0;
      colors[w] = rgb[1];
      w += 1;
      positions[w] = src[vi + 2] ?? 0;
      colors[w] = rgb[2];
      w += 1;
    }
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(positions, 3));
  geom.setAttribute('color', new BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  return geom;
}

/** Drop the skin and give the paint skin its previous visibility back. */
export function detachStressSkin(host) {
  if (!host) return;
  const skin = host.userData?.stressSkin;
  if (skin) {
    host.remove(skin);
    skin.geometry?.dispose?.();
    skin.material?.dispose?.();
  }
  host.userData.stressSkin = null;
  host.userData.stressField = null;
  restorePaintSkin(host);
}

/**
 * Draw the current solve on this mesh, or remove it. A geometry that is
 * not the one that was solved marks the result stale and draws nothing.
 */
export function syncStressSkin(host) {
  if (!host) return null;
  const src = getStressSkinSource();
  const geometry = host.geometry;
  if (!src?.field || src.geometry !== geometry) {
    const mismatch = !!(src?.field && src.geometry && geometry && src.geometry !== geometry);
    detachStressSkin(host);
    if (mismatch) {
      try { src.onStale?.(); } catch { /* the study marks itself; the mesh still clears */ }
    }
    return null;
  }
  if (host.userData?.stressField === src.field && host.userData.stressSkin) {
    hidePaintSkin(host);
    return host.userData.stressSkin;
  }
  const painted = buildGeometry(geometry, src.field, src.scale);
  detachStressSkin(host);
  if (!painted) return null;
  const skin = new Mesh(painted, makeStressMaterial(hostSide(host)));
  skin.name = SKIN_NAME;
  skin.renderOrder = STRESS_SKIN_RENDER_ORDER;
  skin.frustumCulled = false;
  skin.raycast = () => {};
  skin.userData.stressSkin = true;
  host.add(skin);
  host.userData.stressSkin = skin;
  host.userData.stressField = src.field;
  hidePaintSkin(host);
  return skin;
}
