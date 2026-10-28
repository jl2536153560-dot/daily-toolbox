import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "dist");
const watch = process.argv.includes("--watch");

async function copyPublic() {
  await mkdir(outdir, { recursive: true });
  await cp(resolve(root, "public"), outdir, {
    recursive: true,
    force: true
  });
}

function withDistPrefix(path) {
  return path.startsWith("dist/") ? path : `dist/${path}`;
}

async function writeRootManifest() {
  const source = JSON.parse(
    await readFile(resolve(root, "public/manifest.json"), "utf8")
  );
  if (source.background?.service_worker) {
    source.background.service_worker = withDistPrefix(
      source.background.service_worker
    );
  }
  for (const script of source.content_scripts ?? []) {
    script.js = (script.js ?? []).map(withDistPrefix);
    script.css = (script.css ?? []).map(withDistPrefix);
  }
  for (const icons of [source.icons, source.action?.default_icon]) {
    if (icons && typeof icons === "object") {
      for (const size of Object.keys(icons)) icons[size] = withDistPrefix(icons[size]);
    }
  }
  await writeFile(
    resolve(root, "manifest.json"),
    `${JSON.stringify(source, null, 2)}\n`,
    "utf8"
  );
}

const shared = {
  bundle: true,
  loader: {
    ".svg": "text"
  },
  sourcemap: false,
  target: "chrome120",
  logLevel: "info"
};

const builds = [
  {
    ...shared,
    entryPoints: [resolve(root, "src/background/service-worker.ts")],
    outfile: resolve(outdir, "background.js"),
    format: "esm"
  },
  {
    ...shared,
    entryPoints: [resolve(root, "src/content/index.ts")],
    outfile: resolve(outdir, "content.js"),
    format: "iife"
  }
];

if (watch) {
  await rm(outdir, { recursive: true, force: true });
  await copyPublic();
  await writeRootManifest();
  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((item) => item.watch()));
  console.log("正在监听文件变化，构建目录：dist");
} else {
  await rm(outdir, { recursive: true, force: true });
  await copyPublic();
  await writeRootManifest();
  await Promise.all(builds.map((options) => build(options)));
  console.log("构建完成：dist");
}
