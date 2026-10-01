/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ROSI_E2E: string;
  readonly VITE_ROSI_CHANNEL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
