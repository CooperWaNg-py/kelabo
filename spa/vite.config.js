import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// onnxruntime-web's `exports` map does not expose its .wasm binaries, so no
// bare specifier can reach one and `onnxruntime-web/dist/...` fails to resolve.
// The path is derived from a subpath that IS exported rather than written out,
// so it stays pinned to whichever version npm actually installed. Copying the
// binary into the repo would be the other option and is worse: it would drift
// from the runtime that loads it, and the symptom of that is a wasm link error
// nobody can place.
const require = createRequire(import.meta.url)
const ortDist = dirname(require.resolve('onnxruntime-web/wasm'))
// TWO files, not one. The runtime loads the binary through a small generated
// JavaScript module that sits beside it, and it resolves the two independently:
// give it only the `.wasm` and it falls back to a default location for the
// `.mjs` — which under a hashed-asset build is a URL that does not exist.
const ortAssets = {
  wasm: join(ortDist, 'ort-wasm-simd-threaded.wasm'),
  mjs: join(ortDist, 'ort-wasm-simd-threaded.mjs'),
}
for (const [k, f] of Object.entries(ortAssets)) {
  // Loudly, at config load. If onnxruntime-web renames either file in an
  // upgrade the alternative is a build that succeeds and a VAD that reports
  // only "failed" in production.
  if (!existsSync(f)) throw new Error(`vite.config: onnxruntime-web ${k} not found at ${f}`)
}

export default defineConfig({
  plugins: [react()],
  envPrefix: 'VITE_',
  // The Silero model. Vite knows .wasm is an asset and does not know .onnx, so
  // without this the `?url` import resolves to nothing and the model 404s at
  // run time — with the VAD reporting only that it failed to load.
  assetsInclude: ['**/*.onnx'],
  optimizeDeps: {
    // onnxruntime-web ships its wasm glue as separate files it locates at run
    // time. Pre-bundling rewrites the paths it uses to find them, so the dev
    // server serves a runtime that cannot load its own binary.
    exclude: ['onnxruntime-web'],
  },
  resolve: {
    // Array form, because the wasm entry has to be a regex. An alias is matched
    // against the whole specifier including its query, so a plain string key
    // never matches `@kelabo/ort-wasm?url` — and the failure is a build error
    // about an unresolved import, not a hint that the alias was ignored.
    alias: [
      // The variant seam: an overlay build re-points this one id to its own
      // module (see src/variant.js). Everything else resolves normally.
      {
        find: '@kelabo/variant',
        replacement: fileURLToPath(new URL('./src/variant.js', import.meta.url)),
      },
      // Deliberately unanchored, so the `?url` survives into the replacement
      // and Vite's asset pipeline still sees it. The mjs rule must come first:
      // an unanchored `@kelabo/ort-wasm` also matches `@kelabo/ort-wasm-mjs`,
      // and the first match wins.
      { find: /^@kelabo\/ort-wasm-mjs/, replacement: ortAssets.mjs },
      { find: /^@kelabo\/ort-wasm/, replacement: ortAssets.wasm },
    ],
  },
})
