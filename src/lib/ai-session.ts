export type AIState = {
  requestId: string | null
  response: string
  error: string | null
}

export function acceptAIResult(
  state: AIState,
  requestId: string,
  result: {text: string} | Error,
): AIState {
  if (state.requestId !== requestId) return state
  return result instanceof Error
    ? {
        requestId: null,
        response: '',
        error: result.message || 'Claude failed to respond',
      }
    : {requestId: null, response: result.text, error: null}
}

export function cancelAIResult(state: AIState): AIState {
  return {...state, requestId: null}
}
