import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const version = String(process.argv[2] || "").trim()
const platformTag = String(process.argv[3] || "server-rk3588-linux-arm64").trim()

if (!version) {
  throw new Error("Usage: node scripts/package-server-deploy-bundle.mjs <version> [platform-tag]")
}

const sourceDir = path.join(rootDir, "server-deploy")
if (!existsSync(sourceDir)) {
  throw new Error(`server-deploy directory not found: ${sourceDir}`)
}

const distDir = path.join(rootDir, "dist-server")
const bundleName = `Codex-Gateway-${platformTag}-${version}`
const bundleDir = path.join(distDir, bundleName)

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: false,
      ...options,
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`))
    })
  })
}

async function syncDerivedSources() {
  console.log("[bundle-server] syncing derived source copies")
  await run("node", ["scripts/sync-derived-copies.mjs", "--write"])
}

await syncDerivedSources()
await rm(bundleDir, { recursive: true, force: true })
await mkdir(bundleDir, { recursive: true })
await mkdir(distDir, { recursive: true })

await cp(sourceDir, bundleDir, {
  recursive: true,
  filter(source) {
    const normalized = source.replace(/\\/g, "/")
    if (normalized.endsWith("/node_modules")) return false
    if (normalized.includes("/node_modules/")) return false
    if (normalized.endsWith("/data")) return false
    if (normalized.includes("/data/")) return false
    if (normalized.endsWith("/.git")) return false
    if (normalized.includes("/.git/")) return false
    return true
  },
})

const installGuide = `# RK3588 Quick Install

1. Extract this tarball on the board, for example:
   tar -xzf ${bundleName}.tar.gz
2. Enter the folder:
   cd ${bundleName}
3. Run the bootstrap script:
   chmod +x scripts/install-rk3588.sh start.sh
   ./scripts/install-rk3588.sh
4. Edit .env before exposing the service publicly.

This bundle is intended for Debian 11 / Ubuntu arm64 boards such as RK3588.
`

await writeFile(path.join(bundleDir, "RK3588_INSTALL.md"), installGuide, "utf8")

const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"))
const metadata = {
  bundleName,
  version,
  source: "server-deploy",
  platformTag,
  createdAt: new Date().toISOString(),
}
await writeFile(path.join(bundleDir, "bundle-metadata.json"), JSON.stringify(metadata, null, 2), "utf8")

console.log(bundleDir)
