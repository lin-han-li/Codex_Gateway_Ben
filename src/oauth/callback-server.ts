const HTML_SUCCESS = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sign into Codex</title>
    <link rel="icon" href='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 32 32"%3E%3Cpath stroke="%23000" stroke-linecap="round" stroke-width="2.484" d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z"/%3E%3C/svg%3E' type="image/svg+xml">
    <style>
      .container {
        margin: auto;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        background: white;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans",
          "Helvetica Neue", sans-serif;
      }
      .inner-container {
        width: 400px;
        flex-direction: column;
        justify-content: flex-start;
        align-items: center;
        gap: 20px;
        display: inline-flex;
      }
      .content {
        align-self: stretch;
        flex-direction: column;
        justify-content: flex-start;
        align-items: center;
        gap: 20px;
        display: flex;
        margin-top: 15vh;
      }
      .logo {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 4rem;
        height: 4rem;
        border-radius: 16px;
        border: 0.5px solid rgba(0, 0, 0, 0.1);
        box-shadow: rgba(0, 0, 0, 0.1) 0 4px 16px 0;
      }
      .title {
        text-align: center;
        color: #0d0d0d;
        font-size: 32px;
        font-weight: 400;
        line-height: 40px;
        word-wrap: break-word;
      }
      .setup-box {
        width: 600px;
        padding: 16px 20px;
        background: white;
        box-shadow: 0px 4px 16px rgba(0, 0, 0, 0.05);
        border-radius: 16px;
        outline: 1px rgba(13, 13, 13, 0.1) solid;
        outline-offset: -1px;
        justify-content: flex-start;
        align-items: center;
        gap: 16px;
        display: inline-flex;
      }
      .setup-content {
        flex: 1 1 0;
        justify-content: flex-start;
        align-items: center;
        gap: 24px;
        display: flex;
      }
      .setup-text {
        flex: 1 1 0;
        flex-direction: column;
        justify-content: flex-start;
        align-items: flex-start;
        gap: 4px;
        display: inline-flex;
      }
      .setup-title {
        align-self: stretch;
        color: #0d0d0d;
        font-size: 14px;
        font-weight: 510;
        line-height: 20px;
        word-wrap: break-word;
      }
      .setup-description {
        align-self: stretch;
        color: #5d5d5d;
        font-size: 14px;
        font-weight: 400;
        line-height: 20px;
        word-wrap: break-word;
      }
      .redirect-box {
        justify-content: flex-start;
        align-items: center;
        gap: 8px;
        display: flex;
      }
      .redirect-button {
        height: 28px;
        padding: 8px 16px;
        background: #0d0d0d;
        border-radius: 999px;
        justify-content: center;
        align-items: center;
        gap: 4px;
        display: flex;
      }
      .redirect-text {
        color: white;
        font-size: 14px;
        font-weight: 510;
        line-height: 20px;
        word-wrap: break-word;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="inner-container">
        <div class="content">
          <div class="logo">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 32 32"><path stroke="#000" stroke-linecap="round" stroke-width="2.484" d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z"></path></svg>
          </div>
          <div class="title">Signed in to Codex</div>
        </div>
        <div class="close-box" style="display: none;">
          <div class="setup-description">You may now close this page</div>
        </div>
        <div class="setup-box" style="display: none;">
          <div class="setup-content">
            <div class="setup-text">
              <div class="setup-title">Finish setting up your API organization</div>
              <div class="setup-description">Add a payment method to use your organization.</div>
            </div>
            <div class="redirect-box">
              <div class="redirect-button">
                <div class="redirect-text">Redirecting in 3s...</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <script>
      (function () {
        const params = new URLSearchParams(window.location.search);
        const needsSetup = params.get("needs_setup") === "true";
        const platformUrl = params.get("platform_url") || "https://platform.openai.com";
        const orgId = params.get("org_id");
        const projectId = params.get("project_id");
        const planType = params.get("plan_type");
        const idToken = params.get("id_token");

        if (needsSetup) {
          const setupBox = document.querySelector(".setup-box");
          setupBox.style.display = "flex";
          const redirectUrlObj = new URL("/org-setup", platformUrl);
          redirectUrlObj.searchParams.set("p", planType || "");
          redirectUrlObj.searchParams.set("t", idToken || "");
          redirectUrlObj.searchParams.set("with_org", orgId || "");
          redirectUrlObj.searchParams.set("project_id", projectId || "");
          const redirectUrl = redirectUrlObj.toString();
          const message = document.querySelector(".redirect-text");
          let countdown = 3;
          function tick() {
            message.textContent = "Redirecting in " + countdown + "s...";
            if (countdown === 0) {
              window.location.replace(redirectUrl);
            } else {
              countdown -= 1;
              setTimeout(tick, 1000);
            }
          }
          tick();
        } else {
          const closeBox = document.querySelector(".close-box");
          closeBox.style.display = "flex";
        }
      })();
    </script>
  </body>
</html>`

const HTML_ERROR_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Codex Sign-in Error</title>
    <link rel="icon" href='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 32 32"%3E%3Cpath stroke="%23000" stroke-linecap="round" stroke-width="2.484" d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z"/%3E%3C/svg%3E' type="image/svg+xml">
    <style>
      :root {
        color-scheme: light;
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans",
          "Helvetica Neue", sans-serif;
        background: radial-gradient(circle at top, #f7f8fb 0%, #ffffff 48%);
        color: #0d0d0d;
      }
      .container {
        min-height: 100vh;
        padding: 24px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .card {
        width: min(680px, 100%);
        border-radius: 16px;
        border: 1px solid rgba(13, 13, 13, 0.12);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.06);
        background: #ffffff;
        padding: 24px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .logo {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: 10px;
        border: 1px solid rgba(0, 0, 0, 0.1);
      }
      .brand-title {
        font-size: 14px;
        color: #5d5d5d;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: 28px;
        line-height: 1.2;
      }
      .message {
        margin: 0;
        font-size: 16px;
        line-height: 1.45;
      }
      .details {
        margin-top: 18px;
        border-radius: 12px;
        border: 1px solid rgba(13, 13, 13, 0.1);
        background: #fafafa;
        padding: 14px;
        display: grid;
        gap: 8px;
      }
      .details-row {
        display: grid;
        grid-template-columns: 136px 1fr;
        gap: 10px;
        font-size: 13px;
        align-items: baseline;
      }
      .details-row strong {
        color: #5d5d5d;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        word-break: break-all;
      }
      .help {
        margin-top: 16px;
        font-size: 14px;
        color: #5d5d5d;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <div class="brand">
          <div class="logo" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 32 32"><path stroke="#000" stroke-linecap="round" stroke-width="2.484" d="M22.356 19.797H17.17M9.662 12.29l1.979 3.576a.511.511 0 0 1-.005.504l-1.974 3.409M30.758 16c0 8.15-6.607 14.758-14.758 14.758-8.15 0-14.758-6.607-14.758-14.758C1.242 7.85 7.85 1.242 16 1.242c8.15 0 14.758 6.608 14.758 14.758Z"></path></svg>
          </div>
          <div class="brand-title">Codex login</div>
        </div>
        <h1>__ERROR_TITLE__</h1>
        <p class="message">__ERROR_MESSAGE__</p>
        <div class="details">
          <div class="details-row">
            <strong>Error code</strong>
            <code>__ERROR_CODE__</code>
          </div>
          <div class="details-row">
            <strong>Details</strong>
            <code>__ERROR_DESCRIPTION__</code>
          </div>
        </div>
        <p class="help">__ERROR_HELP__</p>
      </div>
    </div>
  </body>
</html>`

type PendingAuthorization = {
  state: string
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

function base64UrlEncode(input: ArrayBuffer) {
  const bytes = new Uint8Array(input)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function isMissingCodexEntitlementError(errorCode: string, errorDescription?: string | null) {
  return (
    errorCode === "access_denied" &&
    String(errorDescription ?? "")
      .toLowerCase()
      .includes("missing_codex_entitlement")
  )
}

function oauthCallbackErrorMessage(errorCode: string, errorDescription?: string | null) {
  if (isMissingCodexEntitlementError(errorCode, errorDescription)) {
    return "Codex is not enabled for your workspace. Contact your workspace administrator to request access to Codex."
  }

  const description = String(errorDescription ?? "").trim()
  if (description) return `Sign-in failed: ${description}`
  return `Sign-in failed: ${errorCode}`
}

function renderLoginErrorPage(message: string, errorCode?: string | null, errorDescription?: string | null) {
  const code = String(errorCode || "unknown_error")
  const missingEntitlement = isMissingCodexEntitlementError(code, errorDescription)
  const title = missingEntitlement ? "You do not have access to Codex" : "Sign-in could not be completed"
  const displayMessage = missingEntitlement
    ? "This account is not currently authorized to use Codex in this workspace."
    : message
  const details = missingEntitlement
    ? "Contact your workspace administrator to request access to Codex."
    : String(errorDescription || message)
  const help = missingEntitlement
    ? "Contact your workspace administrator to get access to Codex, then return to Codex and try again."
    : "Return to Codex to retry, switch accounts, or contact your workspace admin if access is restricted."

  return HTML_ERROR_TEMPLATE.replace("__ERROR_TITLE__", htmlEscape(title))
    .replace("__ERROR_MESSAGE__", htmlEscape(displayMessage))
    .replace("__ERROR_CODE__", htmlEscape(code))
    .replace("__ERROR_DESCRIPTION__", htmlEscape(details))
    .replace("__ERROR_HELP__", htmlEscape(help))
}

export class LocalCallbackServer {
  private server: ReturnType<typeof Bun.serve> | undefined
  private pending: PendingAuthorization | undefined

  constructor(
    private readonly port: number,
    private readonly callbackPath: string,
  ) {}

  get redirectUrl() {
    return `http://localhost:${this.port}${this.callbackPath}`
  }

  createState() {
    return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
  }

  async ensureRunning() {
    if (this.server) return

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    })
  }

  waitForCode(state: string) {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending) {
          this.pending = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      }, 5 * 60 * 1000)

      this.pending = {
        state,
        timeout,
        resolve: (code) => {
          clearTimeout(timeout)
          resolve(code)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      }
    })
  }

  async stop() {
    if (this.server) {
      this.server.stop()
      this.server = undefined
    }

    if (this.pending) {
      this.pending.reject(new Error("OAuth callback server stopped"))
      this.pending = undefined
    }
  }

  private handleRequest(req: Request): Response {
    const url = new URL(req.url)

    if (url.pathname === "/cancel") {
      this.pending?.reject(new Error("Login cancelled"))
      this.pending = undefined
      return new Response("Login cancelled", { status: 200 })
    }

    if (url.pathname !== this.callbackPath) {
      return new Response("Not found", { status: 404 })
    }

    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const error = url.searchParams.get("error")
    const errorDescription = url.searchParams.get("error_description")

    if (error) {
      const errorMessage = oauthCallbackErrorMessage(error, errorDescription)
      this.pending?.reject(new Error(errorMessage))
      this.pending = undefined
      return new Response(renderLoginErrorPage(errorMessage, error, errorDescription), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    if (!code) {
      const errorMessage = "Missing authorization code"
      this.pending?.reject(new Error(errorMessage))
      this.pending = undefined
      return new Response(renderLoginErrorPage(errorMessage, "missing_authorization_code", null), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    if (!this.pending || state !== this.pending.state) {
      const errorMessage = "Invalid state - potential CSRF attack"
      this.pending?.reject(new Error(errorMessage))
      this.pending = undefined
      return new Response("State mismatch", { status: 400 })
    }

    const current = this.pending
    this.pending = undefined
    current.resolve(code)

    return new Response(HTML_SUCCESS, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }
}
