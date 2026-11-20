// 肥皂泡材质：菲涅尔边缘 + 薄膜干涉彩虹 + 单点镜面高光 + 表面流动微纹。
// 视野外的面全透明，只留轮廓和那一小点高光，所以既能读出「球」又不遮挡船体。
import * as THREE from 'three';

const VERT = /* glsl */`
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vP = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform vec3 uTint;
  uniform float uOpacity;
  uniform float uRim;
  uniform float uTime;
  uniform float uPhase;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;

  vec3 rainbow(float t) {
    return 0.5 + 0.5 * vec3(sin(t), sin(t + 2.094), sin(t + 4.188));
  }

  void main() {
    vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 V = normalize(vV);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 2.4);
    vec3 L = normalize(vec3(-0.40, 0.84, 0.38));
    float spec = pow(max(dot(reflect(-L, N), V), 0.0), 64.0);
    float shimmer = 0.5 + 0.5 * sin(vP.y * 4.5 + vP.x * 2.2 + uTime * 2.6 + uPhase);
    vec3 irid = rainbow(fres * 5.5 + ndv * 0.9 + uTime * 0.22 + uPhase * 3.0);
    float alpha = uOpacity * (0.04 + fres * uRim + spec * 1.2 + shimmer * 0.07 * fres);
    vec3 col = mix(uTint, irid, clamp(fres * 1.5 + spec * 1.4, 0.0, 1.0));
    col += vec3(1.0) * spec * 1.5;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

export function makeBubbleMaterial(opts = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTint: { value: new THREE.Color(opts.tint ?? 0x9fe8ff) },
      uOpacity: { value: opts.opacity ?? 0.9 },
      uRim: { value: opts.rim ?? 1 },
      uTime: { value: 0 },
      uPhase: { value: opts.phase ?? 0 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}