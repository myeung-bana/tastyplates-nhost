export interface MediaUploadResult {
  fileUrl: string
  filePath: string
  mediaUuid: string | null
  deduped: boolean
  filename?: string
}

export interface ParsedUploadFile {
  buffer: Buffer
  mimetype: string
  filename: string
}
