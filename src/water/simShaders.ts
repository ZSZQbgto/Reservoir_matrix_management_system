/**
 * GPU 浅水模拟用的 GLSL 片段。
 *
 * 着色器全部以 WebGL1 风格书写（`varying` / `texture2D` / `gl_FragColor`），
 * three.js 的 ShaderMaterial 会自动把它们转成 GLSL ES 3.00；模拟 pass 里用到的
 * `texelFetch` 由 3.00 提供，因此要保证 three 走的是非 Raw 的 ShaderMaterial
 * 路径（本项目的 WebGLRenderer 满足这一点）。
 *
 * 约定（与 `src/water/types.ts` 一致）：
 * - 纹理 `uv = ((i + 0.5) / N, (j + 0.5) / N)`，i 向东、j 向北，v=0 在南；
 * - 状态纹理：R = 水深 m，G = 东向速度 m/s，B = 北向速度 m/s，
 *   A = 相对 baseElevation 的地形高程 m；
 * - 通量纹理：R/G/B/A = 向西/东/北/南四个方向的出流体积流率 m³/s；
 * - 模拟域边界为**开放吸收边界**：域外视为同地形、水深 0 的虚拟格，
 *   水一旦流到边界就向域外排出并被吸收，不会像墙那样在边缘堆积或反射。
 */

/** 全屏三角顶点着色器：顶点坐标即裁剪空间坐标，不需要相机矩阵。 */
export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/** 初始化 / 重置：把地形高程写进 A，水深与速度清零。 */
export const INIT_FRAGMENT = /* glsl */ `
uniform sampler2D uTerrain;

varying vec2 vUv;

void main() {
  float terrainRel = texture2D(uTerrain, vUv).r;
  gl_FragColor = vec4(0.0, 0.0, 0.0, terrainRel);
}
`

/**
 * Pass A：计算四个方向的出流（虚拟管道模型）。
 *
 * 水面高程 eta = 地形 + 水深；相邻水面更低时才产生出流，虚拟流速取
 * Torricelli 速度 sqrt(2 g dh)（受最大流速与显式扩散稳定性上限约束），
 * 体积流率 q = depth * cellWidth * v。最后按可用水量整体缩放，保证
 * 下一 pass 里水深不会变成负数。
 */
export const FLUX_FRAGMENT = /* glsl */ `
uniform sampler2D uState;
uniform float uResolution;
uniform float uCellWidth;
uniform float uDt;
uniform float uGravity;
uniform float uMaxFlowSpeed;
uniform float uDamping;

varying vec2 vUv;

float surfaceEta(vec4 state) {
  return state.a + max(state.r, 0.0);
}

void main() {
  int res = int(uResolution);
  ivec2 hi = ivec2(res - 1);
  ivec2 p = clamp(ivec2(floor(vUv * uResolution)), ivec2(0), hi);
  vec4 state = texelFetch(uState, p, 0);
  float depth = max(state.r, 0.0);
  float eta = surfaceEta(state);

  float outL = 0.0;
  float outR = 0.0;
  float outT = 0.0;
  float outB = 0.0;

  if (depth > 1e-5) {
    // 开放（吸收）边界：域外虚拟格的水深为 0、地形与当前格相同，
    // 即域外水面高程 = 当前格地形高程。边界格因此只出不进：到达边界的水
    // 会向外流出并被吸收，而不是像墙一样在边缘堆积、反射回域内。
    float etaOutside = state.a;
    float etaL = p.x > 0 ? surfaceEta(texelFetch(uState, p + ivec2(-1, 0), 0)) : etaOutside;
    float etaR = p.x < hi.x ? surfaceEta(texelFetch(uState, p + ivec2(1, 0), 0)) : etaOutside;
    float etaT = p.y < hi.y ? surfaceEta(texelFetch(uState, p + ivec2(0, 1), 0)) : etaOutside;
    float etaB = p.y > 0 ? surfaceEta(texelFetch(uState, p + ivec2(0, -1), 0)) : etaOutside;

    // 显式扩散稳定性上限：depth * v * dt / cellWidth^2 <= 0.2，
    // 深水 + 大水位差时自动放慢，避免数值振荡。
    float stabilitySpeed = 0.2 * uCellWidth * uCellWidth / max(depth * uDt, 1e-9);
    float speedLimit = min(uMaxFlowSpeed, stabilitySpeed);
    float crossSection = depth * uCellWidth * uDamping;

    float headL = eta - etaL;
    if (headL > 1e-6) {
      outL = crossSection * min(sqrt(2.0 * uGravity * headL), speedLimit);
    }
    float headR = eta - etaR;
    if (headR > 1e-6) {
      outR = crossSection * min(sqrt(2.0 * uGravity * headR), speedLimit);
    }
    float headT = eta - etaT;
    if (headT > 1e-6) {
      outT = crossSection * min(sqrt(2.0 * uGravity * headT), speedLimit);
    }
    float headB = eta - etaB;
    if (headB > 1e-6) {
      outB = crossSection * min(sqrt(2.0 * uGravity * headB), speedLimit);
    }
  }

  // 整体缩放四个出流，保证 depth * dt 内流出的体积不超过当前水量。
  float sumOut = outL + outR + outT + outB;
  if (sumOut > 1e-9) {
    float available = depth * uCellWidth * uCellWidth;
    float scale = min(1.0, available / (sumOut * uDt));
    outL *= scale;
    outR *= scale;
    outT *= scale;
    outB *= scale;
  }

  gl_FragColor = vec4(outL, outR, outT, outB);
}
`

