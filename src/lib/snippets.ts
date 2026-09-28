export type Snippet = {id: string; name: string; text: string}

export function readSnippets(value: unknown): Snippet[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is Snippet =>
      item != null &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.text === 'string' &&
      item.name.trim().length > 0 &&
      item.text.length > 0,
  )
}

export function parseSnippetState(raw: string | null): Snippet[] {
  if (raw === null) return []
  let state: unknown
  try {
    state = JSON.parse(raw)
  } catch {
    throw new Error('Invalid Bettercast state')
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Invalid Bettercast state')
  }
  const value = (state as Record<string, unknown>).snippets
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid snippets state')
  }
  const entries = (value as Record<string, unknown>).snippets
  if (!Array.isArray(entries)) throw new Error('Invalid snippets list')
  const snippets = readSnippets(entries)
  if (snippets.length !== entries.length)
    throw new Error('Invalid snippet entry')
  return snippets
}

export function saveSnippet(snippets: Snippet[], snippet: Snippet): Snippet[] {
  const existing = snippets.findIndex(item => item.id === snippet.id)
  if (existing < 0) return [...snippets, snippet]
  return snippets.map(item => (item.id === snippet.id ? snippet : item))
}

export function removeSnippet(snippets: Snippet[], id: string): Snippet[] {
  return snippets.filter(item => item.id !== id)
}
