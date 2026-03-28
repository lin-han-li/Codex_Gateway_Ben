import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import {
  buildUpstreamAccountUnavailableFailure,
  normalizeCaughtCodexFailure,
} from "../src/behavior/codex-failure"

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function writeReportWithFallback(reportDir: string, baseName: string, content: string) {
  const primaryPath = path.join(reportDir, baseName)
  try {
    await writeFile(primaryPath, content, "utf8")
    return primaryPath
  } catch {
    const fallbackPath = path.join(
      reportDir,
      `${path.basename(baseName, path.extname(baseName))}-${Date.now()}${path.extname(baseName)}`,
    )
    await writeFile(fallbackPath, content, "utf8")
    return fallbackPath
  }
}

async function main() {
  const findings: string[] = []

  const statusError = Object.assign(new Error("msg: 127.0.0.1:57354 is ban"), { statusCode: 403 })
  const normalizedStatusError = normalizeCaughtCodexFailure({
    error: statusError,
    routingMode: "pool",
  })
  if (!normalizedStatusError) {
    findings.push("status-coded ban error should normalize to upstream_account_unavailable")
  } else {
    const expected = buildUpstreamAccountUnavailableFailure({ routingMode: "pool" })
    if (normalizedStatusError.status !== expected.status) {
      findings.push(`status-coded ban normalized status expected=${expected.status} actual=${normalizedStatusError.status}`)
    }
    if (normalizedStatusError.bodyText !== expected.bodyText) {
      findings.push("status-coded ban normalized body mismatch")
    }
  }

  const plainBanError = new Error("msg: 127.0.0.1:57354 is ban")
  const normalizedPlainBan = normalizeCaughtCodexFailure({
    error: plainBanError,
    routingMode: "pool",
  })
  if (!normalizedPlainBan) {
    findings.push("plain ban error text should normalize even without statusCode")
  }

  const transientPoolError = Object.assign(new Error("upstream 502"), { statusCode: 502 })
  const normalizedTransient = normalizeCaughtCodexFailure({
    error: transientPoolError,
    routingMode: "pool",
  })
  if (!normalizedTransient) {
    findings.push("pool transient status error should normalize to upstream_account_unavailable")
  }

  const transientSingleError = Object.assign(new Error("upstream 502"), { statusCode: 502 })
  const normalizedSingleTransient = normalizeCaughtCodexFailure({
    error: transientSingleError,
    routingMode: "single",
  })
  if (normalizedSingleTransient) {
    findings.push("single-route transient status error should not normalize to pool unavailable")
  }

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const report = [
    "# codex-ban-catch-normalization-audit",
    "",
    findings.length === 0 ? "Result: PASS" : "Result: FAIL",
    "",
    findings.length === 0 ? "- 0 findings" : findings.map((item) => `- ${item}`).join("\n"),
    "",
  ].join("\n")
  const reportPath = await writeReportWithFallback(reportDir, "codex-ban-catch-normalization-audit.md", report)

  assertCondition(findings.length === 0, `codex-ban-catch-normalization-audit failed. Report: ${reportPath}`)
  console.log(`codex-ban-catch-normalization-audit passed. Report: ${reportPath}`)
}

await main()
