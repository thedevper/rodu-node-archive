// Builds the standalone `shoal` binaries (Node single executable applications) and the files
// that install them: archives, SHA256SUMS, a Homebrew formula and a Scoop manifest.
//
//   pnpm build:binaries [--targets darwin-arm64,darwin-x64,windows-x64]
//
// Every target is built from this machine with the official Node release for that platform,
// downloaded once and checked against nodejs.org's SHASUMS256.txt. macOS binaries must be
// signed (ad hoc) to run on Apple silicon, so darwin targets need a Mac to build.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { VERSION } from "../apps/cli/src/version.ts";

const NODE_VERSION = "v26.11.0";
const REPO = "TheDevper/shoal";
const ROOT = resolve(import.meta.dirname, "..");
const WEB_DIST = join(ROOT, "apps/web/dist");
const OUT = join(ROOT, "dist/release");
const WORK = join(ROOT, "dist/sea");
const CACHE = join(ROOT, "dist/.node-cache", NODE_VERSION);
/** Licences a bundled dependency may have without a closer look. */
const ALLOWED_LICENSES = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
]);
/** Shipped next to the binary in every archive. */
const NOTICES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.txt"];

interface Target {
  name: string;
  /** nodejs.org platform name (node-vX-<node>.tar.gz / .zip). */
  node: string;
  archive: "tar.gz" | "zip";
  exe: string;
}

const TARGETS: Record<string, Target> = {
  "darwin-arm64": { name: "darwin-arm64", node: "darwin-arm64", archive: "tar.gz", exe: "shoal" },
  "darwin-x64": { name: "darwin-x64", node: "darwin-x64", archive: "tar.gz", exe: "shoal" },
  "windows-x64": { name: "windows-x64", node: "win-x64", archive: "zip", exe: "shoal.exe" },
  "linux-x64": { name: "linux-x64", node: "linux-x64", archive: "tar.gz", exe: "shoal" },
};
const DEFAULT_TARGETS = ["darwin-arm64", "darwin-x64", "windows-x64"];

const HOST = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sh(cmd: string, args: string[], cwd = ROOT): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/**
 * The node binary for a nodejs.org platform name, downloaded and verified on first use, with
 * Node's LICENSE next to its folder.
 */
