import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packagePaths = [{ relativePath: "package.json", required: true }, { relativePath: "server-deploy/package.json", required: true }, { relativePath: "server-runtime-bundle/package.json", required: false }]
const htmlPaths = [
  { relativePath: "src/web/index.html", required: true },
  { relativePath: "server-deploy/src/web/index.html", required: true },
  { relativePath: "server-runtime-bundle/src/web/index.html", required: false },
]

const packages = packagePaths.flatMap(({ relativePath, required }) => {
  const absolutePath = path.join(rootDir, relativePath)
  if (!fs.existsSync(absolutePath)) {
    if (required) {
      throw new Error(`[version-sync] missing required package file: ${relativePath}`)
    }
    return []
  }
  return {
    relativePath,
    json: JSON.parse(fs.readFileSync(absolutePath, "utf8")),
  }
})

const packageVersion = String(packages[0].json.version || "").trim()

if (!packageVersion) {
  throw new Error("package.json is missing version")
}

for (const entry of packages.slice(1)) {
  const candidateVersion = String(entry.json.version || "").trim()
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
  const candidateBadge = String(match[1] || "").trim()
  if (candidateBadge !== expectedBadgeVersion) {
    throw new Error(
      `[version-sync] ${relativePath} badge ${candidateBadge || "<empty>"} does not match package.json version ${expectedBadgeVersion}`,
    )
  }

  const requiredSnippets = [
    "确认删除这个账号吗？关联的单账号 Key 也会一起删除。",
    "剩余时间:",
    "最近使用:",
    "永久",
    "已过期",
  ]
  for (const snippet of requiredSnippets) {
    if (!html.includes(snippet)) {
      throw new Error(`[version-sync] ${relativePath} is missing required UI snippet: ${snippet}`)
    }
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
