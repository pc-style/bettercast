import {createHash} from 'node:crypto'
import {readFile, writeFile, rename} from 'node:fs/promises'
import {createServer as httpServer} from 'node:http'
import {dirname, extname, join, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const assets = join(root, 'site')
const types = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'}
const digest = text => createHash('sha256').update(text).digest('hex')

export function createWorksheetServer(documentPath = join(root, 'AGENTS.md')) {
  return httpServer(async (request, response) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})
      response.end(body)
    }
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      if (pathname === '/api/document') {
        if (request.method === 'GET') {
          const text = await readFile(documentPath, 'utf8')
          return send(200, JSON.stringify({text, version: digest(text)}))
        }
        if (request.method !== 'POST') return send(405, '{"error":"Method not allowed"}')
        const origin = request.headers.origin
        if (!origin || new URL(origin).host !== request.headers.host || !['http:', 'https:'].includes(new URL(origin).protocol)) {
          return send(403, '{"error":"Same-origin request required"}')
        }
        if (request.headers['content-type'] !== 'application/json') return send(415, '{"error":"JSON required"}')
        let raw = ''
        for await (const chunk of request) {
          raw += chunk
          if (raw.length > 65536) return send(413, '{"error":"Document too large"}')
        }
        const {text, version} = JSON.parse(raw)
        if (typeof text !== 'string' || !text.trim() || text.length > 60000 || typeof version !== 'string') {
          return send(400, '{"error":"Invalid document"}')
        }
        const current = await readFile(documentPath, 'utf8')
        if (digest(current) !== version) return send(409, '{"error":"AGENTS.md changed elsewhere. Copy your draft, then reload before saving."}')
        const temporary = `${documentPath}.${process.pid}.tmp`
        await writeFile(temporary, text, {mode: 0o644})
        await rename(temporary, documentPath)
        return send(200, JSON.stringify({version: digest(text)}))
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, '{"error":"Method not allowed"}')
      const target = resolve(assets, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!target.startsWith(assets + sep) || !types[extname(target)]) return send(404, 'Not found', 'text/plain')
      const body = await readFile(target)
      send(200, request.method === 'HEAD' ? '' : body, types[extname(target)])
    } catch (error) {
      if (error.code === 'ENOENT') return send(404, 'Not found', 'text/plain')
      if (error instanceof SyntaxError) return send(400, '{"error":"Invalid JSON"}')
      console.error(error)
      send(500, '{"error":"Unable to serve or save document"}')
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWorksheetServer().listen(Number(process.env.PORT || 4173), '0.0.0.0', () => {
    console.log(`Worksheet listening on port ${process.env.PORT || 4173}`)
  })
}