async function nodeBinary(platform: string): Promise<string> {
  const windows = platform.startsWith("win");
  const base = `node-${NODE_VERSION}-${platform}`;
  const binary = join(CACHE, base, windows ? "node.exe" : "bin/node");
  if (existsSync(binary) && existsSync(join(CACHE, base, "LICENSE"))) return binary;
  mkdirSync(CACHE, { recursive: true });
  const sums = join(CACHE, "SHASUMS256.txt");
  if (!existsSync(sums)) {
    await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sums);
  }
  const archive = `${base}.${windows ? "zip" : "tar.gz"}`;
  const expected = readFileSync(sums, "utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(" ")[0];
  if (!expected) throw new Error(`${archive} is not in SHASUMS256.txt`);
  const file = join(CACHE, archive);
  console.error(`Downloading ${archive}`);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/${archive}`, file);
  const actual = sha256(file);
  if (actual !== expected) {
    rmSync(file);
    throw new Error(`${archive}: sha256 ${actual}, expected ${expected}`);
  }
  const members = [windows ? `${base}/node.exe` : `${base}/bin/node`, `${base}/LICENSE`];
  if (windows && process.platform === "linux")
    sh("unzip", ["-q", "-o", file, ...members, "-d", CACHE]);
  else sh("tar", ["-xf", file, "-C", CACHE, ...members]);
  rmSync(file);
  return binary;
}

/**
 * Copies node.exe without its Authenticode signature. Building the application changes the
 * file, so the signature would no longer match, and Windows treats a broken signature worse
 * than none.
 */
function unsignedCopy(exe: string, to: string): string {
  const b = readFileSync(exe);
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) throw new Error(`${exe} is not a PE file`);
  const optional = pe + 24;
  const dirs = optional + (b.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const certEntry = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  const offset = b.readUInt32LE(certEntry);
  const size = b.readUInt32LE(certEntry + 4);
  if (offset !== 0 && offset + size !== b.length) {
    throw new Error(`${exe}: the signature is not at the end of the file`);
  }
  b.writeUInt32LE(0, certEntry);
  b.writeUInt32LE(0, certEntry + 4);
  writeFileSync(to, offset === 0 ? b : b.subarray(0, offset));
  return to;
}

function webAssets(): Record<string, string> {
  if (!existsSync(join(WEB_DIST, "index.html"))) {
    throw new Error("apps/web/dist is missing: run pnpm build:web first");
  }
  const assets: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else assets[`web/${relative(WEB_DIST, path).split("\\").join("/")}`] = path;
    }
  };
  walk(WEB_DIST);
  return assets;
}

interface Dependency {
  from: string;
  version: string;
  path: string;
  dependencies?: Record<string, Dependency>;
}

/**
 * The licences of everything inside the binaries: Node.js itself and the npm packages the CLI
 * and the web board depend on in production. Their licences ask for the notice to travel with
 * every copy. Fails on a package without a licence file or with a licence not yet reviewed.
 */
function thirdPartyNotices(nodeLicense: string): string {
  const roots = JSON.parse(
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@shoal/cli",
        "--filter",
        "@shoal/web",
        "list",
        "--prod",
        "--depth",
        "Infinity",
        "--json",
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  ) as { dependencies?: Record<string, Dependency> }[];
  const packages = new Map<string, string>();
  const walk = (deps: Record<string, Dependency> | undefined) => {
    for (const dep of Object.values(deps ?? {})) {
      const key = `${dep.from}@${dep.version}`;
      // Workspace packages are Shoal's own code; their dependencies still count.
      if (dep.path.split(sep).includes("node_modules")) {
        if (packages.has(key)) continue;
        packages.set(key, dep.path);
      }
      walk(dep.dependencies);
    }
  };
  for (const root of roots) walk(root.dependencies);

  const sections = [`Node.js ${NODE_VERSION}\n\n${nodeLicense.trim()}`];
  for (const [key, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const { license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      license?: string;
    };
    if (!license || !ALLOWED_LICENSES.has(license)) {
      throw new Error(
        `${key} is licensed ${license ?? "(none stated)"}: review it before shipping`,
      );
    }
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f));
    if (files.length === 0) throw new Error(`${key} (${license}) ships no licence file`);
    const texts = files.sort().map((f) => readFileSync(join(dir, f), "utf8").trim());
    sections.push(`${key} (${license})\n\n${texts.join("\n\n")}`);
  }
  const rule = `\n\n${"-".repeat(78)}\n\n`;
  return `Shoal includes the following third-party software.${rule}${sections.join(rule)}\n`;
}

async function bundle(): Promise<string> {
  const out = join(WORK, "shoal.mjs");
  await build({
    entryPoints: [join(ROOT, "apps/cli/src/main.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    // Bundled CommonJS dependencies call require() for Node built-ins.
    banner: {
      js: 'import { createRequire as __shoalRequire } from "node:module"; const require = __shoalRequire(import.meta.url);',
    },
  });
  return out;
}

function pack(target: Target, binary: string): string {
  const name = `shoal-v${VERSION}-${target.name}.${target.archive}`;
  const file = join(OUT, name);
  rmSync(file, { force: true });
  const dir = join(WORK, target.name);
  for (const notice of NOTICES) copyFileSync(join(WORK, notice), join(dir, notice));
  const files = [target.exe, ...NOTICES];
  if (target.archive === "zip" && process.platform === "linux") {
    sh("zip", ["-q", "-j", file, binary, ...NOTICES.map((n) => join(dir, n))]);
  } else if (target.archive === "zip") {
    sh("tar", ["-a", "-cf", file, "-C", dir, ...files]);
  } else {
    sh("tar", ["-czf", file, "-C", dir, ...files]);
  }
  return name;
}

function formula(sums: Map<string, string>): string {
  const url = (t: string) =>
    `https://github.com/${REPO}/releases/download/v${VERSION}/shoal-v${VERSION}-${t}.tar.gz`;
  const arch = (t: string) =>
    sums.has(t) ? `      url "${url(t)}"\n      sha256 "${sums.get(t)}"\n` : "";
  return `class Shoal < Formula
  desc "Local-first, AI-first kanban for small teams"
  homepage "https://github.com/${REPO}"
  version "${VERSION}"
  license "Apache-2.0"

  on_macos do
    on_arm do
${arch("darwin-arm64")}    end
    on_intel do
${arch("darwin-x64")}    end
  end

  def install
    bin.install "shoal"
    prefix.install ${NOTICES.map((n) => `"${n}"`).join(", ")}
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/shoal --version")
  end
end
`;
}

