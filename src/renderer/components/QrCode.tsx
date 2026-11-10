import { useMemo } from 'react'
import { qrMatrix, qrPath } from '../panel/qrPath'

export function QrCode({
  text,
  size = 168,
  label,
}: {
  text: string
  size?: number
  label: string
}): JSX.Element {
  const { n, d } = useMemo(() => {
    const grid = qrMatrix(text)
    return { n: grid.length, d: qrPath(grid) }
  }, [text])
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      data-testid="remote-qr"
    >
      <rect width={n} height={n} fill="var(--qr-paper)" />
      <path d={d} fill="var(--qr-ink)" />
    </svg>
  )
}
