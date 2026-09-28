import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {createWorksheetServer} from '../server.mjs'

test('serves the worksheet and saves only an explicitly versioned, same-origin document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worksheet-'))
  const documentPath = join(dir, 'AGENTS.md')
  await writeFile(documentPath, '# Original\n')
  const server = createWorksheetServer(documentPath)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const page = await fetch(base)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Copy all answers/)
    const {text, version} = await (await fetch(`${base}/api/document`)).json()
    assert.equal(text, '# Original\n')
    const edit = {method: 'POST', headers: {'Content-Type': 'application/json', Origin: base}, body: JSON.stringify({text: '# Revised\n', version})}
    assert.equal((await fetch(`${base}/api/document`, {...edit, headers: {...edit.headers, Origin: 'https://attacker.example'}})).status, 403)
    assert.equal((await fetch(`${base}/api/document`, edit)).status, 200)
    assert.equal((await fetch(`${base}/api/document`, edit)).status, 409)
    assert.equal(await readFile(documentPath, 'utf8'), '# Revised\n')
    assert.equal((await fetch(`${base}/../server.mjs`)).status, 404)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(dir, {recursive: true, force: true})
  }
})