function scoop(sums: Map<string, string>): string {
  const url = (v: string) =>
    `https://github.com/${REPO}/releases/download/v${v}/shoal-v${v}-windows-x64.zip`;
  const manifest = {
    version: VERSION,
    description: "Local-first, AI-first kanban for small teams",
    homepage: `https://github.com/${REPO}`,
    license: "Apache-2.0",
    architecture: { "64bit": { url: url(VERSION), hash: sums.get("windows-x64") } },
    bin: "shoal.exe",
    checkver: "github",
    autoupdate: { architecture: { "64bit": { url: url("$version") } } },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { targets: { type: "string" } } });
  const names = values.targets ? values.targets.split(",") : DEFAULT_TARGETS;
  const targets = names.map((n) => {
    const t = TARGETS[n];
    if (!t) throw new Error(`Unknown target ${n}; known: ${Object.keys(TARGETS).join(", ")}`);
    return t;
  });
  const pkg = JSON.parse(readFileSync(join(ROOT, "apps/cli/package.json"), "utf8")) as {
    version: string;
  };
  if (pkg.version !== VERSION) {
    throw new Error(`apps/cli/package.json says ${pkg.version}, version.ts says ${VERSION}`);
  }
  if (targets.some((t) => t.name.startsWith("darwin")) && process.platform !== "darwin") {
    throw new Error("macOS binaries must be signed on a Mac: build darwin targets on macOS");
  }

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const main = await bundle();
  const assets = webAssets();
  // The official build for this machine: distro and Homebrew builds may leave SEA support out.
  const builder = await nodeBinary(HOST);
  const nodeLicense = readFileSync(join(CACHE, `node-${NODE_VERSION}-${HOST}`, "LICENSE"), "utf8");
  copyFileSync(join(ROOT, "LICENSE"), join(WORK, "LICENSE"));
  copyFileSync(join(ROOT, "NOTICE"), join(WORK, "NOTICE"));
  writeFileSync(join(WORK, "THIRD-PARTY-NOTICES.txt"), thirdPartyNotices(nodeLicense));

  const sums = new Map<string, string>();
  const lines: string[] = [];
  for (const target of targets) {
    const dir = join(WORK, target.name);
    mkdirSync(dir, { recursive: true });
    let executable = await nodeBinary(target.node);
    if (target.node.startsWith("win")) {
      executable = unsignedCopy(executable, join(dir, "node-unsigned.exe"));
    }
    const output = join(dir, target.exe);
    const config = join(dir, "sea.json");
    writeFileSync(
      config,
      JSON.stringify({
        main,
        mainFormat: "module",
        output,
        executable,
        disableExperimentalSEAWarning: true,
        // A code cache only fits the platform that made it.
        useCodeCache: false,
        useSnapshot: false,
        assets,
      }),
    );
    console.error(`Building ${target.name}`);
    sh(builder, ["--build-sea", config]);
    if (target.name.startsWith("darwin")) {
      sh("codesign", ["--sign", "-", "--force", output]);
    }
    rmSync(join(dir, "node-unsigned.exe"), { force: true });
    if (target.node === HOST) {
      const reported = sh(output, ["--version"]).trim();
      if (reported !== `shoal ${VERSION}`) throw new Error(`${output} --version: ${reported}`);
    }
    const archive = pack(target, output);
    const sum = sha256(join(OUT, archive));
    sums.set(target.name, sum);
    lines.push(`${sum}  ${archive}`);
  }
  writeFileSync(join(OUT, "SHA256SUMS"), `${lines.join("\n")}\n`);
  if (sums.has("darwin-arm64") || sums.has("darwin-x64")) {
    writeFileSync(join(OUT, "shoal.rb"), formula(sums));
  }
  if (sums.has("windows-x64")) writeFileSync(join(OUT, "shoal.json"), scoop(sums));
  for (const script of ["install.sh", "install.ps1"]) {
    copyFileSync(join(ROOT, "packaging", script), join(OUT, script));
  }
  console.error(`Done: ${relative(ROOT, OUT)}\n${lines.join("\n")}`);
}

await main();
