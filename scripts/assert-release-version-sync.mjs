import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const packagePaths = [
  { relativePath: "package.json", required: true },
  { relativePath: "server-deploy/package.json", required: true },
  { relativePath: "server-runtime-bundle/package.json", required: false },
]

const htmlPaths = [
  { relativePath: "src/web/index.html", required: true },
  { relativePath: "server-deploy/src/web/index.html", required: true },
  { relativePath: "server-runtime-bundle/src/web/index.html", required: false },
]

const requiredResourcePaths = [
  { relativePath: "electron/main.cjs", required: true },
  { relativePath: "build/installer.nsh", required: true },
]

function readJson(relativePath) {
  const absolutePath = path.join(rootDir, relativePath)
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"))
}

const packages = packagePaths.flatMap(({ relativePath, required }) => {
  const absolutePath = path.join(rootDir, relativePath)
  if (!fs.existsSync(absolutePath)) {
    if (required) {
      throw new Error(`[version-sync] missing required package file: ${relativePath}`)
    }
    return []
  }
  return [{ relativePath, json: readJson(relativePath) }]
})

const packageVersion = String(packages[0]?.json?.version ?? "").trim()
if (!packageVersion) {
  throw new Error("[version-sync] package.json is missing version")
}

for (const entry of packages.slice(1)) {
  const candidateVersion = String(entry.json.version ?? "").trim()
  if (candidateVersion !== packageVersion) {
    throw new Error(
      `[version-sync] ${entry.relativePath} version ${candidateVersion || "<empty>"} does not match root package.json version ${packageVersion}`,
    )
  }
}

const expectedBadgeVersion = `v${packageVersion}`

for (const { relativePath, required } of htmlPaths) {
  const absolutePath = path.join(rootDir, relativePath)
  if (!fs.existsSync(absolutePath)) {
    if (required) {
      throw new Error(`[version-sync] missing required html file: ${relativePath}`)
    }
    continue
  }

  const html = fs.readFileSync(absolutePath, "utf8")
  const match = html.match(/<div class="ver">\s*([^<]+)\s*<\/div>/i)
  if (!match) {
    throw new Error(`[version-sync] version badge not found in ${relativePath}`)
  }

  const candidateBadge = String(match[1] ?? "").trim()
  if (candidateBadge !== expectedBadgeVersion) {
    throw new Error(
      `[version-sync] ${relativePath} badge ${candidateBadge || "<empty>"} does not match package.json version ${expectedBadgeVersion}`,
    )
  }

  if (!/<script\b/i.test(html)) {
    throw new Error(`[version-sync] ${relativePath} is missing script tags`)
  }
}

for (const { relativePath, required } of requiredResourcePaths) {
  const absolutePath = path.join(rootDir, relativePath)
  if (!fs.existsSync(absolutePath) && required) {
    throw new Error(`[version-sync] missing required resource: ${relativePath}`)
  }
}

const expectedTag = `v${packageVersion}`
const refName = String(process.env.GITHUB_REF_NAME || process.argv[2] || "").trim()

if (!refName) {
  console.log(`[version-sync] package.json version=${packageVersion}; no release tag context detected`)
  process.exit(0)
}

if (!/^v\d+\.\d+\.\d+$/.test(refName)) {
  console.log(`[version-sync] ignoring non-release tag/context: ${refName}`)
  process.exit(0)
}

if (refName !== expectedTag) {
  throw new Error(`[version-sync] release tag ${refName} does not match package.json version ${packageVersion} (expected ${expectedTag})`)
}

console.log(`[version-sync] release tag ${refName} matches package.json version ${packageVersion}`)
