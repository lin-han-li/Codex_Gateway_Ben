import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = String(process.argv[2] || "").trim().toLowerCase()

const targetConfig = {
  win: {
    hostPlatform: "win32",
    label: "Windows",
    args: ["--win", "nsis", "--publish", "never", "--config.win.signAndEditExecutable=false"],
  },
  linux: {
    hostPlatform: "linux",
    label: "Linux",
    args: ["--linux", "AppImage", "deb", "tar.gz", "--publish", "never"],
  },
  mac: {
    hostPlatform: "darwin",
    label: "macOS",
    args: ["--mac", "dmg", "zip", "--publish", "never"],
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

const cliPath = path.join(rootDir, "node_modules", "electron-builder", "out", "cli", "cli.js")
if (!existsSync(cliPath)) {
  throw new Error(`electron-builder CLI not found: ${cliPath}. Run bun install first.`)
}

const env = { ...process.env }
if (target === "mac" && !env.CSC_IDENTITY_AUTO_DISCOVERY) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false"
}

await run(process.execPath, [cliPath, ...config.args], { env })
