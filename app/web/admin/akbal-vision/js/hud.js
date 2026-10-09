// Maps video-pixel bboxes to on-screen CSS pixels under object-fit:cover and
// the front-camera mirror, then draws HUD corners that lerp toward the target
// each render frame (jitter-free). Full HUD for the primary, minimal for others.
export function createHud(sceneApi, THREE) {
  const groups = new Map(); // id -> { group, cur:{x,y,w,h} }

  function mapBox(b, m) {
    // object-fit:cover scale + centering offset
    const scale = Math.max(m.cssW / m.videoW, m.cssH / m.videoH);
    const dispW = m.videoW * scale, dispH = m.videoH * scale;
    const offX = (m.cssW - dispW) / 2, offY = (m.cssH - dispH) / 2;
    let x = offX + b.x * scale, y = offY + b.y * scale;
    const w = b.w * scale, h = b.h * scale;
    if (m.mirror) x = m.cssW - (x + w); // horizontal flip to match the mirrored video
    return { x, y, w, h };
  }

  function makeGroup(primary) {
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x00ff66, transparent: true, opacity: primary ? 1 : 0.5 });
    const geo = new THREE.BufferGeometry();
    group.add(new THREE.LineSegments(geo, mat)); // children[0] = bbox corners
    // children[1] = selected landmarks (small crosshairs), primary only
    const lmMat = new THREE.LineBasicMaterial({ color: 0x00ff66, transparent: true, opacity: 0.85 });
    group.add(new THREE.LineSegments(new THREE.BufferGeometry(), lmMat));
    group.userData.mat = mat;
    sceneApi.scene.add(group);
    return group;
  }

  // Short crosshairs at each mapped landmark point (video px → screen px).
  function landmarkPoints(landmarks, m) {
    const pts = [];
    const r = 3;
    for (const p of landmarks) {
      const q = mapBox({ x: p.x, y: p.y, w: 0, h: 0 }, m);
      pts.push(new THREE.Vector3(q.x - r, q.y, 0), new THREE.Vector3(q.x + r, q.y, 0));
      pts.push(new THREE.Vector3(q.x, q.y - r, 0), new THREE.Vector3(q.x, q.y + r, 0));
    }
    return pts;
  }

  function cornerPoints(x, y, w, h, c) {
    const L = (x1, y1, x2, y2) => [new THREE.Vector3(x1, y1, 0), new THREE.Vector3(x2, y2, 0)];
    return [
      ...L(x, y, x + c, y), ...L(x, y, x, y + c),
      ...L(x + w, y, x + w - c, y), ...L(x + w, y, x + w, y + c),
      ...L(x, y + h, x + c, y + h), ...L(x, y + h, x, y + h - c),
      ...L(x + w, y + h, x + w - c, y + h), ...L(x + w, y + h, x + w, y + h - c),
    ];
  }

  function update(snapshot, metrics) {
    const seen = new Set();
    for (const s of Object.values(snapshot.subjects)) {
      seen.add(s.id);
      const t = mapBox(s.bbox, metrics);
      let entry = groups.get(s.id);
      if (!entry) { entry = { group: makeGroup(s.isPrimary), cur: { ...t } }; groups.set(s.id, entry); }
      const a = 0.18; // lerp toward target
      entry.cur.x += (t.x - entry.cur.x) * a; entry.cur.y += (t.y - entry.cur.y) * a;
      entry.cur.w += (t.w - entry.cur.w) * a; entry.cur.h += (t.h - entry.cur.h) * a;
      const c = Math.min(entry.cur.w, entry.cur.h) * 0.22;
      const line = entry.group.children[0];
      line.geometry.setFromPoints(cornerPoints(entry.cur.x, entry.cur.y, entry.cur.w, entry.cur.h, c));
      entry.group.userData.mat.opacity = s.isPrimary ? 1 : 0.5;
      // Landmarks: primary only; cleared otherwise so they never linger.
      const lm = entry.group.children[1];
      lm.geometry.setFromPoints(s.isPrimary && s.landmarks && s.landmarks.length ? landmarkPoints(s.landmarks, metrics) : []);
    }
    for (const [id, entry] of groups) {
      if (!seen.has(id)) {
        sceneApi.scene.remove(entry.group);
        // Free GPU buffers: the kiosk runs 24/7, so leaking a geometry+material
        // per distinct subject seen would grow unbounded over a long session.
        entry.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        groups.delete(id);
      }
    }
    sceneApi.render();
  }

  return { update };
}
