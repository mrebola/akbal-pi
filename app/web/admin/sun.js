// Realistic sun for the GPS globe (docs/gps.md) — adapted from the
// "Realistic Sun" three.js example (fwdapps.net/l/sun). Layers:
//   1. perlin cubemap baked each frame from a simplex-fbm shader box
//   2. sun sphere: brightness field from the cubemap (3 rotating layers) + fresnel
//   3. glow: billboard-ish quad skirt with radial alpha falloff
//   4. rays: additive noise-pushed wire strips flying outward
//   5. flares: arcing magma ribbons around the rim
// All placed by globe.js at the REAL solar direction (NOAA ephemeris).
// Imported as a module by globe.js.
import * as THREE from "three";

import sunSphereVS from "./sun-shaders/sunSphereVS.glsl";
import sunSphereFS from "./sun-shaders/sunSphereFS.glsl";
import perlinVS from "./sun-shaders/perlinVS.glsl";
import perlinFS from "./sun-shaders/perlinFS.glsl";
import glowVS from "./sun-shaders/glowVS.glsl";
import glowFS from "./sun-shaders/glowFS.glsl";
import sunRaysVS from "./sun-shaders/sunRaysVS.glsl";
import sunRaysFS from "./sun-shaders/sunRaysFS.glsl";
import sunFlaresVS from "./sun-shaders/sunFlaresVS.glsl";
import sunFlaresFS from "./sun-shaders/sunFlaresFS.glsl";

export class RealisticSun {
  constructor(renderer) {
    this.renderer = renderer;
    this.time = 0;
    this.group = new THREE.Group();
    this.lightDirWorld = new THREE.Vector3(1, 1, 1).normalize();
    this.buildPerlinCube();
    this.buildSun();
    this.buildGlow();
    this.buildRays();
    this.buildFlares();
  }

