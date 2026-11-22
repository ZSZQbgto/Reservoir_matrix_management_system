/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STATIC_HOST?: string
  /** 仅静态托管构建注入：Cesium Ion token（会出现在前端产物中）。 */
  readonly VITE_CESIUM_ION_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
