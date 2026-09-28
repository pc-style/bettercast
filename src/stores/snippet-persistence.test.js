import {expect, mock, test} from 'bun:test'

let exists = true
let contents = '{broken'
let unreadable = false
const writes = []

mock.module('lib/SolNative', () => ({
  solNative: {
    userName: () => 'test-user',
    exists: () => exists,
    readFile: () => {
      if (unreadable) throw new Error('private clipboard contents')
      return contents
    },
    writeFile: (_path, value) => {
      writes.push(value)
      return true
    },
  },
}))

const {writeJsonRuntimeState} = await import('./config')

test('malformed state is never overwritten by the shared writer', () => {
  expect(writeJsonRuntimeState({snippets: {snippets: []}})).toBe(false)
  expect(writes).toHaveLength(0)
  contents = '42'
  expect(writeJsonRuntimeState({snippets: {snippets: []}})).toBe(false)
  expect(writes).toHaveLength(0)
})

test('transient unreadable state is not mistaken for an absent file', () => {
  contents = null
  expect(writeJsonRuntimeState({snippets: {snippets: []}})).toBe(false)
  unreadable = true
  expect(writeJsonRuntimeState({snippets: {snippets: []}})).toBe(false)
  unreadable = false
  expect(writes).toHaveLength(0)
})

test('absent or valid state remains writable', () => {
  exists = false
  expect(writeJsonRuntimeState({snippets: {snippets: []}})).toBe(true)
  exists = true
  contents = '{"snippets":{"snippets":[]}}'
  expect(
    writeJsonRuntimeState({
      snippets: {snippets: [{id: 'a', name: 'A', text: 'B'}]},
    }),
  ).toBe(true)
  expect(writes).toHaveLength(2)
})
