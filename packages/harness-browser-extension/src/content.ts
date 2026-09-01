type ActionKind = 'input' | 'click' | 'submit' | 'radio' | 'upload'

type Control = {
  elementRef: string
  role: 'textbox' | 'button' | 'radio' | 'file' | 'form'
  name: string
  label: string
  placeholder: string
  inputType: string
  valuePresence: 'empty' | 'present'
  checked?: boolean
  actions: ActionKind[]
  visible: true
  enabled: true
  editable: boolean
  structuralHint: string
  contextText: string
}

type Observation = {
  protocol: 'tokenless.harness-browser-extension/v2'
  kind: 'semantic_page_observation'
  page: { origin: string; url: string; title: string; documentId: string; documentRevision: number }
  observationRevision: number
  controls: Control[]
}

type ActionMessage = {
  type: ActionKind
  elementRef: string
  text?: string
  file?: { name: string; type: string; lastModified: number; bytes: ArrayBuffer }
  url: string
  documentId: string
  documentRevision: number
  observationRevision: number
}

type Adapter = { handle(message: unknown): Promise<unknown> | unknown }
type ElementState = { element: HTMLElement; actions: ActionKind[]; documentRevision: number; observationRevision: number }

const globalScope = globalThis as typeof globalThis & { __tokenlessHarnessPageAdapterV2?: Adapter }
globalScope.__tokenlessHarnessPageAdapterV2 ??= createAdapter()

