import {BackButton} from 'components/BackButton'
import {solNative} from 'lib/SolNative'
import {acceptAIResult, cancelAIResult, type AIState} from 'lib/ai-session'
import {observer} from 'mobx-react-lite'
import {useEffect, useRef, useState} from 'react'
import {ScrollView, Text, TextInput, TouchableOpacity, View} from 'react-native'
import {useStore} from 'store'
import {Widget} from 'stores/ui.store'
import {v4 as uuidv4} from 'uuid'

export const AIWidget = observer(() => {
  const {ui} = useStore()
  const [prompt, setPrompt] = useState('')
  const [state, setState] = useState<AIState>({
    requestId: null,
    response: '',
    error: null,
  })
  const [available, setAvailable] = useState(false)
  const [checked, setChecked] = useState(false)
  const [availabilityError, setAvailabilityError] = useState<string | null>(
    null,
  )
  const active = useRef<string | null>(null)
  useEffect(() => {
    let mounted = true
    solNative.turnOffEnterListener()
    solNative.turnOffVerticalArrowsListeners()
    void solNative
      .getAIProviders()
      .then(providers => {
        if (mounted) {
          setAvailable(
            providers.some(
              entry => entry.provider === 'claude' && entry.available,
            ),
          )
          setChecked(true)
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          setAvailabilityError(
            error instanceof Error ? error.message : String(error),
          )
          setChecked(true)
        }
      })
    return () => {
      mounted = false
      solNative.turnOnEnterListener()
      solNative.turnOnVerticalArrowsListeners()
      if (active.current) solNative.cancelAI(active.current)
      active.current = null
    }
  }, [])

  const cancel = () => {
    if (active.current) solNative.cancelAI(active.current)
    active.current = null
    setState(previous => cancelAIResult(previous))
  }
  const send = async () => {
    const text = prompt.trim()
    if (!text || !available || active.current) return
    const requestId = uuidv4()
    active.current = requestId
    setState({requestId, response: '', error: null})
    try {
      const result = await solNative.runAI({
        provider: 'claude',
        prompt: text,
        requestId,
      })
      if (active.current === requestId) {
        active.current = null
        setState(previous => acceptAIResult(previous, requestId, result))
      }
    } catch (error) {
      if (active.current === requestId) {
        active.current = null
        setState(previous =>
          acceptAIResult(
            previous,
            requestId,
            error instanceof Error ? error : new Error(String(error)),
          ),
        )
      }
    }
  }

  return (
    <View className="flex-1 p-4 gap-3 bg-neutral-100 dark:bg-neutral-800">
      <View className="flex-row items-center gap-3">
        <BackButton onPress={() => ui.focusWidget(Widget.SEARCH)} />
        <Text className="text text-lg font-semibold">Ask Claude</Text>
      </View>
      <Text className="text-xs darker-text">
        Single-turn request · local CLI · tools off · text only. No clipboard or
        files are sent.
      </Text>
      <Text className="text-xs darker-text">
        {availabilityError
          ? `Provider check failed: ${availabilityError}`
          : !checked
            ? 'Checking Claude CLI…'
            : available
              ? 'Claude CLI found · Codex not yet supported safely'
              : 'Claude CLI not found · Codex not yet supported safely'}
      </Text>
      <TextInput
        multiline
        value={prompt}
        onChangeText={setPrompt}
        placeholder="Ask a question…"
        className="text p-3 min-h-24 rounded-lg subBg border border-color"
      />
      <View className="flex-row gap-3">
        <TouchableOpacity
          disabled={!available || !prompt.trim() || !!state.requestId}
          onPress={send}
        >
          <Text className="text-accent">Send</Text>
        </TouchableOpacity>
        {!!state.requestId && (
          <TouchableOpacity onPress={cancel}>
            <Text className="text-accent">Cancel</Text>
          </TouchableOpacity>
        )}
      </View>
      {!!state.requestId && (
        <Text className="text darker-text">Waiting for Claude…</Text>
      )}
      {!!state.error && <Text className="text-red-600">{state.error}</Text>}
      <ScrollView className="flex-1">
        <Text selectable className="text">
          {state.response}
        </Text>
      </ScrollView>
    </View>
  )
})
