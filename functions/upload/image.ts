import type { Request, Response } from 'express'

import { getUserId, requireAuth } from '../_lib/auth'
import { fail, ok } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const { parseSingleFile } = await import('../_lib/media-upload/parseMultipart')
    const { processMediaUpload } = await import('../_lib/media-upload/processUpload')

    const userId = getUserId(payload)
    const file = await parseSingleFile(req)
    const result = await processMediaUpload(file, userId, { compress: true })

    ok(res, {
      fileUrl: result.fileUrl,
      filePath: result.filePath,
      mediaUuid: result.mediaUuid,
      deduped: result.deduped,
    })
  } catch (error) {
    console.error('[upload/image]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}
