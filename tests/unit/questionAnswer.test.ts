import { describe, expect, test } from 'vitest'
import {
  NOTES_ANNOTATIONS_SINCE,
  PLAN_EDIT_SINCE,
  denialText,
  encodeQuestionAnswer,
  inlineAnswer,
  notesModeFor,
  planEditModeFor,
  planSendBackText,
  planWithComment
} from '../../src/main/agent/questionAnswer'

const input = {
  questions: [
    {
      question: 'Q',
      header: 'Вопрос',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
        { label: 'C', description: '' }
      ],
      multiSelect: true
    },
    {
      question: 'R',
      header: 'Ещё',
      options: [{ label: 'Да', description: '' }],
      multiSelect: false
    }
  ],
  metadata: { source: 'агент' }
}

describe('encodeQuestionAnswer', () => {
  test('annotations: ответ как есть, заметка в annotations[вопрос].notes, ввод на месте', () => {
    const out = encodeQuestionAnswer(input, { Q: 'A', R: 'Да' }, { Q: 'быстро' }, 'annotations')
    expect(out['answers']).toEqual({ Q: 'A', R: 'Да' })
    expect(out['annotations']).toEqual({ Q: { notes: 'быстро' } })
    expect(out['questions']).toBe(input.questions)
    expect(out['metadata']).toEqual({ source: 'агент' })
  })

  test('inline: заметка дописана к ответу, annotations нет', () => {
    const out = encodeQuestionAnswer(input, { Q: 'A', R: 'Да' }, { Q: 'быстро' }, 'inline')
    expect(out['answers']).toEqual({ Q: 'A — быстро', R: 'Да' })
    expect(out).not.toHaveProperty('annotations')
    expect(out['questions']).toBe(input.questions)
  })

  test('несколько вариантов: заметка относится ко всему выбору', () => {
    expect(encodeQuestionAnswer(input, { Q: 'A, C', R: 'Да' }, { Q: 'оба' }, 'inline')['answers']).toEqual({
      Q: 'A, C — оба',
      R: 'Да'
    })
    expect(
      encodeQuestionAnswer(input, { Q: 'A, C', R: 'Да' }, { Q: 'оба' }, 'annotations')['annotations']
    ).toEqual({ Q: { notes: 'оба' } })
  })

  test('заметка к своему тексту (не вариант) отброшена в обоих режимах', () => {
    const own = { Q: 'что-то своё', R: 'Да' }
    const inline = encodeQuestionAnswer(input, own, { Q: 'заметка' }, 'inline')
    expect(inline['answers']).toEqual(own)
    expect(inline).not.toHaveProperty('annotations')
    const annotated = encodeQuestionAnswer(input, own, { Q: 'заметка' }, 'annotations')
    expect(annotated['answers']).toEqual(own)
    expect(annotated).not.toHaveProperty('annotations')
    // A list with one part that is no option is free text too.
    const mixed = encodeQuestionAnswer(input, { Q: 'A, Z', R: 'Да' }, { Q: 'заметка' }, 'inline')
    expect(mixed['answers']).toEqual({ Q: 'A, Z', R: 'Да' })
  })

  test('пустая заметка — нет ни annotations, ни суффикса', () => {
    for (const mode of ['inline', 'annotations'] as const) {
      const out = encodeQuestionAnswer(input, { Q: 'A', R: 'Да' }, { Q: '' }, mode)
      expect(out['answers']).toEqual({ Q: 'A', R: 'Да' })
      expect(out).not.toHaveProperty('annotations')
      expect(encodeQuestionAnswer(input, { Q: 'A', R: 'Да' }, {}, mode)).not.toHaveProperty('annotations')
    }
  })

  test('заметка к вопросу, которого нет, не доходит', () => {
    const out = encodeQuestionAnswer(input, { Q: 'A', R: 'Да' }, { Чужой: 'x' }, 'annotations')
    expect(out).not.toHaveProperty('annotations')
  })

  test('inlineAnswer: «Вариант — комментарий»', () => {
    expect(inlineAnswer('A', 'быстро')).toBe('A — быстро')
  })
})

describe('режимы по версии CLI', () => {
  test('с проверенной версии — annotations и updatedInput, ниже или неизвестно — запасные пути', () => {
    expect(NOTES_ANNOTATIONS_SINCE).toBe('2.1.317')
    expect(PLAN_EDIT_SINCE).toBe('2.1.317')
    for (const version of ['2.1.317', '2.1.318', '2.2.0', '3.0.0']) {
      expect(notesModeFor(version)).toBe('annotations')
      expect(planEditModeFor(version)).toBe('updatedInput')
    }
    for (const version of ['2.1.316', '2.1.200', '1.9.999', '', 'не версия', null, undefined]) {
      expect(notesModeFor(version)).toBe('inline')
      expect(planEditModeFor(version)).toBe('sendBack')
    }
  })
})

describe('план с правкой и комментарием (S2-R8)', () => {
  test('planWithComment: комментарий под планом, без комментария — план как есть', () => {
    expect(planWithComment('1. шаг', 'коротко')).toBe('1. шаг\n\nКомментарий пользователя: коротко')
    expect(planWithComment('1. шаг')).toBe('1. шаг')
  })

  test('planSendBackText: правка, правка с комментарием, один комментарий', () => {
    expect(planSendBackText('1. другой')).toBe(
      'Пользователь поправил план. Не начинай работу — предложи этот вариант снова через ExitPlanMode:\n1. другой'
    )
    expect(planSendBackText('1. другой', 'коротко')).toBe(
      'Пользователь поправил план. Не начинай работу — предложи этот вариант снова через ExitPlanMode:\n1. другой' +
        '\n\nКомментарий пользователя: коротко'
    )
    expect(planSendBackText(undefined, 'коротко')).toBe(
      'Пользователь одобрит план с учётом комментария. Не начинай работу — учти комментарий и предложи план ' +
        'снова через ExitPlanMode.\n\nКомментарий: коротко'
    )
  })
})

describe('denialText', () => {
  test('отказ без причины и с причиной — явный запрет обходить', () => {
    expect(denialText()).toBe(
      'Пользователь запретил этот вызов. Не выполняй это действие другим способом и не обходи запрет — ' +
        'спроси пользователя, если нужно.'
    )
    expect(denialText('не трогай main')).toBe(
      'Пользователь запретил этот вызов. Причина: не трогай main. Не выполняй это действие другим способом ' +
        'и не обходи запрет — спроси пользователя, если нужно.'
    )
    // A reason that already ends a sentence gets no second full stop.
    expect(denialText('не трогай main!')).toContain('Причина: не трогай main! Не выполняй')
    expect(denialText('не трогай main.')).toContain('Причина: не трогай main. Не выполняй')
  })
})