function createAdapter(): Adapter {
  const documentId = `document-${crypto.randomUUID()}`
  let documentRevision = 1
  let observationRevision = 0
  const elements = new Map<string, ElementState>()
  const mutationObserver = new MutationObserver((records) => recordMutations(records))
  mutationObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-checked', 'aria-label', 'aria-labelledby', 'checked', 'contenteditable', 'disabled', 'hidden', 'placeholder', 'readonly', 'role', 'style', 'type'],
  })

  const adapter: Adapter = {
    handle(message) {
      if (!message || typeof message !== 'object') return undefined
      const type = (message as { type?: unknown }).type
      if (type === 'observe') return { observation: observe(), rawDom: document.documentElement.outerHTML }
      if (['input', 'click', 'submit', 'radio', 'upload'].includes(String(type))) return act(message as ActionMessage)
      return undefined
    },
  }
  chrome.runtime.onMessage.addListener((message) => Promise.resolve(adapter.handle(message)))
  return adapter

  function recordMutations(records: MutationRecord[]) {
    if (!records.some(relevantMutation)) return
    documentRevision += 1
    elements.clear()
  }

  function flushMutations() { recordMutations(mutationObserver.takeRecords()) }

  function relevantMutation(record: MutationRecord) {
    if (record.type === 'attributes') return isCandidateOrRelated(record.target)
    if (record.type === 'characterData') return isCandidateOrRelated(record.target.parentElement)
    if (isCandidateOrRelated(record.target)) return true
    return [...record.addedNodes, ...record.removedNodes].some((node) =>
      node instanceof Element && (matchesCandidate(node) || Boolean(node.querySelector(candidateSelector()))))
  }

  function observe(): Observation {
    flushMutations()
    observationRevision += 1
    elements.clear()
    const controls: Control[] = []
    for (const element of document.querySelectorAll<HTMLElement>(candidateSelector())) {
      const semantic = semanticControl(element, controls.length)
      if (!semantic) continue
      const elementRef = `element-${crypto.randomUUID()}`
      elements.set(elementRef, { element, actions: semantic.actions, documentRevision, observationRevision })
      controls.push({ ...semantic, elementRef })
      if (controls.length >= 128) break
    }
    return {
      protocol: 'tokenless.harness-browser-extension/v2',
      kind: 'semantic_page_observation',
      page: { origin: location.origin, url: boundedUrl(), title: boundedText(document.title, 512), documentId, documentRevision },
      observationRevision,
      controls,
    }
  }

  async function act(message: ActionMessage) {
    flushMutations()
    const action = message.type
    const elementRef = typeof message.elementRef === 'string' ? message.elementRef : ''
    if (message.documentId !== documentId || message.url !== boundedUrl() || message.documentRevision !== documentRevision) {
      return failure(action, elementRef, 'stale_document', 'The attached document changed; attach the current page again.')
    }
    const target = elements.get(elementRef)
    if (!target || message.observationRevision !== observationRevision || target.observationRevision !== observationRevision) {
      return failure(action, elementRef, 'stale_observation', 'The page controls changed after observation; observe again.')
    }
    if (target.documentRevision !== documentRevision) return failure(action, elementRef, 'stale_document', 'The page document revision is stale.')
    if (!target.actions.includes(action)) return failure(action, elementRef, 'invalid_action', 'The approved control does not support this action.')
    const reason = actionBlocker(target.element)
    if (reason) return failure(action, elementRef, reason.code, reason.message)

    try {
      if (action === 'input') return await input(target.element, elementRef, message.text)
      if (action === 'click') return await clickButton(target.element, elementRef)
      if (action === 'submit') return submit(target.element, elementRef)
      if (action === 'radio') return await selectRadio(target.element, elementRef)
      return await upload(target.element, elementRef, message.file)
    } catch {
      return failure(action, elementRef, 'invalid_action', 'The live control rejected the approved action.')
    }
  }

  async function input(element: HTMLElement, elementRef: string, proposed: unknown) {
    const text = typeof proposed === 'string' ? proposed : ''
    if (text.length > 16_384 || text.includes('\0')) return failure('input', elementRef, 'invalid_action', 'The proposed text is invalid.')
    element.focus({ preventScroll: true })
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text,
    })
    if (!element.dispatchEvent(beforeInput)) return failure('input', elementRef, 'invalid_action', 'The page rejected the editing event.')
    if (isContentEditable(element)) setContentEditableValue(element, text)
    else setNativeValue(element as HTMLInputElement | HTMLTextAreaElement, text)
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    await nextPaint()
    if (!element.isConnected || currentValue(element) !== text) {
      return failure('input', elementRef, 'invalid_action', 'The live visible control did not verify the proposed text.')
    }
    flushMutations()
    return success('input', elementRef, { state: 'verified', length: text.length, sha256: await sha256(text) })
  }

  async function clickButton(element: HTMLElement, elementRef: string) {
    element.focus({ preventScroll: true })
    element.click()
    await nextPaint()
    flushMutations()
    return success('click', elementRef, { state: 'dispatched' })
  }

  function submit(element: HTMLElement, elementRef: string) {
    const form = element instanceof HTMLFormElement ? element : element.closest('form')
    if (!form) return failure('submit', elementRef, 'invalid_action', 'The approved submit control has no form.')
    if (!form.checkValidity()) return failure('submit', elementRef, 'invalid_action', 'The form is not valid and was not submitted.')
    const submitter = element instanceof HTMLButtonElement || (element instanceof HTMLInputElement && element.type === 'submit')
      ? element
      : undefined
    setTimeout(() => form.requestSubmit(submitter), 0)
    return success('submit', elementRef, { state: 'dispatched' })
  }

  async function selectRadio(element: HTMLElement, elementRef: string) {
    if (!(element instanceof HTMLInputElement) || element.type !== 'radio') {
      return failure('radio', elementRef, 'invalid_action', 'The approved control is not a native radio input.')
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set
    if (!setter) return failure('radio', elementRef, 'invalid_action', 'The native radio setter is unavailable.')
    setter.call(element, true)
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    await nextPaint()
    if (!element.checked) return failure('radio', elementRef, 'invalid_action', 'The live radio control did not verify selection.')
    flushMutations()
    return success('radio', elementRef, { state: 'verified', checked: true })
  }

  async function upload(element: HTMLElement, elementRef: string, proposed: ActionMessage['file']) {
    if (!(element instanceof HTMLInputElement) || element.type !== 'file' || !proposed ||
      typeof proposed.name !== 'string' || proposed.name.length === 0 || proposed.name.length > 512 ||
      !(proposed.bytes instanceof ArrayBuffer) || proposed.bytes.byteLength > 32 * 1024 * 1024) {
      return failure('upload', elementRef, 'invalid_action', 'The selected upload file is invalid.')
    }
    const file = new File([proposed.bytes], proposed.name, {
      type: proposed.type || 'application/octet-stream', lastModified: proposed.lastModified,
    })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set
    if (!setter) return failure('upload', elementRef, 'invalid_action', 'The native file setter is unavailable.')
    setter.call(element, transfer.files)
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    await nextPaint()
    if (element.files?.length !== 1 || element.files[0]?.name !== proposed.name) {
      return failure('upload', elementRef, 'invalid_action', 'The live file control did not verify the selected file.')
    }
    flushMutations()
    return success('upload', elementRef, { state: 'verified', fileName: proposed.name })
  }

  function success(action: ActionKind, elementRef: string, evidence: Record<string, unknown>) {
    return {
      protocol: 'tokenless.harness-browser-extension/v2', kind: 'action_result', action, status: 'succeeded', elementRef,
      documentRevision, observationRevision, evidence,
    }
  }

  function failure(action: ActionKind, elementRef: string, code: string, message: string) {
    return {
      protocol: 'tokenless.harness-browser-extension/v2', kind: 'action_result', action, status: 'failed', elementRef,
      documentRevision, observationRevision, evidence: { state: 'not_verified' }, failure: { code, message },
    }
  }
}

