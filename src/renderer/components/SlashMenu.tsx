import { InlineMenu, type InlineMenuItem } from './InlineMenu'
import type { SlashStep } from '../input/slash'

interface Props {
  id: string
  step: SlashStep
  items: InlineMenuItem[]
  selected: number
  onPick: (item: InlineMenuItem) => void
}

const TITLE: Record<SlashStep['kind'], string | undefined> = {
  commands: undefined,
  model: 'Модель',
  effort: 'Усилие'
}

/** The command list above the input, and the second list for /model and /effort. */
export function SlashMenu({ id, step, items, selected, onPick }: Props): JSX.Element | null {
  return (
    <InlineMenu
      id={id}
      items={items}
      selected={selected}
      onPick={onPick}
      testId="slash-menu"
      itemTestId="slash-item"
      title={TITLE[step.kind]}
    />
  )
}
