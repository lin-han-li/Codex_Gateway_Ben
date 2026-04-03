import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const sourceDir = path.join(root, "src")
const targets = [
  path.join(root, "server-deploy", "src"),
  path.join(root, "server-runtime-bundle", "src"),
  path.join("C:", "Users", "pengjianzhong", "Desktop", "server-runtime-bundle", "src"),
]

const args = new Set(process.argv.slice(2))
const write = args.has("--write")
const verbose = args.has("--verbose")

function summarizeTree(dir) {
  let files = 0
  let bytes = 0
  if (!existsSync(dir)) return { files, bytes }
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(next)
        continue
      }
      files += 1
      bytes += statSync(next).size
    }
  }
  return { files, bytes }
}

if (!existsSync(sourceDir)) {
  console.error(`Source directory not found: ${sourceDir}`)
  process.exit(1)
}

const summary = targets.map((target) => ({
  target,
  exists: existsSync(target),
  before: summarizeTree(target),
}))

if (!write) {
  console.log("Derived copy sync plan (dry-run):")
  for (const item of summary) {
    console.log(`- ${item.target} :: ${item.exists ? "exists" : "missing"} :: ${item.before.files} files`)
  }
  console.log("Run with --write to apply.")
  process.exit(0)
}

for (const target of targets) {
  if (!existsSync(path.dirname(target))) {
    mkdirSync(path.dirname(target), { recursive: true })
  }
  cpSync(sourceDir, target, {
    recursive: true,
    force: true,
  })
  if (verbose) {
    const after = summarizeTree(target)
    console.log(`Synced ${sourceDir} -> ${target} (${after.files} files)`)
  }
}

console.log("Derived source copies synchronized.")
