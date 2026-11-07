import { contextBridge } from 'electron'

// The real channel surface arrives in Task 4. Until then the bridge exists
// only so the renderer can prove it is isolated.
contextBridge.exposeInMainWorld('qclod', {
  version: '0.1.0'
})
