import type { Request } from 'express'
import Busboy from 'busboy'

import type { ParsedUploadFile } from './types'
import { BATCH_MAX_FILES } from './config'

/**
 * Nhost Functions pre-buffer POST bodies into `req.rawBody`.
 * The live `req` stream is often already drained — prefer `rawBody` when present.
 */
type NhostRequest = Request & { rawBody?: Buffer }

function multipartBody(req: NhostRequest): Buffer | null {
  if (req.rawBody?.length) return req.rawBody
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return req.body
  return null
}

function feedBusboy(req: NhostRequest, busboy: ReturnType<typeof Busboy>): void {
  const body = multipartBody(req)
  if (body) {
    // end() is fine when the finish handler awaits pending file collectors first
    busboy.end(body)
    return
  }
  if (!req.readableEnded) {
    req.pipe(busboy)
    return
  }
  busboy.end()
}

function collectFileStream(
  stream: NodeJS.ReadableStream,
  info: { mimeType: string; filename: string },
): Promise<ParsedUploadFile> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => {
      resolve({
        buffer: Buffer.concat(chunks),
        mimetype: info.mimeType,
        filename: info.filename ?? 'upload',
      })
    })
    stream.on('error', reject)
  })
}

function assertMultipart(req: Request): void {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new Error(
      `Expected multipart/form-data request (got: ${contentType || 'missing Content-Type'})`,
    )
  }
}

function rejectNoFile(req: NhostRequest, contentType: string): Error {
  const rawLen = req.rawBody?.length ?? 0
  const bodyLen = Buffer.isBuffer(req.body) ? req.body.length : 0
  return new Error(
    `No file received (rawBody=${rawLen}b, body=${bodyLen}b, content-type=${contentType.slice(0, 80)})`,
  )
}

/** Parse the first file field from a multipart request. */
export function parseSingleFile(req: Request): Promise<ParsedUploadFile> {
  assertMultipart(req)
  const contentType = req.headers['content-type'] ?? ''

  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers })
    const pending: Promise<void>[] = []
    let firstFile: ParsedUploadFile | null = null

    busboy.on('file', (_fieldname, stream, info) => {
      if (firstFile) {
        stream.resume()
        return
      }
      pending.push(
        collectFileStream(stream, info).then((file) => {
          firstFile = file
        }),
      )
    })

    busboy.on('error', reject)
    busboy.on('finish', () => {
      void Promise.all(pending)
        .then(() => {
          if (!firstFile) {
            reject(rejectNoFile(req as NhostRequest, contentType))
          } else {
            resolve(firstFile)
          }
        })
        .catch(reject)
    })

    feedBusboy(req as NhostRequest, busboy)
  })
}

/** Parse up to `maxFiles` file fields from a multipart request. */
export function parseMultipleFiles(
  req: Request,
  maxFiles: number = BATCH_MAX_FILES,
): Promise<ParsedUploadFile[]> {
  assertMultipart(req)

  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers })
    const collected: ParsedUploadFile[] = []
    const pending: Promise<void>[] = []
    let count = 0

    busboy.on('file', (_fieldname, stream, info) => {
      if (count >= maxFiles) {
        stream.resume()
        return
      }
      count++
      pending.push(
        collectFileStream(stream, info).then((file) => {
          collected.push(file)
        }),
      )
    })

    busboy.on('error', reject)
    busboy.on('finish', () => {
      void Promise.all(pending)
        .then(() => resolve(collected))
        .catch(reject)
    })

    feedBusboy(req as NhostRequest, busboy)
  })
}