function semanticControl(element: HTMLElement, index: number): Omit<Control, 'elementRef'> | null {
  if (actionBlocker(element)) return null
  const label = associatedLabel(element)
  const placeholder = boundedText(element.getAttribute('placeholder') ?? '', 160)
  const common = {
    name: accessibleName(element, label, placeholder),
    label,
    placeholder,
    visible: true as const,
    enabled: true as const,
    structuralHint: structuralHint(element, index),
    contextText: surroundingText(element),
  }
  if (element instanceof HTMLInputElement && element.type === 'radio') {
    return { ...common, role: 'radio', inputType: 'radio', valuePresence: element.checked ? 'present' : 'empty', checked: element.checked, actions: ['radio'], editable: true }
  }
  if (element instanceof HTMLInputElement && element.type === 'file') {
    return { ...common, role: 'file', inputType: 'file', valuePresence: element.files?.length ? 'present' : 'empty', actions: ['upload'], editable: true }
  }
  if (element instanceof HTMLFormElement) {
    return { ...common, role: 'form', inputType: 'form', valuePresence: 'empty', actions: ['submit'], editable: false }
  }
  if (isButton(element)) {
    const submit = isSubmitControl(element)
    return { ...common, role: 'button', inputType: submit ? 'submit' : 'button', valuePresence: 'empty', actions: [submit ? 'submit' : 'click'], editable: false }
  }
  const inputType = element instanceof HTMLInputElement
    ? (element.type || 'text').toLowerCase()
    : element instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'
  if (element instanceof HTMLInputElement && !['text', 'search', 'email', 'tel', 'url', 'number'].includes(inputType)) return null
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !isContentEditable(element)) return null
  return {
    ...common,
    role: 'textbox',
    inputType,
    valuePresence: currentValue(element).length > 0 ? 'present' : 'empty',
    actions: ['input'],
    editable: true,
  }
}

function actionBlocker(element: HTMLElement): { code: string; message: string } | null {
  if (!element.isConnected) return { code: 'detached_control', message: 'The approved control is detached.' }
  if (!isVisible(element)) return { code: 'hidden_control', message: 'The approved control is hidden.' }
  if ('disabled' in element && Boolean((element as HTMLInputElement | HTMLButtonElement).disabled)) {
    return { code: 'disabled_control', message: 'The approved control is disabled.' }
  }
  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly) {
    return { code: 'read_only_control', message: 'The approved control is read-only.' }
  }
  if (isSensitive(element)) return { code: 'sensitive_control', message: 'Sensitive controls cannot be operated.' }
  return null
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('native value setter unavailable')
  setter.call(element, text)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
}

function setContentEditableValue(element: HTMLElement, text: string) {
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(element)
  selection?.removeAllRanges()
  selection?.addRange(range)
  if (!document.execCommand('insertText', false, text)) {
    element.textContent = text
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
  }
}

function accessibleName(element: HTMLElement, label: string, placeholder: string) {
  const ariaLabel = boundedText(element.getAttribute('aria-label') ?? '', 160)
  const labelledBy = labelledByText(element)
  const buttonText = isButton(element) ? boundedText(element.textContent ?? (element as HTMLInputElement).value ?? '', 160) : ''
  return ariaLabel || labelledBy || label || buttonText || placeholder || boundedText(element.getAttribute('name') ?? '', 160) || defaultName(element)
}

