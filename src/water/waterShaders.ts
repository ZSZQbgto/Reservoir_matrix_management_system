/**
 * 水面着色器（GLSL 3.00 / WebGL2）。
 *
 * 顶点着色器：规则切平面网格按 `stateTexture` 的 R（水深）与 A（相对 baseElevation
 * 的地形高程）沿局部 +Y 位移，水面高程 = terrainRel + depth + lift，浅水处额外下沉
 * 以让水面与 Cesium 地形自然相交。局部坐标约定：+X = 西、+Y = 上、+Z = 北。
 *
 * 片元着色器：逐像素双线性采样水深（保证岸线平滑）、邻域差分几何法线 + 两层程序化
 * 法线贴图（沿净流速平流、按屏幕导数衰减远处细节）、Schlick 菲涅尔（F0 = 0.02）、
 * 天空反射色、太阳锐利高光/宽泛光/掠射波光、Beer-Lambert 深度吸收、岸线与急流泡沫、
 * 域边界与极浅水淡出。
 *
 * 输出为 **线性 HDR 值**（AgX tone mapping 之前）。Tellux 的
 * `AerialPerspectiveEffect` 后处理光照会在其后把 scene 颜色乘以与太阳高度相关的
 * 因子 F；调色板（见 `./sun.ts`）已按参考光照补偿，所以这里直接输出即可。
 * alpha 使用普通 alpha 混合叠在 Cesium 地形影像之上。
 */

/** 顶点与片元共享的状态纹理双线性采样。 */
const STATE_SAMPLING = /* glsl */ `
uniform sampler2D uStateTexture;
uniform float uSimResolution;

// 手动双线性：模拟纹理可能使用 NearestFilter，需要连续的水深/地形。
vec4 sampleStateBilinear(vec2 stateUv) {
  vec2 pixel = stateUv * uSimResolution - 0.5;
  vec2 base = floor(pixel);
  vec2 fraction = pixel - base;
  vec2 texel = vec2(1.0 / uSimResolution);
  vec2 uv00 = (base + 0.5) * texel;
  vec4 s00 = textureLod(uStateTexture, uv00, 0.0);
  vec4 s10 = textureLod(uStateTexture, uv00 + vec2(texel.x, 0.0), 0.0);
  vec4 s01 = textureLod(uStateTexture, uv00 + vec2(0.0, texel.y), 0.0);
  vec4 s11 = textureLod(uStateTexture, uv00 + texel, 0.0);
  return mix(mix(s00, s10, fraction.x), mix(s01, s11, fraction.x), fraction.y);
}
`

export const WATER_VERTEX_SHADER = /* glsl */ `
precision highp float;

${STATE_SAMPLING}

uniform float uLift;

out vec2 vStateUv;
out vec3 vViewPosition;

void main() {
  vec2 stateUv = uv;
  vec4 state = sampleStateBilinear(stateUv);
  float depth = max(state.r, 0.0);
  float terrainRel = state.a;

  // 干网格点下沉到地面以下 ~1.4 m，让水面与地形在亚网格尺度自然相交；
  // 有水的网格点则抬升 uLift，避免与真实地形 z-fighting。
  float sink = (1.0 - smoothstep(0.0, 0.6, depth)) * 1.4;
  float surfaceRel = terrainRel + depth + uLift - sink;

  vec3 localPosition = vec3(position.x, surfaceRel, position.z);
  vStateUv = stateUv;
  vViewPosition = (modelViewMatrix * vec4(localPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * vec4(vViewPosition, 1.0);
}
`

export const WATER_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${STATE_SAMPLING}

uniform sampler2D uNormalBroad;
uniform sampler2D uNormalFine;
uniform sampler2D uFoamTexture;

uniform float uSize;
uniform float uTime;
uniform float uShimmer;
uniform float uGlint;
uniform float uReflection;
uniform float uRipple;
uniform float uRippleScale;
uniform float uFlowSpeed;
uniform float uFoam;
uniform float uClarity;
uniform float uOpacity;

uniform vec3 uSunLocal;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform float uGlintStrength;
// 局部方向 → 视图空间方向的旋转（mat3(viewMatrix * modelMatrix)），
// 由 WaterSurface 在 onBeforeRender 里更新；片元着色器拿不到 modelViewMatrix。
uniform mat3 uViewRotation;

in vec2 vStateUv;
in vec3 vViewPosition;

layout(location = 0) out vec4 waterFragColor;

float surfaceHeight(vec4 state) {
  return state.a + max(state.r, 0.0);
}

