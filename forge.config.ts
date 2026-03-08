import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import path from "node:path";

const config: ForgeConfig = {
  packagerConfig: {
    name: "Image Pipeline",
    executableName: "image-pipeline",
    appBundleId: "com.imagepipeline.desktop",
    asar: true,
    // Include extra resources alongside the asar
    extraResource: [
      path.resolve("public/image-pipeline-nodes"),
      path.resolve("public/models"),
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
      const { execSync } = await import("node:child_process");
      console.log("Building Vite app...");
      execSync("npx vite build", { stdio: "inherit" });
    },
  },
};

export default config;
