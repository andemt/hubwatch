export const Json = {
  /** Reads a top-level boolean property from a JSON string, or null. */
  bool(raw: string, key: string): boolean | null {
    try {
      const value = JSON.parse(raw)?.[key]
      return typeof value === 'boolean' ? value : null
    } catch {
      return null
    }
  },
  /** Reads a top-level string property from a JSON string, or null. */
  str(raw: string, key: string): string | null {
    try {
      const value = JSON.parse(raw)?.[key]
      return typeof value === 'string' ? value : null
    } catch {
      return null
    }
  },
}
