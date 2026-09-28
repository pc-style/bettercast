const questions = [
  {
    id: 'foundation', title: 'What should the next Mac app be built with?', hint: 'Choose the base before we rebuild features.',
    choices: ['Native Swift / AppKit + SwiftUI', 'Tauri + web UI', 'Improve the Sol / React Native fork', 'I want a tiny proof first'], recommended: 0,
  },
  {
    id: 'shape', title: 'What should its windows feel like?', hint: 'The pop-up was hard to use and test.',
    choices: ['Launcher pop-up + normal editing window', 'One normal window for everything', 'Only a quick pop-up', 'Show me a working comparison first'], recommended: 0, visual: true,
  },
  {
    id: 'keyboard', title: 'How far should keyboard-only use go?', hint: 'Including forms, buttons, and going back.',
    choices: ['Every action, with clear Tab and focus', 'Daily actions; advanced settings can use a mouse', 'Keyboard search only is enough', 'Decide after a real demo'], recommended: 0,
  },
  {
    id: 'open', title: 'How should it open while Raycast stays?', hint: 'No silent takeover.',
    choices: ['Menu bar / app first; optional shortcut later', 'Ask me to pick a new shortcut now', 'Reuse my current launcher shortcut', 'Show alternatives first'], recommended: 0,
  },
  {
    id: 'first', title: 'What earns the first usable build?', hint: 'Pick one focus; other features can follow.',
    choices: ['Search, navigation, snippets, paste', 'Clipboard history and paste queue', 'AI chat and actions', 'Raycast import and extensions'], recommended: 0,
  },
  {
    id: 'proof', title: 'What evidence should count as “works”?', hint: 'A build passing CI is not the same as a usable app.',
    choices: ['Packaged-app keyboard + accessibility tests', 'Source tests and screenshots', 'I will manually test each feature', 'A combination; show me a small pilot'], recommended: 0,
  },
  {
    id: 'batch', title: 'How should I deliver changes?', hint: 'Your time matters more than lots of tiny builds.',
    choices: ['Useful groups, one integrated build', 'Small change and build every time', 'One big release at the end', 'Ask me before each group'], recommended: 0,
  },
  {
    id: 'agent', title: 'When should I stop and ask you?', hint: 'This is about how I work, not the app.',
    choices: ['Only for a real choice or risky action', 'Before choosing architecture', 'Before every meaningful change', 'Do everything without asking'], recommended: 0,
  },
]

const list = document.querySelector('#question-list')
const editor = document.querySelector('#agent-text')
const status = document.querySelector('#status')
const progress = document.querySelector('#progress')
const notes = document.querySelector('#notes')
const answers = {}
let version = ''
let savedText = ''
const begin = '<!-- Adam’s answers: start -->'
const end = '<!-- Adam’s answers: end -->'

function renderQuestions() {
  for (const [index, question] of questions.entries()) {
    const card = document.createElement('fieldset')
    card.className = 'question'
    card.innerHTML = `<legend><span class="number">${String(index + 1).padStart(2, '0')}</span><span class="question-title">${question.title}</span></legend><p class="hint">${question.hint}</p>`
    const options = document.createElement('div')
    options.className = 'options' + (question.visual ? ' visual-options' : '')
    question.choices.forEach((choice, position) => {
      const label = document.createElement('label')
      label.className = 'option'
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = question.id
      input.value = String(position)
      input.addEventListener('change', () => {
        answers[question.id] = position
        updateDraft()
      })
      const content = document.createElement('span')
      content.className = 'option-content'
      if (question.visual && position < 3) {
        const mock = document.createElement('span')
        mock.className = `mini mini-${position}`
        mock.setAttribute('aria-hidden', 'true')
        mock.innerHTML = '<i></i><b></b><s></s>'
        content.append(mock)
      }
      const title = document.createElement('span')
      title.className = 'option-label'
      title.textContent = `${'ABCD'[position]}  ${choice}`
      content.append(title)
      if (position === question.recommended) {
        const badge = document.createElement('span')
        badge.className = 'recommended'
        badge.textContent = 'MY PICK · NOT SELECTED'
        content.append(badge)
      }
      label.append(input, content)
      options.append(label)
    })
    card.append(options)
    list.append(card)
  }
}

function answerText() {
  const lines = questions.filter(q => answers[q.id] !== undefined).map(q => {
    const answer = q.choices[answers[q.id]]
    return `- **${q.title}** ${'ABCD'[answers[q.id]]} — ${answer}`
  })
  if (notes.value.trim()) lines.push(`- **Anything else:** ${notes.value.trim().replace(/\s+/g, ' ')}`)
  return lines.length ? `## Adam’s answers (selected, not inferred)\n\n${lines.join('\n')}` : ''
}

function updateDraft() {
  progress.textContent = `${Object.keys(answers).length} of ${questions.length} answered`
  if (!version) return
  const current = editor.value
  const start = current.indexOf(begin)
  const finish = current.indexOf(end, start + begin.length)
  const hasBlock = start >= 0 && finish > start
  const preceding = hasBlock ? current.slice(0, start).trimEnd() : current.trimEnd()
  const following = hasBlock ? current.slice(finish + end.length) : ''
  const chosen = answerText()
  editor.value = chosen ? `${preceding}\n\n${begin}\n${chosen}\n${end}${following}\n` : `${preceding}${following}\n`
  setStatus('Answers added to the draft. Save here or download when ready.')
}

function setStatus(message, error = false) {
  status.textContent = message
  status.classList.toggle('error', error)
}

renderQuestions()
notes.addEventListener('input', updateDraft)
fetch('/api/document').then(async response => {
  if (!response.ok) throw new Error('Could not load AGENTS.md')
  const data = await response.json()
  editor.value = data.text
  savedText = data.text
  version = data.version
  setStatus('Ready. Pick only the answers you mean.')
  if (Object.keys(answers).length || notes.value.trim()) updateDraft()
}).catch(error => setStatus(error.message, true))

document.querySelector('#copy').addEventListener('click', async () => {
  const text = answerText()
  if (!text) return setStatus('Pick an answer or add a note first.', true)
  try {
    await navigator.clipboard.writeText(text)
    setStatus('Answers copied. Paste them into our conversation.')
  } catch {
    setStatus('Clipboard unavailable; select and copy your answers from the draft.', true)
  }
})

document.querySelector('#download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([editor.value], {type: 'text/markdown'}))
  const link = document.createElement('a')
  link.href = url
  link.download = 'AGENTS.md'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  setStatus('Downloaded the current draft. No repository change was made.')
})

document.querySelector('#save').addEventListener('click', async () => {
  if (!version) return setStatus('The file has not loaded; reload before saving.', true)
  try {
    const response = await fetch('/api/document', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({text: editor.value, version}),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    version = result.version
    savedText = editor.value
    setStatus('Saved to this orb’s AGENTS.md. Not committed or pushed.')
  } catch (error) {
    setStatus(error.message || 'Save failed. Your draft is still in this browser tab.', true)
  }
})

window.addEventListener('beforeunload', event => {
  if (version && editor.value !== savedText) {
    event.preventDefault()
    event.returnValue = ''
  }
})
