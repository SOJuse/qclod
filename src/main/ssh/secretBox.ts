/**
 * Server passwords sealed by the OS (decision 6): DPAPI on Windows, the
 * Keychain on a Mac, through Electron's safeStorage (synchronous in 33).
 * Tests swap in their own box.
 */
import { safeStorage } from 'electron'

export interface SecretBox {
  available(): boolean
  /** base64 of the sealed bytes. */
  seal(plain: string): string
  open(sealed: string): string
}

export function electronSecretBox(): SecretBox {
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    seal: (plain) => safeStorage.encryptString(plain).toString('base64'),
    open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  }
}
