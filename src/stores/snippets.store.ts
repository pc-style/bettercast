import {solNative} from 'lib/SolNative'
import {
  parseSnippetState,
  removeSnippet,
  saveSnippet,
  type Snippet,
} from 'lib/snippets'
import {makeAutoObservable, toJS} from 'mobx'
import {getRuntimeStatePath} from './config'
import {writePersistedStore} from './persisted-config'
import {ItemType, Widget} from './ui.store'
import type {IRootStore} from 'store'

export type SnippetsStore = ReturnType<typeof createSnippetsStore>

export function createSnippetsStore(root: IRootStore) {
  const readState = () => {
    try {
      const path = getRuntimeStatePath()
      const exists = solNative.exists(path)
      const raw = exists ? solNative.readFile(path) : null
      if (exists && raw === null) throw new Error('Unreadable state')
      return parseSnippetState(raw)
    } catch {
      throw new Error('Could not read snippets from Bettercast state')
    }
  }

  const store = makeAutoObservable({
    snippets: [] as Snippet[],
    loaded: false,
    loadError: null as string | null,
    editing: null as Snippet | null,
    get items(): Item[] {
      return store.snippets.map(snippet => ({
        id: `snippet-${snippet.id}`,
        name: snippet.name,
        icon: '✎',
        subName: 'Paste snippet',
        type: ItemType.CONFIGURATION,
        callback: () => solNative.pasteToFrontmostApp(snippet.text),
      }))
    },
    save(snippet: Snippet) {
      if (!store.loaded) return false
      try {
        readState()
      } catch {
        store.loadError = 'Could not read snippets from Bettercast state'
        store.loaded = false
        return false
      }
      const next = saveSnippet(store.snippets, snippet)
      if (!writePersistedStore('snippets', {snippets: toJS(next)})) {
        solNative.showToast('Could not save snippet', 'error')
        return false
      }
      store.snippets = next
      return true
    },
    remove(id: string) {
      if (!store.loaded) return false
      try {
        readState()
      } catch {
        store.loadError = 'Could not read snippets from Bettercast state'
        store.loaded = false
        return false
      }
      const next = removeSnippet(store.snippets, id)
      if (!writePersistedStore('snippets', {snippets: toJS(next)})) {
        solNative.showToast('Could not delete snippet', 'error')
        return false
      }
      store.snippets = next
      return true
    },
    open(snippet: Snippet | null = null) {
      store.editing = snippet
      root.ui.focusWidget(Widget.SNIPPETS)
    },
  })
  try {
    store.snippets = readState()
    store.loaded = true
  } catch {
    store.loadError = 'Could not read snippets from Bettercast state'
  }
  return store
}
