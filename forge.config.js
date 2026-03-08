const path = require("path");
const { MakerDMG } = require("@electron-forge/maker-dmg");
const { MakerSquirrel } = require("@electron-forge/maker-squirrel");
const { MakerZIP } = require("@electron-forge/maker-zip");
const { MakerDeb } = require("@electron-forge/maker-deb");

/** @type {import("@electron-forge/shared-types").ForgeConfig} */
module.exports = {
  packagerConfig: {
    name: "Image Pipeline",
    executableName: "image-pipeline",
    appBundleId: "com.imagepipeline.desktop",
    asar: true,
    // Include extra resources alongside the asar.
    // extraResource copies items into Resources/ using their basename,
    // so we include the whole python-backend folder to preserve the
    // python-backend/src/server.py path that python-process.ts expects.
    extraResource: [
      // Node definition JSON files
      path.resolve("public/image-pipeline-nodes"),
      // ONNX models
      path.resolve("public/models"),
      // Python backend (src/ + requirements.txt, spawned as subprocess)
      path.resolve("python-backend"),
    ],
    // Ignore dev files from the package
    ignore: [
      /^\/\.claude/,
      /^\/\.git/,
      /^\/node_modules\/\.cache/,
      /^\/python-backend\/venv/,
      /^\/release/,
      /^\/src/,
      /^\/electron/,
      /^\/public/,
      /forge\.config/,
      /electron-builder/,
      /tsconfig/,
      /vite\.config/,
      /PACKAGING/,
    ],
  },
  makers: [
    new MakerDMG({
      format: "ULFO",
    }),
    new MakerSquirrel({
      name: "ImagePipeline",
    }),
    new MakerZIP({}, ["darwin", "linux"]),
    new MakerDeb({
      options: {
        maintainer: "Image Pipeline",
        homepage: "https://github.com/imagepipeline",
        categories: ["Development"],
      },
    }),
  ],
  hooks: {
    // Build Vite + Electron before packaging
    generateAssets: async () => {
      const { execSync } = require("child_process");
      console.log("Building Vite app...");
      execSync("npx vite build", { stdio: "inherit" });
    },
    // Clean up python venv and __pycache__ from the packaged output
    postPackage: async (_config, result) => {
      const fs = require("fs/promises");
      const resourcesDir = path.join(result.outputPaths[0], "Image Pipeline.app", "Contents", "Resources");
      const venvDir = path.join(resourcesDir, "python-backend", "venv");
      await fs.rm(venvDir, { recursive: true, force: true }).catch(() => {});
      // Remove __pycache__ dirs
      const { execSync } = require("child_process");
      const pyDir = path.join(resourcesDir, "python-backend");
      execSync(`find "${pyDir}" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true`);
    },
  },
};
