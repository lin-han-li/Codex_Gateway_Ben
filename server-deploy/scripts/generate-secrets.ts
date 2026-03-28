import { randomBytes } from "node:crypto"

const adminToken = randomBytes(24).toString("base64url")
const encryptionKey = randomBytes(32).toString("hex")

console.log("# Paste these into .env")
console.log(`OAUTH_APP_ADMIN_TOKEN=${adminToken}`)
console.log(`OAUTH_APP_ENCRYPTION_KEY=${encryptionKey}`)
console.log("")
console.log("# Keep OAUTH_APP_ENCRYPTION_KEY stable after first production login.")
console.log("# Back up the entire data directory together with this encryption key.")
