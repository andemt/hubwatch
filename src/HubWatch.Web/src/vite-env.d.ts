/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" in the demo build (pnpm build:demo): the UI runs against a pretend server in the browser. */
  readonly VITE_DEMO?: string
}
