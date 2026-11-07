import type { QclodApi } from '../preload'

declare global {
  interface Window {
    qclod: QclodApi
  }
}

export {}
