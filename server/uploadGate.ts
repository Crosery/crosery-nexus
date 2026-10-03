export class UploadGateBusyError extends Error {
  readonly code = 'UPLOAD_BUSY'
  constructor() {
    super('已有凭据上传任务正在执行，请稍后重试')
    this.name = 'UploadGateBusyError'
  }
}

export class UploadGate {
  private active = false

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active) throw new UploadGateBusyError()
    this.active = true
    try {
      return await task()
    } finally {
      this.active = false
    }
  }
}