void main() {
  // 逐像素双线性水深：岸线/透明度在亚网格尺度连续，避免网格锯齿。
  vec4 centerState = sampleStateBilinear(vStateUv);
  float depth = max(centerState.r, 0.0);
  if (depth < 0.035) discard;
  vec2 flow = centerState.gb;
  float flowSpeed = length(flow);

  // 域边界淡出（最后 ~9% 边缘），避免水面被正方形域硬切。
  vec2 edgeDistance = min(vStateUv, vec2(1.0) - vStateUv);
  float edge = min(edgeDistance.x, edgeDistance.y);
  float edgeFade = smoothstep(0.0, 0.09, edge);

  // ---- 几何法线：由水深/水面高程的邻域差分得到（含水下地形起伏） ----
  vec2 texel = vec2(1.0 / uSimResolution);
  vec4 stateWest = textureLod(uStateTexture, vStateUv - vec2(texel.x, 0.0), 0.0);
  vec4 stateEast = textureLod(uStateTexture, vStateUv + vec2(texel.x, 0.0), 0.0);
  vec4 stateSouth = textureLod(uStateTexture, vStateUv - vec2(0.0, texel.y), 0.0);
  vec4 stateNorth = textureLod(uStateTexture, vStateUv + vec2(0.0, texel.y), 0.0);
  // 十字邻域均值轻微平滑水深：模拟网格（8 m 级）的台阶在岸线上会被抹平。
  depth = (depth * 2.0 + stateWest.r + stateEast.r + stateSouth.r + stateNorth.r) / 6.0;
  depth = max(depth, 0.0);
  float hWest = surfaceHeight(stateWest);
  float hEast = surfaceHeight(stateEast);
  float hSouth = surfaceHeight(stateSouth);
  float hNorth = surfaceHeight(stateNorth);
  float cell = uSize * texel.x;
  float slopeEast = (hEast - hWest) / (2.0 * cell);
  float slopeNorth = (hNorth - hSouth) / (2.0 * cell);
  // 局部法线：+X = 西、+Y = 上、+Z = 北。
  vec3 normalLocal = normalize(vec3(slopeEast, 1.0, -slopeNorth));

  // ---- 两层程序化法线贴图：沿净流速平流，不同尺度/方向 ----
  // uRippleScale 放大/缩小纹理频率（越大波纹越细），uFlowSpeed 控制平流快慢。
  float rippleScale = clamp(uRippleScale, 0.4, 2.5);
  float advectSpeed = clamp(uFlowSpeed, 0.0, 2.0);
  float broadWorld = 320.0;
  float fineWorld = 76.0;
  vec2 broadUv =
    vStateUv * (uSize / broadWorld) * rippleScale + flow * (uTime * advectSpeed / broadWorld);
  vec2 fineUv =
    vStateUv * (uSize / fineWorld) * rippleScale + flow * (uTime * advectSpeed * 1.45 / fineWorld);
  // 细波纹层旋转约 28°，避免两层纹理方向完全一致。
  mat2 fineRotation = mat2(0.8829, -0.4695, 0.4695, 0.8829);
  fineUv = fineRotation * fineUv;

  vec2 broadNormal = texture(uNormalBroad, broadUv).xy * 2.0 - 1.0;
  vec2 fineNormal = texture(uNormalFine, fineUv).xy * 2.0 - 1.0;

  // 屏幕导数衰减：一个像素覆盖的水面尺度变大时淡出细节，避免远处闪烁。
  float footprint = max(fwidth(vStateUv.x), fwidth(vStateUv.y)) * uSize;
  float detailFade = 1.0 - smoothstep(1.2, 8.0, footprint);
  float detailStrength = clamp(uRipple, 0.0, 2.0) * detailFade;
  // 水体内部相对平静，湍流处（流速大）波纹更碎。
  float roughWater = 1.0 + smoothstep(0.4, 2.5, flowSpeed) * 0.8;
  vec2 detail =
    broadNormal * (0.62 * detailStrength) + fineNormal * (0.48 * detailStrength * roughWater);
  // 纹理法线 x = -dh/du（u 东向）→ 局部 -X（东负方向）与 +Z 的扰动。
  normalLocal = normalize(vec3(normalLocal.x - detail.x, normalLocal.y, normalLocal.z + detail.y));

  // ---- 视图空间基向量 ----
  mat3 viewRotation = uViewRotation;
  vec3 normalView = normalize(viewRotation * normalLocal);
  vec3 viewDir = normalize(-vViewPosition);
  vec3 sunView = normalize(viewRotation * uSunLocal);

  // ---- Schlick 菲涅尔，F0 = 0.02 ----
  float NdotV = clamp(dot(normalView, viewDir), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  // 天空反射色：反射方向越竖直越接近天顶色，越掠射越接近地平线色。
  vec3 reflectView = reflect(-viewDir, normalView);
  vec3 upView = viewRotation * vec3(0.0, 1.0, 0.0);
  float reflectUp = clamp(dot(reflectView, upView), 0.0, 1.0);
  vec3 skyReflection = mix(uSkyHorizon, uSkyZenith, smoothstep(0.12, 0.82, reflectUp));

  // ---- Beer-Lambert 深度吸收：浅水透出地形、深水趋暗且不透明 ----
  float clarity = clamp(uClarity, 0.0, 1.0);
  float absorption = mix(1.7, 0.10, clarity);
  float depthFactor = 1.0 - exp(-absorption * depth);
  vec3 bodyColor = mix(uShallowColor, uDeepColor, depthFactor);
  float reflectionStrength = clamp(uReflection, 0.0, 1.5);
  float waterAlpha = mix(0.15, 0.62 + 0.28 * clarity, depthFactor);
  waterAlpha = clamp(waterAlpha + fresnel * 0.6 * reflectionStrength, 0.0, 0.95);

  vec3 color = mix(bodyColor, skyReflection, clamp(fresnel * reflectionStrength, 0.0, 1.0));

  // ---- 太阳高光：锐利镜面 + 宽泛光 + 掠射细碎波光 ----
  vec3 halfVector = normalize(sunView + viewDir);
  float NdotH = clamp(dot(normalView, halfVector), 0.0, 1.0);
  float NdotL = clamp(dot(normalView, sunView), 0.0, 1.0);
  float sunAbove = smoothstep(-0.06, 0.05, uSunLocal.y);
  float shimmer = clamp(uShimmer, 0.0, 3.0);
  // 高光锐度：指数越大反射越集中。1.0 为基准，0.3 更柔和、2.5 更锐利。
  float glint = clamp(uGlint, 0.3, 2.5);
  float sharp = pow(NdotH, 600.0 * glint) * 3.2;
  float broad = pow(NdotH, 56.0) * 0.035;
  float sparkleNoise = texture(uNormalFine, fineUv * 2.7 + vec2(uTime * 0.012)).x;
  float sparkle = pow(NdotH, 160.0 * glint) * (0.10 + 0.9 * sparkleNoise);
  vec3 specular =
    uSunColor * sunAbove * shimmer * uGlintStrength * (sharp + broad + sparkle) * (0.35 + 0.65 * NdotL);
  color += specular;

  // ---- 泡沫：岸线细碎泡沫 + 急流白浪，用程序化噪声打散避免整片死白 ----
  // 急流噪声沿流向拉伸，白浪呈条带状而不是圆点阵。
  vec2 flowDir = flowSpeed > 1e-4 ? flow / flowSpeed : vec2(0.0, 1.0);
  vec2 flowPerp = vec2(-flowDir.y, flowDir.x);
  vec2 uvMeters = vStateUv * uSize;
  vec2 streakUv =
    vec2(dot(uvMeters, flowPerp) / 38.0, dot(uvMeters, flowDir) / 260.0) - vec2(0.0, uTime * 0.05);
  float streakNoise = texture(uFoamTexture, streakUv).r;
  float patchNoise =
    texture(uFoamTexture, vStateUv * (uSize / 130.0) + flow * (uTime / 170.0)).r;
  float shoreNoise =
    texture(uFoamTexture, vStateUv * (uSize / 24.0) - flow * (uTime / 18.0)).g;

  // 岸线泡沫：只在极浅水处出现，用噪声切成细碎泡沫带。
  float shoreBand = smoothstep(0.6, 0.05, depth) * smoothstep(0.03, 0.13, depth);
  float shoreFoam =
    shoreBand * smoothstep(0.46, 0.74, shoreNoise * 0.62 + patchNoise * 0.48 + 0.08);

  // 急流白浪：速度阈值较高、噪声阈值较高，只留稀疏的白色浪花。
  float rapidBand = smoothstep(2.2, 4.0, flowSpeed) * smoothstep(0.05, 0.35, depth);
  float rapidFoam =
    rapidBand * smoothstep(0.52, 0.8, patchNoise * 0.55 + streakNoise * 0.55);

  float foamStrength = clamp(uFoam, 0.0, 2.0);
  float foam = clamp(shoreFoam * 0.62 + rapidFoam * 0.55, 0.0, 0.7) * edgeFade;
  foam = clamp(foam * foamStrength, 0.0, 0.92);
  color = mix(color, uFoamColor, foam);

  // ---- 极浅水 / 域边界 alpha 淡出 ----
  float depthFade = smoothstep(0.035, 0.3, depth);
  waterAlpha *= depthFade * edgeFade;
  float alpha = max(waterAlpha, foam * 0.75 * edgeFade);

  // ---- 透明 / 不透明 ----
  // uOpacity = 0 时完全沿用清澈度、水深、菲涅尔与泡沫决定的透明混合；
  // = 1 时深水直接到不透明 alpha，1 之间线性过渡；浅水与域边界始终保留淡出。
  float opacity = clamp(uOpacity, 0.0, 1.0);
  float opaqueAlpha = max(depthFade * edgeFade, foam * 0.75 * edgeFade);
  alpha = mix(alpha, max(alpha, opaqueAlpha), opacity);
  if (alpha < 0.004) discard;

  waterFragColor = vec4(color, clamp(alpha, 0.0, mix(0.95, 1.0, opacity)));
}
`
