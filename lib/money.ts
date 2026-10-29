// Display helpers for integer sen. Integer arithmetic only, no floats.

export function formatSen(sen: number): string {
  const sign = sen < 0 ? '-' : ''
  const abs = Math.abs(sen)
  const ringgit = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}RM ${ringgit}.${String(abs % 100).padStart(2, '0')}`
}

/** bigint from Prisma -> number for JSON. Sen amounts stay far below 2^53. */
export function toSen(value: bigint | null | undefined): number {
  return value == null ? 0 : Number(value)
}
