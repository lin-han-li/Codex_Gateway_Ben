import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { existsSync, readdirSync, rmSync } from "node:fs"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = String(process.argv[2] || "").trim().toLowerCase()
const arch = String(process.argv[3] || "").trim().toLowerCase()

const targetConfig = {
  win: {
    hostPlatform: "win32",
    label: "Windows",
    args: ["--win", "nsis", "--publish", "never", "--config.win.signAndEditExecutable=false"],
    supportedArchs: ["x64", "ia32", "arm64"],
  },
  linux: {
    hostPlatform: "linux",
    label: "Linux",
    args: ["--linux", "AppImage", "deb", "tar.gz", "--publish", "never"],
    supportedArchs: ["x64", "arm64", "armv7l"],
  },
  mac: {
    hostPlatform: "darwin",
    label: "macOS",
    args: ["--mac", "dmg", "zip", "--publish", "never"],
    supportedArchs: ["x64", "arm64", "universal"],
  },
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

if (!targetConfig[target]) {
  throw new Error(`Unknown desktop build target: ${target || "<empty>"}. Use win, linux, or mac.`)
}

const config = targetConfig[target]
if (process.platform !== config.hostPlatform) {
  throw new Error(
    `${config.label} installer builds must run on ${config.label}. Current host is ${process.platform}. ` +
      `This project bundles a native standalone server binary, so cross-building from a different OS is intentionally blocked.`,
  )
}

if (arch && !config.supportedArchs.includes(arch)) {
  throw new Error(`Unsupported ${config.label} arch: ${arch}. Supported: ${config.supportedArchs.join(", ")}`)
}

const cliPath = path.join(rootDir, "node_modules", "electron-builder", "out", "cli", "cli.js")
if (!existsSync(cliPath)) {
  throw new Error(`electron-builder CLI not found: ${cliPath}. Run bun install first.`)
}

function cleanDesktopArtifacts(targetName) {
  if (process.env.SKIP_DIST_CLEAN === "1") {
    return
  }

  const distDir = path.join(rootDir, "dist")
  if (!existsSync(distDir)) {
    return
  }

  const cleanupMatchers = {
    win: [
      /^Codex Gateway Setup .*\.exe$/i,
      /^Codex Gateway Setup .*\.exe\.blockmap$/i,
      /^latest\.yml$/i,
      /^builder-debug\.yml$/i,
      /^win-unpacked$/i,
    ],
    linux: [
      /^Codex Gateway-.*-linux-.*\.AppImage$/i,
      /^Codex Gateway-.*-linux-.*\.deb$/i,
      /^Codex Gateway-.*-linux-.*\.tar\.gz$/i,
      /^latest-linux\.yml$/i,
      /^linux(-.*)?-unpacked$/i,
    ],
    mac: [/^Codex Gateway-.*-mac-.*\.dmg$/i, /^Codex Gateway-.*-mac-.*\.zip$/i, /^latest-mac\.yml$/i, /^mac(-.*)?$/i],
  }

  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    const shouldRemove = cleanupMatchers[targetName].some((pattern) => pattern.test(entry.name))
    if (!shouldRemove) {
      continue
    }

    rmSync(path.join(distDir, entry.name), { recursive: true, force: true })
  }
}

const env = { ...process.env }
if (target === "mac" && !env.CSC_IDENTITY_AUTO_DISCOVERY) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false"
}

cleanDesktopArtifacts(target)
const buildArgs = [...config.args]
if (arch) {
  buildArgs.push(`--${arch}`)
}

await run(process.execPath, [cliPath, ...buildArgs], { env })
