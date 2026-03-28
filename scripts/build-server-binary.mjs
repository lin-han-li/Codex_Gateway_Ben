import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverDir = path.join(rootDir, "build", "server")
const outputName = process.platform === "win32" ? "oauth-server.exe" : "oauth-server"
const outputPath = path.join(serverDir, outputName)

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

await run("bun", ["build", "--compile", "src/index.ts", "--outfile", outputPath])
console.log(`Built standalone server binary: ${outputPath}`)
