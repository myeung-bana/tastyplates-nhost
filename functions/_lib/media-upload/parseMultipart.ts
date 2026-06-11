import type { Request } from 'express'
import Busboy from 'busboy'

import type { ParsedUploadFile } from './types'
import { BATCH_MAX_FILES } from './config'

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

/** Parse the first file field from a multipart request. */
export function parseSingleFile(req: Request): Promise<ParsedUploadFile> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers })
    let resolved = false

    busboy.on('file', (_fieldname, stream, info) => {
      if (resolved) {
        stream.resume()
        return
      }
      void collectFileStream(stream, info)
        .then((file) => {
          resolved = true
          resolve(file)
        })
        .catch(reject)
    })

    busboy.on('error', reject)
    busboy.on('finish', () => {
      if (!resolved) reject(new Error('No file received'))
    })

    req.pipe(busboy)
  })
}

/** Parse up to `maxFiles` file fields from a multipart request. */
export function parseMultipleFiles(
  req: Request,
  maxFiles: number = BATCH_MAX_FILES,
): Promise<ParsedUploadFile[]> {
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

    req.pipe(busboy)
  })
}
