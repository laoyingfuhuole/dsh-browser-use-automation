'use strict'

const api = window.browserToolbar
const tabs = document.querySelector('#tabs')
const address = document.querySelector('#address')
const errorStatus = document.querySelector('#error')
const tabButtons = new Map()
let revision = 0
let activeId
let committed = ''
let editing = false

async function act(action, id, value) {
  const submitted = ++revision
  clearError()
  try {
    await api.action(action, id, value)
  } catch (error) {
    if (submitted !== revision || (id && id !== activeId)) return
    errorStatus.textContent = error.message
    errorStatus.title = error.message
    errorStatus.hidden = false
    if (action === 'navigate') address.setAttribute('aria-invalid', 'true')
  }
}

function render(state) {
  const active = state.tabs.find(tab => tab.id === state.activeTabId)
  if (!active) return
  const changed = activeId !== active.id
  if (changed) revision++
  activeId = active.id
  const url = active.url === 'about:blank' ? '' : active.url
  const navigated = committed !== url
  committed = url
  if (changed || navigated) {
    editing = false
    clearError()
  }
  if (!editing) address.value = committed
  document.querySelector('#back').disabled = !active.canGoBack
  document.querySelector('#forward').disabled = !active.canGoForward
  const current = new Set(state.tabs.map(tab => tab.id))
  for (const [id, item] of tabButtons) {
    if (current.has(id)) continue
    item.remove()
    tabButtons.delete(id)
  }
  for (const tab of state.tabs) {
    let item = tabButtons.get(tab.id)
    if (!item) {
      item = document.createElement('div')
      const select = document.createElement('button')
      select.onclick = () => act('select', tab.id)
      const close = document.createElement('button')
      close.textContent = '×'
      close.onclick = () => act('close', tab.id)
      item.append(select, close)
      tabs.append(item)
      tabButtons.set(tab.id, item)
    }
    item.className = tab.id === activeId ? 'tab selected' : 'tab'
    const [select, close] = item.children
    select.textContent = tab.title || (tab.url === 'about:blank' ? '新标签页' : tab.url)
    select.title = tab.url
    select.setAttribute('aria-pressed', String(tab.id === activeId))
    close.setAttribute('aria-label', '关闭 ' + select.textContent)
  }
  if (changed) tabs.querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function clearError() {
  address.removeAttribute('aria-invalid')
  errorStatus.hidden = true
}

function discardDraft() {
  if (!editing) return
  editing = false
  revision++
  address.value = committed
  clearError()
}

address.oninput = () => { revision++; editing = true; clearError() }
address.onblur = event => { if (event.relatedTarget?.type !== 'submit') discardDraft() }
window.addEventListener('blur', discardDraft)
address.onkeydown = event => {
  if (event.key === 'Escape') { discardDraft(); clearError(); address.select() }
}
document.querySelector('#navigation').onsubmit = event => {
  event.preventDefault()
  editing = true
  act('navigate', activeId, address.value)
}
document.querySelector('#new').onclick = () => act('new')
for (const action of ['back', 'forward', 'reload']) document.getElementById(action).onclick = () => act(action, activeId)
let receivedUpdate = false
api.onTabs(state => { receivedUpdate = true; render(state) })
api.onAddress(() => { address.focus(); address.select() })
api.action('list').then(state => { if (!receivedUpdate) render(state) })
