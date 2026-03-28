import { mkdir, readdir, rm, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverDir = path.join(rootDir, "build", "server")
const platformAliases = {
  win: "win32",
  windows: "win32",
  win32: "win32",
  linux: "linux",
  darwin: "darwin",
  mac: "darwin",
  macos: "darwin",
}
const archAliases = {
  x64: "x64",
  amd64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
}
const targetPlatform = platformAliases[String(process.argv[2] || process.platform).trim().toLowerCase()]
const targetArch = archAliases[String(process.argv[3] || process.arch).trim().toLowerCase()]

if (!targetPlatform) {
  throw new Error(`Unsupported target platform: ${process.argv[2] || process.platform}`)
}

if (!targetArch) {
  throw new Error(`Unsupported target arch: ${process.argv[3] || process.arch}`)
}

const supportedTargets = new Set(["win32:x64", "linux:x64", "linux:arm64", "darwin:x64", "darwin:arm64"])
if (!supportedTargets.has(`${targetPlatform}:${targetArch}`)) {
  throw new Error(`Unsupported Bun executable target: ${targetPlatform}/${targetArch}`)
}

const outputName = targetPlatform === "win32" ? "oauth-server.exe" : "oauth-server"
const outputPath = path.join(serverDir, outputName)
const bunCompileTarget =
  targetPlatform === "win32" ? `bun-windows-${targetArch}` : targetPlatform === "darwin" ? `bun-darwin-${targetArch}` : `bun-linux-${targetArch}`

async function captureStdout(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}\n${stderr.trim()}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

function parsePackageManagerBunVersion(packageManager) {
  const candidate = String(packageManager ?? "").trim()
  if (!candidate.startsWith("bun@")) {
    throw new Error(`packageManager must specify a bun version (got ${candidate || "empty"})`)
  }
  const [, version] = candidate.split("@")
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Unable to parse bun version from packageManager: ${candidate}`)
  }
  return version
}

async function detectBunVersion() {
  const output = await captureStdout("bun", ["--version"])
  const match = output.match(/bun\s+(\d+\.\d+\.\d+)/i)
  if (match) return match[1]
  if (output) return output.trim()
  throw new Error("Unable to determine bun version from `bun --version`")
}

async function assertBunVersionMatchesPackageManager() {
  const packageJsonPath = path.join(rootDir, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"))
  const expectedVersion = parsePackageManagerBunVersion(packageJson.packageManager)
  const actualVersion = await detectBunVersion()
  if (actualVersion !== expectedVersion) {
    const expectedMajor = expectedVersion.split(".")[0]
    const actualMajor = actualVersion.split(".")[0]
    const majorMismatch =
      expectedMajor !== actualMajor ? ` major version mismatch (expected ${expectedMajor}, got ${actualMajor}).` : ""
    throw new Error(
      `Bun version mismatch: packageManager declares ${expectedVersion} but current bun is ${actualVersion}.${majorMismatch}`.trim(),
    )
  }
  console.log(`[build-server] bun ${actualVersion} matches packageManager`)
}

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

await mkdir(serverDir, { recursive: true })
for (const entry of await readdir(serverDir, { withFileTypes: true }).catch(() => [])) {
  if (entry.isFile() && entry.name.startsWith("oauth-server")) {
    await rm(path.join(serverDir, entry.name), { force: true })
  }
}

await assertBunVersionMatchesPackageManager()
console.log(`[build-server] target ${bunCompileTarget}`)
await run("bun", ["build", "--compile", "--target", bunCompileTarget, "src/index.ts", "--outfile", outputPath])
console.log(`Built standalone server binary: ${outputPath}`)
