import { __accountsViewTestHooks } from "../src/web/app/views/accounts.js"
import { readFile } from "node:fs/promises"

function assertCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function account(id, resetAt, remainingPercent = 100) {
  return {
    id,
    quotaWeeklyResetAt: resetAt + 10 * 24 * 60 * 60 * 1000,
    abnormalState: id === "plus-2d" ? { category: "soft_drained" } : null,
    quota: {
      status: "ok",
      primary: {
        limitId: "codex",
        limitName: null,
        primary: null,
        secondary: {
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          windowSeconds: 7 * 24 * 60 * 60,
          windowMinutes: 7 * 24 * 60,
          resetsAt: resetAt,
        },
      },
      additional: [],
    },
  }
}

const base = Date.UTC(2026, 4, 2, 0, 0, 0)
const input = [
  account("plus-7d", base + 7 * 24 * 60 * 60 * 1000, 100),
  account("plus-2d", base + 2 * 24 * 60 * 60 * 1000, 28),
  account("plus-5d", base + 5 * 24 * 60 * 60 * 1000, 36),
  account("plus-1d", base + 1 * 24 * 60 * 60 * 1000, 62),
]

const sorted = __accountsViewTestHooks
  .sortAccountEntriesByWeeklyReset(
    input.map((item, index) => ({ account: item, index })),
    base,
  )
  .map((item) => item.account.id)

const expected = ["plus-1d", "plus-2d", "plus-5d", "plus-7d"]
assertCondition(
  sorted.join(",") === expected.join(","),
  `weekly UI sort expected=${expected.join(" > ")} actual=${sorted.join(" > ")}`,
)
assertCondition(
  __accountsViewTestHooks.compareResetDistance(base + 60_000, base + 60 * 60_000, base) < 0,
  "shorter refresh distance must sort before longer refresh distance",
)

const sameDayInput = [
  account("may-03-1214", Date.UTC(2026, 4, 3, 12, 14), 1),
  account("may-02-1705", Date.UTC(2026, 4, 2, 17, 5), 0),
  account("may-02-1610", Date.UTC(2026, 4, 2, 16, 10), 75),
  account("may-02-1750", Date.UTC(2026, 4, 2, 17, 50), 0),
  account("may-02-1821", Date.UTC(2026, 4, 2, 18, 21), 60),
  account("may-02-1709", Date.UTC(2026, 4, 2, 17, 9), 0),
]
const sameDaySorted = __accountsViewTestHooks
  .sortAccountEntriesByWeeklyReset(
    sameDayInput.map((item, index) => ({ account: item, index })),
    Date.UTC(2026, 4, 2, 15, 41),
  )
  .map((item) => item.account.id)
const expectedSameDay = ["may-02-1610", "may-02-1705", "may-02-1709", "may-02-1750", "may-02-1821", "may-03-1214"]
assertCondition(
  sameDaySorted.join(",") === expectedSameDay.join(","),
  `same-day weekly UI sort expected=${expectedSameDay.join(" > ")} actual=${sameDaySorted.join(" > ")}`,
)

const cardSorted = __accountsViewTestHooks
  .sortCardItemsByWeeklyReset(
    sameDayInput.map((item, index) => ({
      id: item.id,
      weeklyResetAt: item.quota.primary.secondary.resetsAt,
      originalIndex: index,
    })),
    Date.UTC(2026, 4, 2, 15, 41),
  )
  .map((item) => item.id)
assertCondition(
  cardSorted.join(",") === expectedSameDay.join(","),
  `final card order expected=${expectedSameDay.join(" > ")} actual=${cardSorted.join(" > ")}`,
)

const displayedReset = __accountsViewTestHooks.resolveDisplayedWeeklyResetAt(input[0])
assertCondition(displayedReset === input[0].quota.primary.secondary.resetsAt, "displayed weekly reset must match visible weekly row")

const webShell = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8")
assertCondition(!webShell.includes("\u5df2\u6682\u7f13\u5206\u6d41"), "web UI must not display legacy soft-drain wording")
assertCondition(!webShell.includes("????"), "web UI must not contain corrupted replacement glyphs")

console.log(`Accounts weekly UI sort audit passed: ${sorted.join(" > ")}`)
