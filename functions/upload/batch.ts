import type { Request, Response } from 'express'

import { getUserId, requireAuth } from '../_lib/auth'
import { BATCH_MAX_FILES } from '../_lib/media-upload/config'
import { parseMultipleFiles } from '../_lib/media-upload/parseMultipart'
import { processMediaUpload } from '../_lib/media-upload/processUpload'
import { fail, ok } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)
    const files = await parseMultipleFiles(req, BATCH_MAX_FILES)

    if (files.length === 0) {
      return fail(res, 'No files received', 400)
    }

    const results = await Promise.allSettled(
      files.map((file) => processMediaUpload(file, userId, { compress: true })),
    )

    const successful = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof processMediaUpload>>> => r.status === 'fulfilled')
      .map((r) => ({
        fileUrl: r.value.fileUrl,
        filePath: r.value.filePath,
        mediaUuid: r.value.mediaUuid,
        deduped: r.value.deduped,
        filename: r.value.filename,
      }))

    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => ({ error: String(r.reason) }))

    ok(res, { files: successful, errors })
  } catch (error) {
    console.error('[upload/batch]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}
