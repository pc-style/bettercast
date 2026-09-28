import {expect, test} from 'bun:test'
import {acceptAIResult, cancelAIResult} from './ai-session'
import {
  parseSnippetState,
  readSnippets,
  removeSnippet,
  saveSnippet,
  searchSnippets,
} from './snippets'

test('snippet CRUD preserves IDs, text and other entries', () => {
  const first = {id: 'a', name: 'Address', text: 'Line one\nLine two'}
  const second = {id: 'b', name: 'Greeting', text: 'Hello'}
  const created = saveSnippet(saveSnippet([], first), second)
  const edited = saveSnippet(created, {
    ...first,
    name: 'Postal address',
    text: 'Line three',
  })
  expect(edited).toEqual([
    {id: 'a', name: 'Postal address', text: 'Line three'},
    second,
  ])
  expect(removeSnippet(edited, 'a')).toEqual([second])
  expect(
    readSnippets([
      first,
      {id: 'bad', name: '', text: 'x'},
      {id: 4, name: 'no', text: 'x'},
    ]),
  ).toEqual([first])
})

test('snippet search finds names and bodies without changing saved order', () => {
  const snippets = [
    {id: 'a', name: 'Invoice', text: 'Send to Warsaw'},
    {id: 'b', name: 'Warsaw address', text: 'Street 1'},
    {id: 'c', name: 'Greeting', text: 'Hello'},
  ]
  expect(searchSnippets(snippets, ' WARSAW ')).toEqual(snippets.slice(0, 2))
  expect(searchSnippets(snippets, 'street')).toEqual([snippets[1]])
  expect(searchSnippets(snippets, 'missing')).toEqual([])
  expect(searchSnippets(snippets, '  ')).toEqual(snippets)
})

test('absent state is empty, but corrupt state cannot hydrate as empty snippets', () => {
  const snippet = {id: 'a', name: 'Address', text: 'Line one'}
  expect(parseSnippetState(null)).toEqual([])
  expect(parseSnippetState(JSON.stringify({clipboard: {items: []}}))).toEqual(
    [],
  )
  expect(
    parseSnippetState(JSON.stringify({snippets: {snippets: [snippet]}})),
  ).toEqual([snippet])
  expect(() => parseSnippetState('{private text')).toThrow(
    'Invalid Bettercast state',
  )
  expect(() =>
    parseSnippetState(
      JSON.stringify({snippets: {snippets: [{...snippet, text: null}]}}),
    ),
  ).toThrow('Invalid snippet entry')
  expect(() =>
    parseSnippetState(JSON.stringify({snippets: {snippets: null}})),
  ).toThrow('Invalid snippets list')
})

test('AI ignores late completion after cancel or replacement', () => {
  const waiting = {requestId: 'old', response: '', error: null}
  const cancelled = cancelAIResult(waiting)
  expect(acceptAIResult(cancelled, 'old', {text: 'late'})).toEqual(cancelled)
  const replacement = {...waiting, requestId: 'new'}
  expect(acceptAIResult(replacement, 'old', new Error('late failure'))).toEqual(
    replacement,
  )
  expect(acceptAIResult(replacement, 'new', {text: 'real answer'})).toEqual({
    requestId: null,
    response: 'real answer',
    error: null,
  })
})

test('AI surfaces a real error and clears pending state', () => {
  expect(
    acceptAIResult(
      {requestId: 'a', response: '', error: null},
      'a',
      new Error('not signed in'),
    ),
  ).toEqual({requestId: null, response: '', error: 'not signed in'})
})
