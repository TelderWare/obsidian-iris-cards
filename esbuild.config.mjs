import esbuild from "esbuild";
import process from "process";
import builtins from "module";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtins.builtinModules.map((m) => m),
    ...builtins.builtinModules.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  platform: "node",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
