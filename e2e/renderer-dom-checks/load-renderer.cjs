const fs = require("fs");
const path = require("node:path");

// Vite values that src reads through import.meta.env, as a non-E2E build sees
// them. The DOM checks never run the E2E seam, so VITE_ROSI_E2E stays empty.
const VITE_ENV = { VITE_ROSI_E2E: "", VITE_ROSI_CHANNEL: "" };

/**
 * Replaces import.meta.env.KEY with its VITE_ENV value. The transpiler leaves
 * import.meta in place, and CommonJS cannot evaluate it, so any other form
 * (an unknown KEY, bracket access, or a bare import.meta) throws here.
 */
function inlineViteEnv(source, file) {
  const inlined = source.replace(
    /\bimport\.meta\.env\.([A-Za-z_]\w*)/g,
    (match, key) => {
      if (!Object.hasOwn(VITE_ENV, key)) {
        throw new Error(
          `renderer loader: ${file} reads import.meta.env.${key}, which is not in VITE_ENV`,
        );
      }
      return JSON.stringify(VITE_ENV[key]);
    },
  );
  if (/\bimport\.meta\b/.test(inlined)) {
    throw new Error(
      `renderer loader: ${file} has an import.meta form the loader does not handle`,
    );
  }
  return inlined;
}

/**
 * Loads renderer ES modules into a jsdom window. Each file runs as CommonJS
 * in the window, with a resolver for its relative imports. Bare specifiers
 * (the Tauri API packages) resolve to the `externals` map.
 */
// `provided` maps src paths to ready exports, so those files are never
// transpiled (the API module imports Tauri packages the loader does not know).
function createRendererLoader(w, root, ts, externals = {}, provided = {}) {
  const loaded = new Map();
  const srcDir = path.join(root, "src");
  for (const [rel, exports] of Object.entries(provided)) {
    loaded.set(path.resolve(srcDir, rel), { exports });
  }
  function load(p) {
    const file = path.resolve(srcDir, p.endsWith(".ts") ? p : `${p}.ts`);
    if (loaded.has(file)) return loaded.get(file).exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const source = inlineViteEnv(fs.readFileSync(file, "utf8"), file);
    const code = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
    const run = w.eval(`(function (exports, require, module) {${code}\n})`);
    run(
      module.exports,
      (spec) => {
        if (!spec.startsWith(".")) {
          // Packages the renderer reaches through Tauri: supplied by the caller.
          if (Object.hasOwn(externals, spec)) return externals[spec];
          // Icon SVGs imported as text (Vite `?raw`), read from node_modules.
          if (spec.endsWith("?raw")) {
            const text = fs.readFileSync(
              path.join(root, "node_modules", spec.slice(0, -"?raw".length)),
              "utf8",
            );
            return { default: text };
          }
          throw new Error(`renderer loader has no module for ${spec}`);
        }
        return load(
          path.relative(srcDir, path.resolve(path.dirname(file), spec)),
        );
      },
      module,
    );
    return module.exports;
  }
  return load;
}

module.exports = { createRendererLoader, inlineViteEnv };