  // ─── Perlin cubemap (baked from the noise shader box each frame) ─────────
  buildPerlinCube() {
    this.perlinScene = new THREE.Scene();
    const res = 256; // 512 desktop in the original; 256 keeps the Pi happy
    this.cubeRT = new THREE.WebGLCubeRenderTarget(res, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
    });
    this.cubeCam = new THREE.CubeCamera(0.1, 100, this.cubeRT);
    this.perlinMat = new THREE.ShaderMaterial({
      vertexShader: perlinVS,
      fragmentShader: perlinFS,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uTime: { value: 0 },
        uSpatialFrequency: { value: 6 },
        uTemporalFrequency: { value: 0.1 },
        uH: { value: 1 },
        uContrast: { value: 0.25 },
        uFlatten: { value: 0.72 },
      },
    });
    this.perlinBox = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2, 1, 1, 1), this.perlinMat);
    this.perlinScene.add(this.perlinBox);
  }

  // ─── Sun sphere ────────────────────────────────────────────────────────────
  buildSun() {
    this.sunMaterial = new THREE.ShaderMaterial({
      vertexShader: sunSphereVS,
      fragmentShader: sunSphereFS,
      transparent: true,
      premultipliedAlpha: true,
      blending: THREE.NormalBlending,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
        uPerlinCube: { value: this.cubeRT.texture },
        uFresnelPower: { value: 1 },
        uFresnelInfluence: { value: 0.8 },
        uTint: { value: 0.2 },
        uBase: { value: 4 },
        uBrightnessOffset: { value: 1 },
        uBrightness: { value: 0.6 },
        uVisibility: { value: 1 },
        uDirection: { value: 1 },
        uLightView: { value: this.lightDirWorld.clone() },
      },
    });
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1.5, 64, 64), this.sunMaterial);
    this.group.add(this.sunMesh);
  }

  // ─── Glow (strip ribbon around the rim, camera-facing) ────────────────────
  buildGlow() {
    const segments = 134;
    const rSphere = 1.49;
    const positions = new Float32Array(3 * 2 * segments);
    let r = 0;
    for (let a = 0; a < segments; a++) {
      const s = (a / segments) * Math.PI * 2;
      positions[r++] = Math.sin(s) * rSphere;
      positions[r++] = Math.cos(s) * rSphere;
      positions[r++] = 0;
      positions[r++] = Math.sin(s) * rSphere;
      positions[r++] = Math.cos(s) * rSphere;
      positions[r++] = 1;
    }
    const indices = new Uint16Array(2 * segments * 3);
    let h = 0;
    for (let a = 0; a < segments; a++) {
      const base = a * 2;
      indices[h++] = base;
      indices[h++] = base + 1;
      indices[h++] = base + 2;
      indices[h++] = base + 2;
      indices[h++] = base + 1;
      indices[h++] = base + 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("aPos", new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    this.glowMaterial = new THREE.ShaderMaterial({
      vertexShader: glowVS,
      fragmentShader: glowFS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uRadius: { value: 0.8 },
        uTint: { value: 0.35 },
        uBrightness: { value: 0.55 },
        uFalloffColor: { value: 1.6 },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uCamPos: { value: new THREE.Vector3() },
        uViewProjection: { value: new THREE.Matrix4() },
        uVisibility: { value: 1 },
        uDirection: { value: 1 },
        uLightView: { value: this.lightDirWorld.clone() },
      },
    });
    this.glowMesh = new THREE.Mesh(geo, this.glowMaterial);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 2;
    this.group.add(this.glowMesh);
  }

  // ─── Rays (straight noisy strips flying outward) ───────────────────────────
  buildRays() {
    const lineCount = 1024; // desktop original uses 4095; halved for the Pi
    const lineLength = 8;
    const sunRadius = 1.49;
    const totalVerts = lineCount * lineLength * 2;
    const aPos = new Float32Array(totalVerts * 3);
    const aPos0 = new Float32Array(totalVerts * 3);
    const aWireRand = new Float32Array(totalVerts * 4);
    const indices = new Uint16Array(lineCount * (lineLength - 1) * 2 * 3);
    const base = new THREE.Vector3();
    const jitter = new THREE.Vector3();
    const held = new THREE.Vector3();
    let ip = 0, i0 = 0, ir = 0, ii = 0;
    const randomUnit = (v) => {
      const z = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(1 - z * z);
      v.set(rr * Math.cos(t), rr * Math.sin(t), z).normalize();
      return v;
    };
    for (let v = 0; v < lineCount; v++) {
      if (Math.random() < 0.1 || v === 0) {
        randomUnit(held);
        var d = Math.random();
        var p = Math.random();
      }
      base.copy(held);
      randomUnit(jitter).multiplyScalar(0.025);
      base.add(jitter).normalize();
      const rands = [d, p, Math.random(), Math.random()];
      for (let m = 0; m < lineLength; m++) {
        const vertBase = 2 * (v * lineLength + m);
        for (let y = 0; y <= 1; y++) {
          aPos[ip++] = (m + 0.5) / lineLength;
          aPos[ip++] = (v + 0.5) / lineCount;
          aPos[ip++] = 2 * y - 1;
          for (let t = 0; t < 4; t++) aWireRand[ir++] = rands[t];
          aPos0[i0++] = base.x * sunRadius;
          aPos0[i0++] = base.y * sunRadius;
          aPos0[i0++] = base.z * sunRadius;
        }
        if (m < lineLength - 1) {
          indices[ii++] = vertBase + 0;
          indices[ii++] = vertBase + 1;
          indices[ii++] = vertBase + 2;
          indices[ii++] = vertBase + 2;
          indices[ii++] = vertBase + 1;
          indices[ii++] = vertBase + 3;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("aPos", new THREE.BufferAttribute(aPos, 3));
    geo.setAttribute("aPos0", new THREE.BufferAttribute(aPos0, 3));
    geo.setAttribute("aWireRandom", new THREE.BufferAttribute(aWireRand, 4));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    this.sunRaysMaterial = new THREE.ShaderMaterial({
      vertexShader: sunRaysVS,
      fragmentShader: sunRaysFS,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uVisibility: { value: 1 },
        uDirection: { value: 1 },
        uLightView: { value: this.lightDirWorld.clone() },
        uWidth: { value: 0.03 },
        uLength: { value: 0.45 },
        uOpacity: { value: 0.03 },
        uNoiseFrequency: { value: 8 },
        uNoiseAmplitude: { value: 0.4 },
        uAlphaBlended: { value: 0.3 },
        uHueSpread: { value: 0.2 },
        uHue: { value: 0.2 },
      },
    });
    this.sunRaysMesh = new THREE.Mesh(geo, this.sunRaysMaterial);
    this.sunRaysMesh.frustumCulled = false;
    this.group.add(this.sunRaysMesh);
  }

  // ─── Flares (arcing magma ribbons around the rim) ──────────────────────────
  buildFlares() {
    const sunRadius = 1.49;
    const lineCount = 1024; // original 2047; halved for the Pi
    const lineLength = 16;
    const aPos = new Float32Array(lineCount * lineLength * 2 * 3);
    const aPos0 = new Float32Array(lineCount * lineLength * 2 * 3);
    const aPos1 = new Float32Array(lineCount * lineLength * 2 * 3);
    const aWireRand = new Float32Array(lineCount * lineLength * 2 * 4);
    const indices = new Uint16Array(lineCount * (lineLength - 1) * 2 * 3);
    const held = new THREE.Vector3();
    const d = new THREE.Vector3();
    const f = new THREE.Vector3();
    const p = new THREE.Vector3();
    const g = new THREE.Vector3();
    let s = 0, l = 0, c = 0, h = 0, u = 0;
    d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    f.set(Math.random(), Math.random(), Math.random()).normalize();
    let m = Math.random(), pp = Math.random();
    for (let y = 0; y < lineCount; y++) {
      if (Math.random() < 0.025 || y === 0) {
        d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        held.copy(d);
        g.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(0.4);
        held.add(g).normalize();
        m = Math.random();
        pp = Math.random();
      }
      f.copy(d);
      g.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(0.02);
      f.add(g).normalize();
      p.copy(held);
      g.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(0.075);
      p.add(g).normalize();
      const rands = [m, pp, Math.random(), Math.random()];
      for (let E = 0; E < lineLength; E++) {
        const base = 2 * (y * lineLength + E);
        for (let A = 0; A <= 1; A++) {
          aPos[s++] = (E + 0.5) / lineLength;
          aPos[s++] = (y + 0.5) / lineCount;
          aPos[s++] = 2 * A - 1;
          for (let R = 0; R < 4; R++) aWireRand[l++] = rands[R];
          aPos0[c++] = f.x * sunRadius;
          aPos0[c++] = f.y * sunRadius;
          aPos0[c++] = f.z * sunRadius;
          aPos1[h++] = p.x * sunRadius;
          aPos1[h++] = p.y * sunRadius;
          aPos1[h++] = p.z * sunRadius;
        }
        if (E < lineLength - 1) {
          indices[u++] = base + 0;
          indices[u++] = base + 1;
          indices[u++] = base + 2;
          indices[u++] = base + 2;
          indices[u++] = base + 1;
          indices[u++] = base + 3;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("aPos", new THREE.BufferAttribute(aPos, 3));
    geo.setAttribute("aPos0", new THREE.BufferAttribute(aPos0, 3));
    geo.setAttribute("aPos1", new THREE.BufferAttribute(aPos1, 3));
    geo.setAttribute("aWireRandom", new THREE.BufferAttribute(aWireRand, 4));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    this.sunFlaresMaterial = new THREE.ShaderMaterial({
      vertexShader: sunFlaresVS,
      fragmentShader: sunFlaresFS,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uVisibility: { value: 1 },
        uDirection: { value: 1 },
        uLightView: { value: this.lightDirWorld.clone() },
        uWidth: { value: 5e-3 },
        uAmp: { value: 0.5 },
        uOpacity: { value: 0.2 },
        uAlphaBlended: { value: 0.65 },
        uHueSpread: { value: 0.16 },
        uHue: { value: 0 },
        uNoiseFrequency: { value: 4 },
        uNoiseAmplitude: { value: 0.2 },
      },
    });
    this.sunFlaresMesh = new THREE.Mesh(geo, this.sunFlaresMaterial);
    this.sunFlaresMesh.frustumCulled = false;
    this.group.add(this.sunFlaresMesh);
  }

  // ─── Per-frame updates (called by globe.js's animate loop) ─────────────────
  update(camera, deltaSeconds) {
    this.time += deltaSeconds;
    // Bake the perlin cubemap (the original runs it every frame).
    this.perlinMat.uniforms.uTime.value = this.time * 0.1;
    this.cubeCam.update(this.renderer, this.perlinScene);

    this.sunMaterial.uniforms.uTime.value = this.time * 0.04;
    this.sunMaterial.uniforms.uLightView.value.copy(this.lightDirWorld);

    this.camera = camera;
    camera.updateMatrixWorld(true);
    const view = new THREE.Matrix4().copy(camera.matrixWorld).invert();
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, view);

    this.glowMaterial.uniforms.uViewProjection.value.copy(vp);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    this.glowMaterial.uniforms.uCamUp.value.copy(camUp);
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    this.glowMaterial.uniforms.uCamPos.value.copy(camPos);
    this.glowMaterial.uniforms.uLightView.value.copy(this.lightDirWorld);

    this.sunRaysMaterial.uniforms.uViewProjection.value.copy(vp);
    this.sunRaysMaterial.uniforms.uCamPos.value.copy(camPos);
    this.sunRaysMaterial.uniforms.uTime.value = this.time;
    this.sunRaysMaterial.uniforms.uLightView.value.copy(this.lightDirWorld);

    this.sunFlaresMaterial.uniforms.uViewProjection.value.copy(vp);
    this.sunFlaresMaterial.uniforms.uCamPos.value.copy(camPos);
    this.sunFlaresMaterial.uniforms.uTime.value = this.time;
    this.sunFlaresMaterial.uniforms.uLightView.value.copy(this.lightDirWorld);
  }
}