function defaultName(element: HTMLElement) {
  if (element instanceof HTMLFormElement) return 'Form'
  if (element instanceof HTMLInputElement && element.type === 'radio') return 'Radio option'
  if (element instanceof HTMLInputElement && element.type === 'file') return 'File upload'
  if (isButton(element)) return 'Button'
  return 'Text field'
}

function labelledByText(element: HTMLElement) {
  return boundedText((element.getAttribute('aria-labelledby') ?? '').split(/\s+/u).flatMap((id) => {
    const labelElement = document.getElementById(id)
    return labelElement ? [redactCandidateValues(labelElement, labelElement.textContent ?? '')] : []
  }).join(' '), 160)
}

function associatedLabel(element: HTMLElement) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return boundedText([...(element.labels ?? [])].map((item) => redactCandidateValues(item, item.textContent ?? '')).join(' '), 160)
  }
  const label = element.closest('label')
  return boundedText(label ? redactCandidateValues(label, label.textContent ?? '') : '', 160)
}

function structuralHint(element: HTMLElement, index: number) {
  const group = element.closest('fieldset, [role="group"], section, form')
  const heading = group?.querySelector('h1, h2, h3, h4, legend')?.textContent ?? ''
  return boundedText([boundedText(heading, 120), element.parentElement?.tagName.toLowerCase() ?? '', `control ${index + 1}`].filter(Boolean).join(' / '), 160)
}

function surroundingText(element: HTMLElement) {
  const container = element.closest('label, fieldset, [role="group"], section, form') ?? element.parentElement
  return boundedText(container instanceof HTMLElement ? redactCandidateValues(container, container.innerText) : '', 240)
}

function redactCandidateValues(container: Element, source: string) {
  let text = source
  const controls = [
    ...(container instanceof HTMLElement && matchesCandidate(container) ? [container] : []),
    ...container.querySelectorAll<HTMLElement>(candidateSelector()),
  ]
  for (const control of controls) {
    const values = new Set([currentValue(control), ...(isContentEditable(control) ? [control.textContent ?? ''] : [])])
    for (const value of values) if (value) text = text.replaceAll(value, '[value redacted]')
  }
  return text
}

function isSensitive(element: HTMLElement) {
  const values = [
    element instanceof HTMLInputElement ? element.type : '', element.getAttribute('autocomplete') ?? '',
    element.getAttribute('name') ?? '', element.id, element.getAttribute('aria-label') ?? '', element.getAttribute('placeholder') ?? '',
    associatedLabel(element), labelledByText(element),
  ].join(' ').toLowerCase()
  return /password|one-time|otp|verification|auth|secret|token|captcha|mfa|cvv|cvc|cc-|credit.?card|card.?number|security.?code|payment|ssn|\bpin\b|webauthn/u.test(values)
}

function isVisible(element: HTMLElement) {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function isButton(element: HTMLElement) {
  return element instanceof HTMLButtonElement ||
    (element instanceof HTMLInputElement && ['button', 'submit'].includes(element.type)) ||
    element.getAttribute('role') === 'button'
}

function isSubmitControl(element: HTMLElement) {
  if (element instanceof HTMLButtonElement) return (element.getAttribute('type') ?? 'submit').toLowerCase() === 'submit'
  return element instanceof HTMLInputElement && element.type === 'submit'
}

function isContentEditable(element: HTMLElement) { return element.isContentEditable || element.getAttribute('role') === 'textbox' }
function currentValue(element: HTMLElement) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value
  return element.textContent ?? ''
}
function candidateSelector() {
  return 'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="radio"], input[type="file"], input[type="button"], input[type="submit"], textarea, button, form, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="button"]'
}
function matchesCandidate(node: Element) { return node.matches(candidateSelector()) }
function isCandidateOrRelated(node: Node | null): boolean {
  if (!(node instanceof Element)) return false
  return matchesCandidate(node) || Boolean(node.closest(candidateSelector())) || Boolean(node.querySelector(candidateSelector()))
}
function boundedUrl() { return `${location.origin}${location.pathname}`.slice(0, 2048) }
function boundedText(value: string, max: number) { return value.replace(/\s+/gu, ' ').trim().slice(0, max) }
function nextPaint() { return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) }
async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, '0')).join('')
}
