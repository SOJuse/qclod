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
}
