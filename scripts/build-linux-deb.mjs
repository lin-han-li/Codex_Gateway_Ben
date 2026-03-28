import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"))
const version = String(packageJson.version || "").trim()
const archArg = String(process.argv[2] || "arm64").trim().toLowerCase()
const packageArchMap = {
  x64: "amd64",
  arm64: "arm64",
  armv7l: "armhf",
}
const packageArch = packageArchMap[archArg]

if (!packageArch) {
  throw new Error(`Unsupported Debian package arch: ${archArg}. Supported: ${Object.keys(packageArchMap).join(", ")}`)
}

if (process.platform !== "linux") {
  throw new Error(`Linux desktop packages must be assembled on Linux. Current host is ${process.platform}.`)
}

if (!version) {
  throw new Error("package.json is missing version")
}

const distDir = path.join(rootDir, "dist")
const unpackedCandidates = archArg === "x64" ? ["linux-unpacked", "linux-x64-unpacked"] : [`linux-${archArg}-unpacked`, "linux-unpacked"]
const unpackedDir = unpackedCandidates.map((name) => path.join(distDir, name)).find((candidate) => fs.existsSync(candidate))

if (!unpackedDir) {
  throw new Error(`Unable to find unpacked Linux app directory under dist/. Tried: ${unpackedCandidates.join(", ")}`)
}

const executableName = String(packageJson.build?.linux?.executableName || "codex-gateway").trim()
const productName = String(packageJson.build?.productName || packageJson.productName || "Codex Gateway").trim()
const maintainer =
  typeof packageJson.author === "object" && packageJson.author
    ? `${packageJson.author.name || "Unknown"} <${packageJson.author.email || "unknown@example.com"}>`
    : String(packageJson.author || "Unknown <unknown@example.com>")
const homepage = "https://github.com/lin-han-li/Codex_Gateway_Ben"
const description = String(packageJson.build?.linux?.description || packageJson.description || productName).trim()
const synopsis = String(packageJson.build?.linux?.synopsis || productName).trim()

const debName = `${productName}-${version}-linux-${archArg}.deb`
const debPath = path.join(distDir, debName)
const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-deb-"))
const packageRoot = path.join(stagingRoot, "pkgroot")
const optDir = path.join(packageRoot, "opt", executableName)
const debianDir = path.join(packageRoot, "DEBIAN")
const binDir = path.join(packageRoot, "usr", "bin")
const applicationsDir = path.join(packageRoot, "usr", "share", "applications")
const iconRootDir = path.join(packageRoot, "usr", "share", "icons", "hicolor")

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

function directorySizeBytes(targetPath) {
  let total = 0
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      total += directorySizeBytes(entryPath)
      continue
    }
    total += fs.statSync(entryPath).size
  }
  return total
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true })
}

function writeExecutable(targetPath, content) {
  fs.writeFileSync(targetPath, content, "utf8")
  fs.chmodSync(targetPath, 0o755)
}

try {
  ensureDir(path.dirname(optDir))
  ensureDir(debianDir)
  ensureDir(binDir)
  ensureDir(applicationsDir)

  fs.cpSync(unpackedDir, optDir, { recursive: true })

  const wrapperPath = path.join(binDir, executableName)
  writeExecutable(
    wrapperPath,
    `#!/bin/sh
exec /opt/${executableName}/${executableName} "$@"
`,
  )

  const iconSourceDir = path.join(rootDir, "build", "icons")
  for (const iconSize of [32, 64, 128, 256, 512]) {
    const iconSourcePath = path.join(iconSourceDir, `${iconSize}x${iconSize}.png`)
    if (!fs.existsSync(iconSourcePath)) {
      continue
    }
    const destinationDir = path.join(iconRootDir, `${iconSize}x${iconSize}`, "apps")
    ensureDir(destinationDir)
    fs.copyFileSync(iconSourcePath, path.join(destinationDir, `${executableName}.png`))
  }

  const desktopFilePath = path.join(applicationsDir, `${executableName}.desktop`)
  fs.writeFileSync(
    desktopFilePath,
    `[Desktop Entry]
Name=${productName}
Comment=Multi-account OAuth gateway desktop app
Exec=${executableName} %U
Terminal=false
Type=Application
Icon=${executableName}
Categories=Development;Network;
Keywords=Codex;Gateway;OAuth;OpenAI;Proxy;
StartupNotify=true
StartupWMClass=${productName}
`,
    "utf8",
  )

  const installedSizeKb = Math.max(1, Math.ceil(directorySizeBytes(packageRoot) / 1024))
  const controlFilePath = path.join(debianDir, "control")
  fs.writeFileSync(
    controlFilePath,
    `Package: ${executableName}
Version: ${version}
Section: utils
Priority: optional
Architecture: ${packageArch}
Maintainer: ${maintainer}
Homepage: ${homepage}
Installed-Size: ${installedSizeKb}
Depends: libgtk-3-0, libnss3, libnspr4, libxss1, libxtst6, libnotify4, libsecret-1-0, libatspi2.0-0, libuuid1, libgbm1, libdrm2, libxkbcommon0, xdg-utils, libasound2 | libasound2t64
Description: ${synopsis}
 ${description}
`,
    "utf8",
  )

  await run("dpkg-deb", ["--build", "--root-owner-group", packageRoot, debPath])
  console.log(`[build-linux-deb] wrote ${debPath}`)
} finally {
  fs.rmSync(stagingRoot, { recursive: true, force: true })
}
