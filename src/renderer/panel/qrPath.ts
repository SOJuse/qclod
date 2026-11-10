import { encode } from 'uqr'

/** One `d` for a `<path>`: every dark cell is a unit square, rows left to right, top to bottom. */
export function qrPath(grid: boolean[][]): string {
  let d = ''
  grid.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`
    })
  })
  return d
}

export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: 2 }).data
}
