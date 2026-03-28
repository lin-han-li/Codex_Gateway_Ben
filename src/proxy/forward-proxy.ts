import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import net, { type Socket } from "node:net"

type ForwardProxyOptions = {
  host: string
  port: number
  allowedHosts: string[]
  enforceAllowlist?: boolean
  onLog?: (line: string) => void
}

function normalizeHost(value: string) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
}

function parseConnectAuthority(authority: string) {
  const text = String(authority ?? "").trim()
  if (!text) return null
  try {
    const parsed = new URL(`http://${text}`)
    const hostname = normalizeHost(parsed.hostname)
    const port = Number(parsed.port || "443")
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { hostname, port }
  } catch {
    return null
  }
}

function parseProxyTarget(req: IncomingMessage) {
  const rawUrl = String(req.url ?? "").trim()
  if (!rawUrl) return null

  try {
    if (/^https?:\/\//i.test(rawUrl)) {
      const parsed = new URL(rawUrl)
      return parsed
    }
    const host = String(req.headers.host ?? "").trim()
    if (!host) return null
    return new URL(`https://${host}${rawUrl}`)
  } catch {
    return null
  }
}

type ClosableSocket = {
  end?: () => void
  destroy?: () => void
}

function closeSocket(socket: ClosableSocket | null | undefined) {
  if (!socket) return
  try {
    socket.end?.()
  } catch {}
  try {
    socket.destroy?.()
  } catch {}
}

function respondConnectError(socket: Socket, statusCode: number, message: string) {
  try {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`)
  } finally {
    closeSocket(socket)
  }
}

function sanitizeProxyHeaders(headers: IncomingMessage["headers"], targetHost: string) {
  const next = { ...headers }
  delete next["proxy-connection"]
  delete next["proxy-authorization"]
  next.host = targetHost
  return next
}

export class RestrictedForwardProxy {
  private readonly options: ForwardProxyOptions
  private readonly allowedExactHosts: Set<string>
  private readonly allowedSuffixHosts: string[]
  private readonly enforceAllowlist: boolean
  private server: http.Server | null = null

  constructor(options: ForwardProxyOptions) {
    this.options = options
    this.enforceAllowlist = options.enforceAllowlist === true
    this.allowedExactHosts = new Set<string>()
    this.allowedSuffixHosts = []
    for (const rawHost of options.allowedHosts) {
      const normalized = normalizeHost(rawHost)
      if (!normalized) continue
      if (normalized.startsWith("*.")) {
        this.allowedSuffixHosts.push(normalized.slice(1))
        continue
      }
      if (normalized.startsWith(".")) {
        this.allowedSuffixHosts.push(normalized)
        continue
      }
      this.allowedExactHosts.add(normalized)
    }
  }

  private log(message: string) {
    this.options.onLog?.(message)
  }

  private isAllowedHost(hostname: string) {
    const normalized = normalizeHost(hostname)
    if (!normalized) return false
    if (this.allowedExactHosts.has(normalized)) return true
    return this.allowedSuffixHosts.some((suffix) => normalized.endsWith(suffix))
  }

  private handleHttp = (req: IncomingMessage, res: ServerResponse) => {
    const target = parseProxyTarget(req)
    if (!target) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("Invalid proxy request URL")
      return
    }

    const protocol = target.protocol.toLowerCase()
    if (protocol !== "http:" && protocol !== "https:") {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("Unsupported protocol")
      return
    }

    if (!this.isAllowedHost(target.hostname)) {
      if (this.enforceAllowlist) {
        this.log(`[forward-proxy] deny HTTP target host=${target.hostname} method=${String(req.method ?? "GET")}`)
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("Target host is not allowed")
        return
      }
      this.log(`[forward-proxy] passthrough HTTP non-allowlisted host=${target.hostname} method=${String(req.method ?? "GET")}`)
    }

    const transport = protocol === "https:" ? https : http
    const port = Number(target.port || (protocol === "https:" ? 443 : 80))
    const upstream = transport.request(
      {
        protocol,
        hostname: target.hostname,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: sanitizeProxyHeaders(req.headers, target.host),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )

    upstream.on("error", (error) => {
      this.log(
        `[forward-proxy] upstream HTTP error host=${target.hostname} method=${String(req.method ?? "GET")} error=${error.message}`,
      )
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
      }
      res.end(`Upstream request failed: ${error.message}`)
    })

    req.pipe(upstream)
  }

  private handleConnect = (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const target = parseConnectAuthority(req.url ?? "")
    if (!target) {
      respondConnectError(clientSocket, 400, "Bad Request")
      return
    }

    if (!this.isAllowedHost(target.hostname)) {
      if (this.enforceAllowlist) {
        this.log(`[forward-proxy] deny CONNECT target host=${target.hostname}:${target.port}`)
        respondConnectError(clientSocket, 403, "Forbidden")
        return
      }
      this.log(`[forward-proxy] passthrough CONNECT non-allowlisted host=${target.hostname}:${target.port}`)
    }

    const upstreamSocket = net.connect(target.port, target.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length > 0) {
        upstreamSocket.write(head)
      }
      clientSocket.pipe(upstreamSocket)
      upstreamSocket.pipe(clientSocket)
    })

    upstreamSocket.on("error", () => {
      this.log(`[forward-proxy] upstream CONNECT error host=${target.hostname}:${target.port}`)
      respondConnectError(clientSocket, 502, "Bad Gateway")
    })

    clientSocket.on("error", () => closeSocket(upstreamSocket))
  }

  async start() {
    if (this.server) return
    const server = http.createServer(this.handleHttp)
    server.on("connect", this.handleConnect)
    server.on("clientError", (error, socket) => {
      this.log(`[forward-proxy] client error: ${error.message}`)
      closeSocket(socket)
    })

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject)
        resolve()
      })
    })

    this.server = server
    this.log(
      `[forward-proxy] listening at http://${this.options.host}:${this.options.port} enforce_allowlist=${String(this.enforceAllowlist)} allowed_exact_hosts=${[...this.allowedExactHosts].join(",")} allowed_suffix_hosts=${this.allowedSuffixHosts.join(",")}`,
    )
  }

  async stop() {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}
