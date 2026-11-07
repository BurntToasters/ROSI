const fs = require("fs");
const path = require("node:path");

/**
 * Loads renderer ES modules into a jsdom window. Each file runs as CommonJS
 * in the window, with a resolver for its relative imports. Bare specifiers
 * (the Tauri API packages) resolve to the `externals` map.
 */
function createRendererLoader(w, root, ts, externals = {}) {
  const loaded = new Map();
  const srcDir = path.join(root, "src");
  function load(p) {
    const file = path.resolve(srcDir, p.endsWith(".ts") ? p : `${p}.ts`);
    if (loaded.has(file)) return loaded.get(file).exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
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
          throw new Error(`renderer loader has no module for ${spec}`);
        }
        return load(path.relative(srcDir, path.resolve(path.dirname(file), spec)));
      },
      module,
    );
    return module.exports;
  }
  return load;
}

module.exports = { createRendererLoader };
