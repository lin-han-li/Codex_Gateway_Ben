import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const candidateHtmlFiles = [
  "src/web/index.html",
  "server-deploy/src/web/index.html",
  "server-runtime-bundle/src/web/index.html",
]
const htmlFiles = candidateHtmlFiles.filter((relativePath) => existsSync(path.join(rootDir, relativePath)))

const scriptPattern = /<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/i

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

const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-gateway-web-check-"))

try {
  for (const relativePath of htmlFiles) {
    const filePath = path.join(rootDir, relativePath)
    const html = await readFile(filePath, "utf8")
    const match = html.match(scriptPattern)
    if (!match) {
      throw new Error(`No module script found in ${relativePath}`)
    }
    const tempModulePath = path.join(
      tempDir,
      relativePath.replace(/[\\/]/g, "__").replace(/\.html$/i, ".mjs"),
    )
    await writeFile(tempModulePath, match[1], "utf8")
    await run(process.execPath, ["--check", tempModulePath])
    console.log(`Web syntax OK: ${relativePath}`)
  }
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