/**
 * Pass B：水深 / 速度更新 + 注水 + 全局水位上限。
 *
 * 入流来自四个邻居通量纹理中朝向本格的通道；速度由净通量换算成 m/s。
 */
export const DEPTH_FRAGMENT = /* glsl */ `
#define MAX_SOURCES 8

uniform sampler2D uState;
uniform sampler2D uFlux;
uniform float uResolution;
uniform float uCellWidth;
uniform float uDt;
uniform float uDomainSize;
uniform float uInject;
uniform int uSourceCount;
uniform vec4 uSources[MAX_SOURCES];
uniform vec4 uTargets[MAX_SOURCES];
uniform float uFallbackAmount;
uniform float uHasCap;
uniform float uCapRel;
uniform float uMaxDepth;

varying vec2 vUv;

void main() {
  int res = int(uResolution);
  ivec2 hi = ivec2(res - 1);
  ivec2 p = clamp(ivec2(floor(vUv * uResolution)), ivec2(0), hi);

  vec4 state = texelFetch(uState, p, 0);
  vec4 flux = texelFetch(uFlux, p, 0);
  float depth = max(state.r, 0.0);
  float terrainRel = state.a;
  float cellArea = uCellWidth * uCellWidth;
  float sumOut = flux.r + flux.g + flux.b + flux.a;

  // 邻居朝本格的出流：西邻居向东 = G，东邻居向西 = R，南邻居向北 = B，北邻居向南 = A。
  // 域外没有入流（边界为开放吸收边界），因此边界方向按 0 累加。
  float inWest = 0.0;
  if (p.x > 0) inWest = texelFetch(uFlux, ivec2(p.x - 1, p.y), 0).g;
  float inEast = 0.0;
  if (p.x < hi.x) inEast = texelFetch(uFlux, ivec2(p.x + 1, p.y), 0).r;
  float inSouth = 0.0;
  if (p.y > 0) inSouth = texelFetch(uFlux, ivec2(p.x, p.y - 1), 0).b;
  float inNorth = 0.0;
  if (p.y < hi.y) inNorth = texelFetch(uFlux, ivec2(p.x, p.y + 1), 0).a;

  float newDepth = depth + (inWest + inEast + inSouth + inNorth - sumOut) * uDt / cellArea;

  // 注水：由 CPU 按模拟时间触发；半径内余弦衰减；有目标水位时只补到该水位。
  if (uInject > 0.5 && uSourceCount > 0) {
    vec2 position = (vUv - 0.5) * uDomainSize;
    for (int i = 0; i < MAX_SOURCES; i++) {
      if (i >= uSourceCount) break;
      vec4 source = uSources[i];
      if (source.z <= 0.0) continue;
      float distanceToSource = length(position - source.xy);
      if (distanceToSource >= source.z) continue;
      float falloff = 0.5 + 0.5 * cos(3.141592653589793 * clamp(distanceToSource / source.z, 0.0, 1.0));
      float amount = source.w > 0.0 ? source.w : uFallbackAmount;
      float add = amount * falloff;
      vec4 target = uTargets[i];
      // target.y = 1：目标绝对水位；target.y = 2：无目标水位时的本地压力水头
      // （水源处地形 + 每次注水量），只限制注水深度，不参与全局水位上限。
      if (target.y > 0.5) {
        add = min(add, max(0.0, target.x - (terrainRel + newDepth)));
      }
      newDepth += add;
    }
  }

  newDepth = max(newDepth, 0.0);

  // 全局水位上限：存在启用的无目标水位水源时由 CPU 端关掉该上限。
  if (uHasCap > 0.5) {
    newDepth = min(newDepth, max(0.0, uCapRel - terrainRel));
  }
  newDepth = min(newDepth, uMaxDepth);

  vec2 velocity = vec2(0.0);
  if (newDepth > 1e-4) {
    velocity.x = (inWest - flux.g) / (uCellWidth * newDepth);
    velocity.y = (inSouth - flux.b) / (uCellWidth * newDepth);
  }
  float speed = length(velocity);
  if (speed > 30.0) velocity *= 30.0 / speed;

  gl_FragColor = vec4(newDepth, velocity.x, velocity.y, terrainRel);
}
`

/**
 * 统计降采样：每 4x4 个模拟格输出 (湿格数, 最大水深)。
 * debugStats 只读回这张小纹理，避免 384 分辨率下整张 RGBA32F 读回超过 5ms。
 */
export const STATS_FRAGMENT = /* glsl */ `
uniform sampler2D uState;
uniform float uResolution;
uniform float uOutSize;
uniform int uBlock;

varying vec2 vUv;

void main() {
  ivec2 res = ivec2(int(uResolution));
  ivec2 base = ivec2(floor(vUv * uOutSize)) * uBlock;
  float wet = 0.0;
  float maxDepth = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      ivec2 p = base + ivec2(x, y);
      if (p.x >= res.x || p.y >= res.y) continue;
      float depth = texelFetch(uState, p, 0).r;
      // NaN 不满足 > 阈值，会被跳过
      if (!(depth > 1e-3)) continue;
      wet += 1.0;
      if (depth > maxDepth) maxDepth = depth;
    }
  }
  gl_FragColor = vec4(wet, maxDepth, 0.0, 0.0);
}
`
