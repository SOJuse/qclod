/** The voice button's state (этап 5). */
export type VoiceButtonState = 'off' | 'listening' | 'download' | 'loading' | 'unavailable'

/** One item of the menu the voice button opens. Этап 5 may add optional fields. */
export interface VoiceMenuItem {
  id: string
  label: string
  onSelect(): void
}

/** What the composer's voice button is given (этап 5 fills it in). */
export interface VoiceControls {
  state: VoiceButtonState
  title: string
  /** 0..1: скачивание модели (download) или загрузка (loading). */
  progress?: number
  /** Серый текст незаконченной фразы; '' — нет. */
  tentative: string
  /** Пункты, которые кнопка показывает по клику в состояниях download и unavailable. */
  menu: VoiceMenuItem[]
  press(): void
  release(): void
  /** Composer сообщает, где курсор, — туда встанет следующая фраза. */
  caretMoved(caret: number): void
  /** После вставки: куда поставить курсор; rev растёт с каждой вставкой. */
  caretAfterInsert?: { at: number; rev: number }
  /** Этап 5: the press opened the menu (download, unavailable); the composer draws it while true. */
  menuOpen?: boolean
  closeMenu?(): void
}

// — Stage 5: voice contract (models, events, settings, texts).

export type VoiceModelId = 'gigaam-v3' | 'parakeet-v3' | 'whisper-turbo-cuda'
export const VOICE_MODEL_IDS: readonly VoiceModelId[] = Object.freeze([
  'gigaam-v3',
  'parakeet-v3',
  'whisper-turbo-cuda'
] as const)

export interface VoiceReplacement {
  from: string
  to: string
}

/** replacements: null — the standard dictionary (DEFAULT_REPLACEMENTS). */
export interface VoiceSettings {
  model: VoiceModelId
  replacements: VoiceReplacement[] | null
}

export type ModelInstallState =
  | { kind: 'absent' }
  | { kind: 'downloading'; done: number; total: number }
  | { kind: 'verifying' }
  | { kind: 'extracting' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

export interface VoiceModelView {
  id: VoiceModelId
  state: ModelInstallState
  available: boolean
  unavailableReason?: string
  /** What the person can do about it: «Голос» shows the button (vc-redist — Microsoft's VC++ installer, I4). */
  fix?: 'vc-redist'
}

export interface VoiceModelsSnapshot {
  models: VoiceModelView[]
  micAccess: 'granted' | 'denied' | 'unknown'
}

export type VoiceErrorCode =
  | 'no-model'
  | 'mic-denied'
  | 'mic-missing'
  | 'mic-busy'
  | 'mic-lost'
  | 'engine-crashed'
  | 'engine-gave-up'
  | 'ort-conflict'
  | 'engine-missing'
  | 'load-failed'
  | 'gpu-fallback'
  | 'gpu-failed'

export type VoiceEvent =
  | { session: string; kind: 'loading' }
  | { session: string; kind: 'ready' }
  | { session: string; kind: 'partial'; phrase: number; text: string }
  | { session: string; kind: 'final'; phrase: number; text: string; joinsPrevious: boolean }
  | { session: string; kind: 'done' }
  | { session: string; kind: 'error'; code: VoiceErrorCode }

export function voiceErrorText(code: VoiceErrorCode, platform: string): string {
  const mac = platform === 'darwin'
  switch (code) {
    case 'no-model':
      return 'Сначала скачайте модель голоса.'
    case 'mic-denied':
      return mac
        ? 'macOS не даёт Qclod микрофон. Включите доступ: Системные настройки → Конфиденциальность и безопасность → Микрофон.'
        : 'Windows не даёт Qclod микрофон. Включите доступ: Параметры → Конфиденциальность и защита → Микрофон.'
    case 'mic-missing':
      return 'Микрофон не найден. Подключите его и попробуйте снова.'
    case 'mic-busy':
      return 'Микрофон занят другой программой.'
    case 'mic-lost':
      return 'Микрофон отключился. То, что успели сказать, осталось в поле.'
    case 'engine-crashed':
      return 'Голосовой движок упал. Нажмите микрофон, чтобы запустить его снова.'
    case 'engine-gave-up':
      return mac
        ? 'Голосовой движок не запускается.'
        : 'Голосовой движок не запускается. Пока можно диктовать через Windows (Win+H).'
    case 'ort-conflict':
      return 'Голосовой движок не запустился: мешает другая версия onnxruntime.dll в системе. Пока можно диктовать через Windows (Win+H).'
    case 'engine-missing':
      return mac
        ? 'Голосовой движок не загрузился: файлы установки Qclod повреждены или их не пускает антивирус. Переустановите Qclod.'
        : 'Голосовой движок не загрузился: файлы установки Qclod повреждены или их не пускает антивирус. Переустановите Qclod. Пока можно диктовать через Windows (Win+H).'
    case 'load-failed':
      return 'Не удалось загрузить модель голоса. Удалите её в настройках «Голос» и скачайте снова.'
    case 'gpu-fallback':
      return 'Whisper не запустился на видеокарте. Пока распознаёт GigaAM.'
    case 'gpu-failed':
      return 'Whisper не запустился на видеокарте. Скачайте GigaAM в настройках «Голос».'
  }
}

export interface VoiceModelInfo {
  title: string
  blurb: string
  meta: string
  /** Decimal bytes (МБ = 10^6), as the models' store and its messages count. */
  downloadBytes: number
  needsNvidia: boolean
  platforms: readonly string[]
}

const ALL_PLATFORMS = ['win32', 'darwin', 'linux'] as const

export const VOICE_MODEL_INFO: Record<VoiceModelId, VoiceModelInfo> = {
  'gigaam-v3': {
    title: 'GigaAM v3',
    blurb:
      'По умолчанию. Лучший русский, ставит знаки препинания и заглавные. Английские слова пишет по-русски — их поправит словарь ниже.',
    meta: '232 МБ · процессор · около 0,3 ГБ памяти',
    downloadBytes: 232e6,
    needsNvidia: false,
    platforms: ALL_PLATFORMS
  },
  'parakeet-v3': {
    title: 'Parakeet v3',
    blurb:
      'Точнее на русском и чаще пишет английские термины латиницей. Тяжелее и медленнее на длинных фразах.',
    meta: '670 МБ · процессор · около 0,9 ГБ памяти',
    downloadBytes: 670e6,
    needsNvidia: false,
    platforms: ALL_PLATFORMS
  },
  'whisper-turbo-cuda': {
    title: 'Whisper large-v3-turbo',
    blurb: 'Точнее с английскими терминами (нужна видеокарта NVIDIA)',
    meta: 'скачать 1,3 ГБ · на диске 2,3 ГБ · видеокарта',
    downloadBytes: 1.3e9,
    needsNvidia: true,
    platforms: ['win32']
  }
}
