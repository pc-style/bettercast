import {BackButton} from 'components/BackButton'
import {solNative} from 'lib/SolNative'
import {searchSnippets} from 'lib/snippets'
import {observer} from 'mobx-react-lite'
import {useEffect, useState} from 'react'
import {ScrollView, Text, TextInput, TouchableOpacity, View} from 'react-native'
import {useStore} from 'store'
import {Widget} from 'stores/ui.store'
import {v4 as uuidv4} from 'uuid'

export const SnippetsWidget = observer(() => {
  const {ui, snippets} = useStore()
  const [editing, setEditing] = useState(snippets.editing)
  const [name, setName] = useState(editing?.name ?? '')
  const [body, setBody] = useState(editing?.text ?? '')
  const [query, setQuery] = useState('')
  const visible = searchSnippets(snippets.snippets, query)
  useEffect(() => {
    solNative.turnOffEnterListener()
    solNative.turnOffVerticalArrowsListeners()
    return () => {
      solNative.turnOnEnterListener()
      solNative.turnOnVerticalArrowsListeners()
    }
  }, [])
  const reset = () => {
    setEditing(null)
    setName('')
    setBody('')
  }
  return (
    <View className="flex-1 p-4 gap-3 bg-neutral-100 dark:bg-neutral-800">
      <View className="flex-row items-center gap-3">
        <BackButton onPress={() => ui.focusWidget(Widget.SEARCH)} />
        <Text className="text text-lg font-semibold">Snippets</Text>
      </View>
      {!!snippets.loadError && (
        <Text className="text-red-600">
          Snippets are read-only: {snippets.loadError}. Existing data was not
          replaced.
        </Text>
      )}
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Name"
        className="text p-2 subBg rounded-lg border border-color"
      />
      <TextInput
        multiline
        value={body}
        onChangeText={setBody}
        placeholder="Text to paste"
        className="text p-2 min-h-24 subBg rounded-lg border border-color"
      />
      <View className="flex-row gap-4">
        <TouchableOpacity
          disabled={!snippets.loaded || !name.trim() || !body}
          onPress={() => {
            if (
              snippets.save({
                id: editing?.id ?? uuidv4(),
                name: name.trim(),
                text: body,
              })
            )
              reset()
          }}
        >
          <Text className="text-accent">
            {editing ? 'Save changes' : 'Add snippet'}
          </Text>
        </TouchableOpacity>
        {editing && (
          <TouchableOpacity onPress={reset}>
            <Text className="text-accent">Cancel edit</Text>
          </TouchableOpacity>
        )}
      </View>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search saved snippets…"
        accessibilityLabel="Search saved snippets"
        className="text p-2 subBg rounded-lg border border-color"
      />
      <Text className="darker-text text-xs">
        Pasting a snippet replaces the current clipboard contents.
      </Text>
      <ScrollView className="flex-1">
        {visible.length === 0 && (
          <Text className="darker-text text-sm py-3">
            {query.trim() ? 'No matching snippets.' : 'No saved snippets yet.'}
          </Text>
        )}
        {visible.map(snippet => (
          <View
            key={snippet.id}
            className="flex-row items-center gap-3 py-2 border-b border-color"
          >
            <Text className="text flex-1" numberOfLines={1}>
              {snippet.name}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Paste ${snippet.name}`}
              onPress={() => solNative.pasteToFrontmostApp(snippet.text)}
            >
              <Text className="text-accent">Paste</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setEditing(snippet)
                setName(snippet.name)
                setBody(snippet.text)
              }}
            >
              <Text className="text-accent">Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() =>
                ui.confirm(`Delete snippet: ${snippet.name}?`, () => {
                  if (snippets.remove(snippet.id) && editing?.id === snippet.id)
                    reset()
                })
              }
            >
              <Text className="text-red-600">Delete</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </View>
  )
})
