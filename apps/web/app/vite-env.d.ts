/// <reference types="vite/client" />

// Vite-specific import suffix used by Remix for CSS module URLs.
// Without this ambient declaration, the lint tsconfig (which has no
// `vite/client` types since vite isn't installed at the workspace root —
// see tsconfig.eslint.json header) can't resolve imports like
// `import polarisStyles from '@shopify/polaris/build/esm/styles.css?url'`.
//
// apps/web/tsconfig.json includes `types: ["node", "vite/client"]` which
// provides this via vite at build/runtime; this file restores the
// declaration for the workspace-wide lint project.
declare module '*.css?url' {
  const url: string;
  export default url;
}
