import { formatSizeRu } from '../../../shared/format'
import type { VoiceModelId, VoiceModelView } from '../../../shared/voice'

export { formatSizeRu }

/** The dictionary's hint, word for word (its arrow is prose, not an icon). */
export const DICTIONARY_HINT =
  'Что модель пишет по-русски → как это должно выглядеть. Окончания учитываются: «Клода» станет «Claude».'

export type ModelCardAction = 'download' | 'cancel' | 'retry' | 'delete' | 'use'

export interface ModelCardView {
  status: string
  actions: ModelCardAction[]
  selected: boolean
  disabledReason?: string
}

/** One model's card in «Голос»: what it says and which buttons it has. */
export function modelCardView(v: VoiceModelView, selected: VoiceModelId): ModelCardView {
  const s = v.state
  const chosen = v.id === selected
  const reason = !v.available && v.unavailableReason ? { disabledReason: v.unavailableReason } : {}
  switch (s.kind) {
    case 'absent':
      return { status: 'Не скачана', actions: ['download'], selected: false, ...reason }
    case 'downloading': {
      const p = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0
      const status = s.total > 0 ? `Скачиваю: ${p}% (${formatSizeRu(s.done)} из ${formatSizeRu(s.total)})` : 'Скачиваю: 0%'
      return { status, actions: ['cancel'], selected: false }
    }
    case 'verifying':
      return { status: 'Проверяю файлы…', actions: [], selected: false }
    case 'extracting':
      return { status: 'Распаковываю…', actions: [], selected: false }
    case 'ready':
      return chosen
        ? { status: 'Готова', actions: ['delete'], selected: true }
        : { status: 'Готова', actions: ['use', 'delete'], selected: false }
    case 'error':
      return { status: s.message, actions: ['retry'], selected: false, ...reason }
  }
}
