// Globe 3D view (docs/gps.md): Three.js earth with the live GPS position pin
// and the satellites reported by the dongle orbiting it. Click a satellite
// for its detail card (same modal design as wardriving). The satellite
// positions are derived from az/el/SNR — elevation 90° = right above the
// receiver, so each satellite sits on a spike from the receiver's ground
// point; that's how a single-station GNSS receiver sees the sky (no real
// orbital ephemeris available). Module loaded only when the user toggles to
// globe view; gps.js keeps polling /api/gps/status and forwards snapshots.
"use strict";

const importMapReady = document.querySelector('script[type="importmap"]') !== null;
if (importMapReady) void main();
else console.warn("[globe] importmap missing — three.js unavailable");

async function main() {
  const THREE = await import("three");
  const { OrbitControls } = await import("./vendor/OrbitControls.js");

  // ─── Scene ────────────────────────────────────────────────────────────────
  const canvas = document.getElementById("gps-globe");
  const scene = new THREE.Scene();
  // Far plane covers the whole solar system view (Neptune ~30 AU).
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 6000);
  camera.position.set(0, 6, 22);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x03060c, 1);

  // Slow ambient starfield backdrop.
  {
    const starGeo = new THREE.BufferGeometry();
    const starCount = 1500;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 400 + Math.random() * 300;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x9fb6d9, size: 1.2, sizeAttenuation: true, transparent: true, opacity: 0.8 });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);
  }

  // ─── Earth ────────────────────────────────────────────────────────────────
  const EARTH_R = 10;
  const loader = new THREE.TextureLoader();
  let earthMesh = null;
  try {
    const dayTex = await loader.loadAsync("./vendor/textures/earth-day.jpg");
    dayTex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshPhongMaterial({
      map: dayTex,
      specular: new THREE.Color(0x223344),
      shininess: 8,
    });
    earthMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 64, 64), mat);
    scene.add(earthMesh);
    // Subtle atmosphere glow.
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.025, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x2b5ea8, transparent: true, opacity: 0.14, side: THREE.BackSide }),
    );
    scene.add(glow);
  } catch {
    // Texture fetch failed (offline Pi): procedural wireframe globe.
    earthMesh = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x123452, wireframe: true, transparent: true, opacity: 0.7 }),
    );
    scene.add(earthMesh);
  }
  // Lat/long grid hint (subtle) — helps reading az/el positions.
  {
    const grid = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.002, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0x7ab7ff, wireframe: true, transparent: true, opacity: 0.07 }),
    );
    scene.add(grid);
  }

  // ─── Lighting: the SUN at its real position ───────────────────────────────
  // Direction computed from the NOAA low-precision solar ephemeris (±0.01°),
  // expressed in the same equatorial frame the earth mesh uses (Y = north
  // pole). The DirectionalLight shines FROM the sun toward the earth, so the
  // day/night terminator on the globe matches reality.
  function solarDirectionEquatorial(date) {
    const rad = Math.PI / 180;
    const jd = date.getTime() / 86400000 + 2440587.5;
    const n = jd - 2451545.0; // days since J2000
    const L = (280.460 + 0.9856474 * n) % 360; // mean longitude
    const g = ((357.528 + 0.9856003 * n) % 360) * rad; // mean anomaly
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad; // ecliptic lon
    const eps = (23.439 - 0.0000004 * n) * rad; // obliquity
    return {
      x: Math.cos(lambda),
      y: Math.cos(eps) * Math.sin(lambda),
      z: Math.sin(eps) * Math.sin(lambda),
    };
  }

  // Ecliptic→equatorial rotation shared with the planets (same obliquity).
  // Correct ecl→eq transform: x_eq = x_ecl, y_eq = y_ecl·cosε − z_ecl·sinε,
  // z_eq = y_ecl·sinε + z_ecl·cosε — a rotation around X by +ε.
  function eclipticToEquatorial() {
    const now = new Date();
    const rad = Math.PI / 180;
    const jd = now.getTime() / 86400000 + 2440587.5;
    const n = jd - 2451545.0;
    const eps = (23.439 - 0.0000004 * n) * rad;
    return new THREE.Matrix4().makeRotationX(eps);
  }

  const SUN_DIST_UNITS = 120; // visual distance of the sun sprite from earth
  let sunMesh = null;
  {
    // Glow sprite: canvas-generated radial gradient, additive blending —
    // the most "impactful" part of the scene after the earth itself.
    const cnv = document.createElement("canvas");
    cnv.width = 256;
    cnv.height = 256;
    const ctx = cnv.getContext("2d");
    const grad = ctx.createRadialGradient(128, 128, 4, 128, 128, 128);
    grad.addColorStop(0, "rgba(255,255,240,1)");
    grad.addColorStop(0.12, "rgba(255,236,160,0.95)");
    grad.addColorStop(0.35, "rgba(255,190,80,0.4)");
    grad.addColorStop(0.7, "rgba(255,150,50,0.12)");
    grad.addColorStop(1, "rgba(255,140,40,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(cnv);
    sunMesh = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sunMesh.scale.setScalar(46);
    scene.add(sunMesh);
    // Core disc inside the glow.
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff4d6 }),
    );
    sunMesh.add(core);
  }

  // The DirectionalLight whose position tracks the real sun — this is what
  // lights the earth (and the planets, which are far enough to ignore).
  const sun = new THREE.DirectionalLight(0xffffff, 1.35);
  scene.add(sun);
  const sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  sun.target = sunTarget;
  scene.add(new THREE.AmbientLight(0xffffff, 0.35)); // low: keep night side dark for drama

  function updateSunPosition() {
    const d = new Date();
    const dir = solarDirectionEquatorial(d);
    // Equatorial (RA/dec) → sub-solar point (lat/lon) via GMST, then the
    // same latLonToVec3 mapping the earth mesh uses. This puts the light
    // over the true noon meridian (e.g. -77° at 17:00 UTC — South America
    // morning, Mexico ~9am) so the day/night terminator is correct.
    const n = d.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const raDeg = (Math.atan2(dir.y, dir.x) * 180 / Math.PI + 360) % 360;
    const decDeg = Math.asin(dir.z) * 180 / Math.PI;
    const gmst = (280.46061837 + 360.98564736629 * n) % 360;
    const lonSub = ((raDeg - gmst + 540) % 360) - 180;
    const pos = latLonToVec3(decDeg, lonSub, SUN_DIST_UNITS);
    sunMesh.position.copy(pos);
    sun.position.copy(pos);
    sunTarget.position.set(0, 0, 0);
    sunMesh.userData.equatorial = dir; // planets are placed in this frame
  }

  // ─── Planets at their real heliocentric positions ─────────────────────────
  // JPL approximate Keplerian elements (valid 1800–2050). Positions are
  // computed per-frame-ish (each globe view + every 60s) and rendered in
  // ecliptic coords rotated into the equatorial frame shared with the sun.
  // Visible when the camera zooms out past ~EARTH_R*4; scale exaggeration is
  // minimal and sizes are illustrative (real planet sizes are invisible at
  // this scale: ~1px per 1000 km at this distance).
  const PLANETS = [
    { name: "Mercurio", color: 0xb8a99a, size: 1.6, a: 0.38709927, e: 0.20563593, i: 7.00497902, L: 252.25032350, lp: 77.45779628, ln: 48.33076593, da: 0.00000037, de: 0.00001906, di: -0.00594749, dL: 149472.67411175, dlp: 0.16047689, dln: -0.12534081 },
    { name: "Venus", color: 0xe8d5a3, size: 2.4, a: 0.72333566, e: 0.00677672, i: 3.39467605, L: 181.97909950, lp: 131.60246718, ln: 76.67984255, da: 0.00000390, de: -0.00004107, di: -0.00078890, dL: 58517.81538729, dlp: 0.00268329, dln: -0.27769418 },
    { name: "Marte", color: 0xd1683f, size: 2.1, a: 1.52371034, e: 0.09339410, i: 1.84969142, L: -4.55343205, lp: -23.94362959, ln: 49.55953891, da: 0.00001847, de: 0.00007882, di: 0.00812131, dL: 19140.30268499, dlp: 0.29257343, dln: -0.29257343 },
    { name: "Júpiter", color: 0xd9b38c, size: 4.4, a: 5.20288700, e: 0.04838624, i: 1.30439695, L: 34.39644051, lp: 14.72847983, ln: 100.47390909, da: -0.00011607, de: -0.00013253, di: -0.00183714, dL: 3034.74612775, dlp: 0.21262690, dln: 0.20469106 },
    { name: "Saturno", color: 0xe3d29b, size: 3.8, a: 9.53667594, e: 0.05386179, i: 2.48599187, L: 49.95424423, lp: 92.59887831, ln: 113.66242448, da: -0.00125060, de: -0.00050991, di: 0.00193609, dL: 1222.49362201, dlp: -0.41897216, dln: -0.28867794 },
  ];

  // AU → world units: the inner planets would crowd the earth at true scale,
  // so use a compressed log-ish mapping that preserves ORDER and direction:
  // 1 AU ≈ 26 world units (sun at 120u sits ~4.6 AU — visually past venus,
  // which is fine because the sun sprite is a light source, not a body).
  const AU_UNITS = 26;

  function planetHelioEcliptic(el, date) {
    const T = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525; // centuries
    const a = el.a + el.da * T;
    const ec = el.e + el.de * T;
    const I = (el.i + el.di * T) * (Math.PI / 180);
    const L = (el.L + el.dL * T) % 360;
    const lp = el.lp + el.dlp * T;
    const ln = el.ln + el.dln * T;
    const w = (lp - ln) * (Math.PI / 180); // argument of perihelion
    const O = ln * (Math.PI / 180); // ascending node
    const M = ((L - lp) % 360) * (Math.PI / 180); // mean anomaly
    // Kepler's equation (Newton, 8 iters is plenty at these eccentricities)
    let E = M;
    for (let k = 0; k < 8; k++) E = E - (E - ec * Math.sin(E) - M) / (1 - ec * Math.cos(E));
    const xp = a * (Math.cos(E) - ec); // orbital plane, perihelion at +x
    const yp = a * Math.sqrt(1 - ec * ec) * Math.sin(E);
    const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
    // Rotate perifocal → ecliptic
    return {
      x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      z: sw * sI * xp + cw * sI * yp,
    };
  }

  // Geocentric position of a planet: heliocentric ecliptic − earth's
  // heliocentric position. Earth's heliocentric = −sun direction (in
  // ecliptic coords, at 1 AU). Then converted to the mesh's equatorial frame.
  const planetNodes = []; // { group, mesh, el, label }
  {
    for (const el of PLANETS) {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(el.size, 24, 24),
        new THREE.MeshPhongMaterial({ color: el.color, emissive: new THREE.Color(el.color).multiplyScalar(0.25), shininess: 4 }),
      );
      group.add(mesh);
      // Label sprite (canvas text) so each planet is identifiable at zoom.
      const lcnv = document.createElement("canvas");
      lcnv.width = 256;
      lcnv.height = 64;
      const lctx = lcnv.getContext("2d");
      lctx.font = "600 42px ui-monospace, monospace";
      lctx.fillStyle = "rgba(200,225,255,0.95)";
      lctx.textAlign = "center";
      lctx.shadowColor = "rgba(0,0,0,0.9)";
      lctx.shadowBlur = 8;
      lctx.fillText(el.name, 128, 54);
      const ltex = new THREE.CanvasTexture(lcnv);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: ltex, transparent: true, depthWrite: false, opacity: 0.85 }));
      label.scale.set(7, 1.75, 1);
      label.position.y = el.size + 2.2;
      group.add(label);
      group.visible = false; // LOD: revealed by camera distance
      scene.add(group);
      planetNodes.push({ group, mesh, el, label });
    }
  }

  let planetsPlacedAt = 0;
  function updatePlanets() {
    const now = new Date();
    // Cache: recompute at most once a minute (planets barely move).
    if (planetsPlacedAt && now - planetsPlacedAt < 60_000) return;
    planetsPlacedAt = now;
    // Earth's heliocentric ecliptic position = −sun direction × 1 AU:
    // the sun sits at direction (eq→ecl, −1) from earth, so earth from the
    // sun is the opposite vector, at exactly 1 AU.
    const sunEcl = sunEqToEcl(solarDirectionEquatorial(now)).multiplyScalar(-1);
    for (const node of planetNodes) {
      const helio = planetHelioEcliptic(node.el, now);
      // Geocentric = helio − earthHelio.
      const geo = new THREE.Vector3(helio.x, helio.y, helio.z).sub(sunEcl);
      const pos = eclipticToMesh(geo).multiplyScalar(AU_UNITS);
      node.group.position.copy(pos);
    }
  }

  // Ecliptic (geocentric) → scene coords. Planets are celestial objects:
  // in the earth-fixed mesh they must sit at (RA − GMST) longitude, the same
  // convention the sun uses, so the whole sky rotates correctly with the time
  // of day. v is in ecliptic coords; conversion chain: ecl → equatorial
  // (RA/dec) → hour angle (RA − GMST) → latLonToVec3.
  function eclipticToMesh(v) {
    const now = new Date();
    const rot = eclipticToEquatorial();
    const p = new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(rot); // equatorial
    const n = now.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const gmst = (280.46061837 + 360.98564736629 * n) % 360;
    const raDeg = (Math.atan2(p.y, p.x) * 180 / Math.PI + 360) % 360;
    const decDeg = Math.asin(p.z / p.length()) * 180 / Math.PI;
    const lonSub = ((raDeg - gmst + 540) % 360) - 180; // over-earth longitude
    // Direction from earth toward the planet (not a surface point, but the
    // same angular mapping keeps it aligned with the sun and the pin):
    const r = p.length();
    const ground = latLonToVec3(decDeg, lonSub, 1).normalize();
    return ground.multiplyScalar(r);
  }

  function sunEqToEcl(v) {
    // Inverse rotation of eclipticToEquatorial (rotate by −ε around X):
    // x_ecl = x_eq, y_ecl = y_eq·cosε + z_eq·sinε, z_ecl = −y_eq·sinε + z_eq·cosε.
    const rad = Math.PI / 180;
    const now = new Date();
    const jd = now.getTime() / 86400000 + 2440587.5;
    const n = jd - 2451545.0;
    const eps = (23.439 - 0.0000004 * n) * rad;
    return new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(new THREE.Matrix4().makeRotationX(-eps));
  }

  // LOD: planets fade in once the camera is far enough from earth.
  function updatePlanetLod() {
    const dist = camera.position.length();
    const show = dist > EARTH_R * 3.2; // ~zoomed out past the GNSS shell
    for (const node of planetNodes) {
      node.group.visible = show;
      node.group.children[1].material.opacity = show
        ? Math.min(0.9, (dist - EARTH_R * 3.2) / (EARTH_R * 4))
        : 0;
    }
    // Keep the sun glow readable at any distance.
    const glowScale = dist > EARTH_R * 6 ? Math.min(3.2, dist / (EARTH_R * 8)) : 1;
    sunMesh.scale.setScalar(46 * glowScale);
  }

  // ─── Receiver ground point + user marker ─────────────────────────────────
  // lat/lon → ECEF-ish on the sphere. lat/lon in degrees, radius in world units.
  function latLonToVec3(lat, lon, radius) {
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    );
  }

  let userMarker = null;
  let userLat = null;
  let userLon = null;

  function setUserPosition(lat, lon) {
    if (lat == null || lon == null) return;
    const moved = userLat === null || userLon === null
      || Math.abs(lat - userLat) > 0.0005 || Math.abs(lon - userLon) > 0.0005;
    userLat = lat;
    userLon = lon;
    if (moved) {
      const pos = latLonToVec3(lat, lon, EARTH_R + 0.02);
      if (!userMarker) {
        // Pin: bright dot + pulsing ring.
        const group = new THREE.Group();
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0x34d351 }),
        );
        dot.position.copy(pos);
        group.add(dot);
        const ringGeo = new THREE.RingGeometry(0.16, 0.2, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0x34d351, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        ring.lookAt(0, 0, 0);
        group.add(ring);
        group.userData.ring = ring;
        userMarker = group;
        scene.add(group);
      } else {
        userMarker.children[0].position.copy(pos);
        const ring = userMarker.userData.ring;
        ring.position.copy(pos);
        ring.lookAt(0, 0, 0);
      }
    }
  }

  // ─── Satellites ───────────────────────────────────────────────────────────
  // From the receiver's viewpoint: elevation 0° = on the horizon, 90° =
  // straight up. Each satellite renders on the az/el ray from the user's
  // ground point at GNSS orbit altitude (~20,200 km MEO ≈ scaled here to sit
  // well above the surface but inside the camera range). The spike from the
  // ground point to the satellite makes the geometry readable.
  const SAT_ALT_SCALE = 1.45; // satellite ring radius ≈ EARTH_R * 1.45
  const satMeshes = new Map(); // prn → { group, mesh, data, ringMat }
  const SAT_COLORS = {
    used: 0x34d351,
    tracked: 0x7ab7ff,
    idle: 0x5a6b7d,
  };

  function satColor(s) {
    if (s.used) return SAT_COLORS.used;
    if (s.snr > 0) return SAT_COLORS.tracked;
    return SAT_COLORS.idle;
  }

  function satLabel(s) {
    // GP→GPS, GL→GLONASS, GA→Galileo, GB/BD→BeiDou
    const m = /^([A-Z]{2})?0*(\d+)$/.exec(s.prn || "");
    const system = { GP: "GPS", GL: "GLONASS", GA: "Galileo", GB: "BeiDou", BD: "BeiDou", "" : "GNSS" }[m?.[1] || ""];
    return system ? `${system} ${m?.[2] || s.prn}` : s.prn;
  }

  function satWorldPos(s) {
    if (!userLat && userLat !== 0) return null;
    // az: 0°=N, 90°=E (clockwise from north). el: 0°=horizon, 90°=zenith.
    const az = s.azimuth >= 0 ? s.azimuth : 0;
    const el = s.elevation >= 0 ? s.elevation : 0;
    // Local ENU frame at the user's ground point:
    const ground = latLonToVec3(userLat, userLon, EARTH_R);
    const up = ground.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).projectOnPlane(up).normalize();
    const east = new THREE.Vector3().crossVectors(north, up).normalize();
    // Direction the satellite sits on, per az/el convention:
    const dir = new THREE.Vector3()
      .addScaledVector(east, Math.sin((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180))
      .addScaledVector(north, Math.cos((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180))
      .addScaledVector(up, Math.sin((el * Math.PI) / 180));
    dir.normalize();
    // Height above the surface: elevation 0° ≈ just above the ground,
    // elevation 90° (zenith) at SAT_ALT_SCALE. GNSS MEO ≈ 20,200 km, scaled.
    const height = (SAT_ALT_SCALE - 1) * EARTH_R * Math.sin((Math.max(el, 4) * Math.PI) / 180) + 0.35;
    return ground.add(dir.multiplyScalar(height));
  }

  function updateSatellites(sats) {
    if (!Array.isArray(sats)) return;
    const seen = new Set();
    for (const s of sats) {
      const prn = String(s.prn);
      seen.add(prn);
      const pos = satWorldPos(s);
      if (!pos) continue;
      let entry = satMeshes.get(prn);
      if (!entry) {
        const group = new THREE.Group();
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 16, 16),
          new THREE.MeshBasicMaterial({ color: satColor(s), transparent: true, opacity: 0.95 }),
        );
        mesh.userData.prn = prn;
        group.add(mesh);
        // Spike from the ground point to the satellite (visual tether).
        const ringGeo = new THREE.RingGeometry(0.26, 0.32, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: satColor(s), transparent: true, opacity: 0.6, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        group.add(ring);
        entry = { group, mesh, ring, ringMat, data: s };
        satMeshes.set(prn, entry);
        scene.add(group);
      }
      entry.data = s;
      const color = new THREE.Color(satColor(s));
      entry.mesh.material.color = color;
      entry.ringMat.color = color;
      entry.group.position.copy(pos);
      entry.ring.lookAt(0, 0, 0);
      // Pulse tracked/used satellites gently.
      entry.group.userData.pulse = s.used ? 1.0 : s.snr > 0 ? 0.55 : 0.25;
    }
    // Remove satellites no longer reported.
    for (const [prn, entry] of satMeshes) {
      if (!seen.has(prn)) {
        scene.remove(entry.group);
        satMeshes.delete(prn);
        if (selectedPrn === prn) closeSatModal();
      }
    }
  }

  // ─── Orbit controls ───────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = EARTH_R + 1.5;
  controls.maxDistance = EARTH_R * 12; // far enough to see Jupiter's orbit
  controls.zoomSpeed = 1.2;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;
  controls.rotateSpeed = 0.55;
  // Stop auto-rotation as soon as the user interacts, resume after idle.
  let idleTimer = null;
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
    if (idleTimer) clearTimeout(idleTimer);
  });
  controls.addEventListener("end", () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (controls.autoRotate = true), 8000);
  });

  // ─── Picking (click = select satellite; drag = rotate) ────────────────────
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerDown = null;
  let selectedPrn = null;

  renderer.domElement.addEventListener("pointerdown", (e) => {
    pointerDown = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - pointerDown.x;
    const dy = e.clientY - pointerDown.y;
    pointerDown = null;
    if (Math.hypot(dx, dy) > 6) return; // was a drag
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const meshes = [...satMeshes.values()].map((en) => en.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      selectSatellite(hits[0].object.userData.prn);
    } else {
      closeSatModal();
    }
  });

  function selectSatellite(prn) {
    selectedPrn = prn;
    const entry = satMeshes.get(prn);
    if (!entry) return;
    openSatModal(entry.data);
  }

  // ─── Modal (same card structure as the radar/wardrive .apm modal) ─────────
  const modal = document.getElementById("gps-sat-modal");
  const modalBackdrop = document.getElementById("gps-sat-modal-backdrop");
  const modalClose = document.getElementById("gps-sat-modal-close");

  function badge(status, label) {
    return `<span class="gsm-status-badge ${status}">${label}</span>`;
  }

  function openSatModal(s) {
    if (!modal || !s) return;
    const label = satLabel(s);
    document.getElementById("gsm-title").textContent = label;
    document.getElementById("gsm-prn").textContent = `${label} (PRN ${s.prn})`;
    const statusEl = document.getElementById("gsm-status");
    statusEl.innerHTML = s.used
      ? badge("used", "● EN FIX — parte de la solución de posición")
      : s.snr > 0
        ? badge("tracked", "▲ SEGUIMIENTO — señal recibida, aún no en fix")
        : badge("idle", "○ EN VISTA — demasado débil para usarse");
    document.getElementById("gsm-snr").textContent = s.snr > 0 ? `${s.snr} dB-Hz` : "sin señal";
    document.getElementById("gsm-elev").textContent = s.elevation >= 0 ? `${s.elevation}° sobre el horizonte` : "desconocida";
    document.getElementById("gsm-azim").textContent = s.azimuth >= 0 ? `${s.azimuth}° (desde el norte, sentido horario)` : "desconocido";
    document.getElementById("gsm-ground").textContent =
      s.elevation >= 0 && s.azimuth >= 0 && userLat != null
        ? `${s.elevation}° el · ${s.azimuth}° az desde tu posición`
        : "—";
    document.getElementById("gsm-dist").textContent = "≈ 20,200 km (órbita MEO de GNSS)";
    modal.classList.remove("hidden");
  }

  function closeSatModal() {
    selectedPrn = null;
    modal?.classList.add("hidden");
  }

  modalClose?.addEventListener("click", closeSatModal);
  modalBackdrop?.addEventListener("click", closeSatModal);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSatModal();
  });

  // ─── Snapshot plumbing from gps.js ────────────────────────────────────────
  window.__akbalGlobe = {
    update(lat, lon, sats) {
      const firstPositioning = userLat === null && lat != null;
      setUserPosition(lat, lon);
      if (firstPositioning) {
        // Frame the camera over the receiver's position so the pin is in
        // view the moment the globe opens.
        const target = latLonToVec3(lat, lon, EARTH_R * 2.6);
        camera.position.copy(target);
        controls.target.set(0, 0, 0);
        controls.update();
      }
      updateSatellites(sats);
    },
  };

  // ─── Render loop ──────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let loopRunning = false;
  let globeActive = false;
  function animate() {
    if (!globeActive) {
      loopRunning = false;
      return; // paused when the map view is shown
    }
    requestAnimationFrame(animate);
    loopRunning = true;
    const t = clock.getElapsedTime();
    // Pulse the user pin ring.
    if (userMarker) {
      const ring = userMarker.userData.ring;
      const pulse = 1 + 0.25 * Math.sin(t * 2.2);
      ring.scale.setScalar(pulse);
      ring.material.opacity = 0.75 - 0.25 * Math.sin(t * 2.2);
    }
    // Gentle pulse on satellite rings.
    for (const [, en] of satMeshes) {
      const amp = en.group.userData.pulse || 0.25;
      en.ring.scale.setScalar(1 + 0.3 * amp * Math.sin(t * 1.8 + en.group.position.x));
      en.mesh.material.opacity = 0.7 + 0.3 * amp * Math.sin(t * 2 + en.group.position.y);
    }
    // Solar system: real sun position (and light) + planets at their real
    // heliocentric spots, revealed by zoom-out.
    updateSunPosition();
    updatePlanets();
    updatePlanetLod();
    controls.update();
    renderer.render(scene, camera);
  }

  window.__akbalGlobe.setActive = (on) => {
    globeActive = on;
    if (on) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      if (!loopRunning) animate();
    }
  };
  window.__akbalGlobe.isActive = () => globeActive;

  window.addEventListener("resize", () => {
    if (!globeActive) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}