/** 体积云与大气默认值：Viewer 初始化与 MUI 环境面板共用。 */
export const CLOUD_SCENE_DEFAULTS = {
  show: false,
  quality: 'high' as const,
  coverage: 0.3,
  altitude: 9000,
  height: 800,
  speed: 1,
  lightShafts: true,
  detail: true,
  turbulence: true,
  haze: true,
  shadowQuality: 'medium' as const
}
