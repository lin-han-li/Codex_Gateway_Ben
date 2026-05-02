import { __accountsViewTestHooks } from "../src/web/app/views/accounts.js"

function assertCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function account(id, resetAt, remainingPercent = 100) {
  return {
    id,
    quotaWeeklyResetAt: resetAt + 10 * 24 * 60 * 60 * 1000,
    abnormalState: id === "may-03" ? { category: "soft_drained" } : null,
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

const base = Date.UTC(2026, 4, 1, 0, 0, 0)
const input = [
  account("may-08", base + 7 * 24 * 60 * 60 * 1000, 100),
  account("may-03", base + 2 * 24 * 60 * 60 * 1000, 28),
  account("may-06", base + 5 * 24 * 60 * 60 * 1000, 36),
  account("may-02", base + 1 * 24 * 60 * 60 * 1000, 62),
]

const sorted = input
  .map((item, index) => ({ account: item, index }))
  .sort(__accountsViewTestHooks.compareWeeklyResetPriority)
  .map((item) => item.account.id)

const expected = ["may-02", "may-03", "may-06", "may-08"]
assertCondition(
  sorted.join(",") === expected.join(","),
  `weekly UI sort expected=${expected.join(" > ")} actual=${sorted.join(" > ")}`,
)

const displayedReset = __accountsViewTestHooks.resolveDisplayedWeeklyResetAt(input[0])
assertCondition(displayedReset === input[0].quota.primary.secondary.resetsAt, "displayed weekly reset must match visible weekly row")

console.log(`Accounts weekly UI sort audit passed: ${sorted.join(" > ")}`)
