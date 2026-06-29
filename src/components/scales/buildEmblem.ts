import * as THREE from "three";

export const GOLD_MATERIAL = new THREE.MeshPhysicalMaterial({
  color: 0xc98a44,
  metalness: 1.0,
  roughness: 0.25,
  clearcoat: 0.5,
  clearcoatRoughness: 0.2,
  envMapIntensity: 1.3,
});

function link(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.MeshPhysicalMaterial) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 18), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return mesh;
}

function makePan(x: number, mat: THREE.MeshPhysicalMaterial) {
  const group = new THREE.Group();
  const top = new THREE.Vector3(0, 0, 0);
  const rimY = -0.66;
  const rimR = 0.4;

  const sus = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.014, 20, 48), mat);
  sus.rotation.x = Math.PI / 2;
  group.add(sus);

  const angles = [
    Math.PI / 2,
    Math.PI / 2 + (2 * Math.PI) / 3,
    Math.PI / 2 + (4 * Math.PI) / 3,
  ];
  for (const angle of angles) {
    const point = new THREE.Vector3(Math.cos(angle) * rimR, rimY, Math.sin(angle) * rimR);
    group.add(link(top, point, 0.011, mat));
  }

  const dishMat = mat.clone();
  dishMat.side = THREE.DoubleSide;
  const profile = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.12, 0.006),
    new THREE.Vector2(0.26, 0.032),
    new THREE.Vector2(0.37, 0.078),
    new THREE.Vector2(0.435, 0.125),
    new THREE.Vector2(0.45, 0.14),
  ];
  const dish = new THREE.Mesh(new THREE.LatheGeometry(profile, 120), dishMat);
  dish.position.y = rimY - 0.13;
  group.add(dish);

  group.position.set(x, 0.95, 0);
  return group;
}

/** Procedural metallic scales of justice — ported from the Sunrise design handoff. */
export function buildScalesEmblem(mat = GOLD_MATERIAL) {
  const emblem = new THREE.Group();

  emblem.add(new THREE.Mesh(new THREE.TorusGeometry(1.72, 0.085, 64, 256), mat));

  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.66, 0.09, 96), mat);
  foot.position.y = -1.34;
  emblem.add(foot);

  const step = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.46, 0.1, 96), mat);
  step.position.y = -1.22;
  emblem.add(step);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.27, 64, 48, 0, Math.PI * 2, 0, Math.PI / 2),
    mat,
  );
  dome.position.y = -1.15;
  emblem.add(dome);

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.085, 1.95, 64), mat);
  post.position.y = -0.1;
  emblem.add(post);

  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.03, 32, 96), mat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.74;
  emblem.add(collar);

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.12, 64), mat);
  cap.position.y = 0.9;
  emblem.add(cap);

  const pivot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 64, 64), mat);
  pivot.position.y = 1.0;
  emblem.add(pivot);

  const finBall = new THREE.Mesh(new THREE.SphereGeometry(0.075, 48, 48), mat);
  finBall.position.y = 1.14;
  emblem.add(finBall);

  const finTip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 48), mat);
  finTip.position.y = 1.27;
  emblem.add(finTip);

  const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.032, 0.5, 32), mat);
  needle.position.y = 0.68;
  emblem.add(needle);

  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.12, 48), mat);
  beam.rotation.z = Math.PI / 2;
  beam.position.y = 1.02;
  emblem.add(beam);

  for (const bx of [-1.04, 1.04]) {
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 48, 48), mat);
    knob.position.set(bx, 1.02, 0);
    emblem.add(knob);

    const eyelet = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 24, 64), mat);
    eyelet.position.set(bx, 0.95, 0);
    emblem.add(eyelet);
  }

  emblem.add(makePan(-1.04, mat));
  emblem.add(makePan(1.04, mat));

  emblem.scale.setScalar(0.92);
  emblem.position.y = 0.12;

  return emblem;
}

export function createSunriseEnvironment(renderer: THREE.WebGLRenderer) {
  const envCanvas = document.createElement("canvas");
  envCanvas.width = 512;
  envCanvas.height = 256;
  const ctx = envCanvas.getContext("2d");
  if (!ctx) return null;

  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, "#1d1547");
  grad.addColorStop(0.42, "#9c3f7e");
  grad.addColorStop(0.68, "#f0714e");
  grad.addColorStop(1.0, "#ffd98a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  const sun = ctx.createRadialGradient(372, 92, 3, 372, 92, 78);
  sun.addColorStop(0, "rgba(255,252,240,1)");
  sun.addColorStop(0.5, "rgba(255,238,196,0.6)");
  sun.addColorStop(1, "rgba(255,230,180,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(280, 0, 184, 184);

  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envMap = pmrem.fromEquirectangular(envTex).texture;
  envTex.dispose();
  pmrem.dispose();

  return envMap;
}
