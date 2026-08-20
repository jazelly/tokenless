type Control = {
  elementRef: string
  role: 'textbox'
  name: string
  label: string
  placeholder: string
  inputType: string
  valuePresence: 'empty' | 'present'
  visible: true
  enabled: true
  editable: true
  structuralHint: string
  contextText: string
}

type Observation = {
  protocol: 'tokenless.harness-browser-extension/v1'
  kind: 'semantic_page_observation'
  page: { origin: string; url: string; title: string; documentId: string; documentRevision: number }
  observationRevision: number
  controls: Control[]
}

type InputMessage = {
  type: 'input'
  elementRef: string
  text: string
  url: string
  documentId: string
  documentRevision: number
  observationRevision: number
}

type Adapter = { handle(message: unknown): Promise<unknown> | unknown }

const globalScope = globalThis as typeof globalThis & { __tokenlessHarnessPageAdapterV1?: Adapter }
globalScope.__tokenlessHarnessPageAdapterV1 ??= createAdapter()

function createAdapter(): Adapter {
  const documentId = `document-${crypto.randomUUID()}`
  let documentRevision = 1
  let observationRevision = 0
  const elements = new Map<string, { element: HTMLElement; documentRevision: number; observationRevision: number }>()
  const mutationObserver = new MutationObserver((records) => recordMutations(records))
  mutationObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-labelledby', 'contenteditable', 'disabled', 'hidden', 'placeholder', 'readonly', 'role', 'style', 'type'],
  })

  const adapter: Adapter = {
    handle(message) {
      if (!message || typeof message !== 'object') return undefined
      const type = (message as { type?: unknown }).type
      if (type === 'observe') return observe()
      if (type === 'input') return input(message as InputMessage)
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
      elements.set(elementRef, { element, documentRevision, observationRevision })
      controls.push({ ...semantic, elementRef })
      if (controls.length >= 64) break
    }
    return {
      protocol: 'tokenless.harness-browser-extension/v1',
      kind: 'semantic_page_observation',
      page: { origin: location.origin, url: boundedUrl(), title: boundedText(document.title, 512), documentId, documentRevision },
      observationRevision,
      controls,
    }
  }

  async function input(message: InputMessage) {
    flushMutations()
    const elementRef = typeof message.elementRef === 'string' ? message.elementRef : ''
    if (message.documentId !== documentId || message.url !== boundedUrl() || message.documentRevision !== documentRevision) {
      return failure(elementRef, 'stale_document', 'The attached document changed; attach the current page again.')
    }
    const target = elements.get(elementRef)
    if (!target || message.observationRevision !== observationRevision || target.observationRevision !== observationRevision) {
      return failure(elementRef, 'stale_observation', 'The page controls changed after observation; observe again.')
    }
    if (target.documentRevision !== documentRevision) return failure(elementRef, 'stale_document', 'The page document revision is stale.')
    const text = typeof message.text === 'string' ? message.text : ''
    if (text.length > 16_384 || text.includes('\0')) return failure(elementRef, 'invalid_action', 'The proposed text is invalid.')
    const reason = mutationBlocker(target.element)
    if (reason) return failure(elementRef, reason.code, reason.message)

    try {
      target.element.focus({ preventScroll: true })
      const beforeInput = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text,
      })
      if (!target.element.dispatchEvent(beforeInput)) return failure(elementRef, 'invalid_action', 'The page rejected the editing event.')
      if (isContentEditable(target.element)) setContentEditableValue(target.element, text)
      else setNativeValue(target.element as HTMLInputElement | HTMLTextAreaElement, text)
      target.element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
      await nextPaint()
      if (!target.element.isConnected || currentValue(target.element) !== text) {
        return failure(elementRef, 'invalid_action', 'The live visible control did not verify the proposed text.')
      }
      flushMutations()
      return {
        protocol: 'tokenless.harness-browser-extension/v1',
        kind: 'input_result',
        status: 'succeeded',
        elementRef,
        documentRevision,
        observationRevision,
        valueEvidence: { state: 'present', length: text.length, sha256: await sha256(text) },
      }
    } catch {
      return failure(elementRef, 'invalid_action', 'The live control rejected the input mutation.')
    }
  }

  function failure(elementRef: string, code: string, message: string) {
    return {
      protocol: 'tokenless.harness-browser-extension/v1', kind: 'input_result', status: 'failed', elementRef,
      documentRevision, observationRevision, valueEvidence: { state: 'not_verified' }, failure: { code, message },
    }
  }
}

function semanticControl(element: HTMLElement, index: number): Omit<Control, 'elementRef'> | null {
  if (mutationBlocker(element)) return null
  const inputType = element instanceof HTMLInputElement
    ? (element.type || 'text').toLowerCase()
    : element instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'
  if (element instanceof HTMLInputElement && !['text', 'search', 'email', 'tel', 'url', 'number'].includes(inputType)) return null
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !isContentEditable(element)) return null
  const label = associatedLabel(element)
  const placeholder = boundedText(element.getAttribute('placeholder') ?? '', 160)
  return {
    role: 'textbox',
    name: accessibleName(element, label, placeholder),
    label,
    placeholder,
    inputType,
    valuePresence: currentValue(element).length > 0 ? 'present' : 'empty',
    visible: true,
    enabled: true,
    editable: true,
    structuralHint: structuralHint(element, index),
    contextText: surroundingText(element),
  }
}

function mutationBlocker(element: HTMLElement): { code: string; message: string } | null {
  if (!element.isConnected) return { code: 'detached_control', message: 'The approved control is detached.' }
  if (!isVisible(element)) return { code: 'hidden_control', message: 'The approved control is hidden.' }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.disabled) return { code: 'disabled_control', message: 'The approved control is disabled.' }
    if (element.readOnly) return { code: 'read_only_control', message: 'The approved control is read-only.' }
  } else if (!isContentEditable(element)) {
    return { code: 'read_only_control', message: 'The approved textbox is not an editable DOM surface.' }
  }
  if (isSensitive(element)) return { code: 'sensitive_control', message: 'Sensitive controls cannot be edited by this V1.' }
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
  return ariaLabel || labelledBy || label || placeholder || boundedText(element.getAttribute('name') ?? '', 160) || 'Text field'
}

function labelledByText(element: HTMLElement) {
  return boundedText((element.getAttribute('aria-labelledby') ?? '').split(/\s+/u).flatMap((id) => {
    const labelElement = document.getElementById(id)
    return labelElement ? [redactCandidateValues(labelElement, labelElement.textContent ?? '')] : []
  }).join(' '), 160)
}

function associatedLabel(element: HTMLElement) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return boundedText([...(element.labels ?? [])]
      .map((item) => redactCandidateValues(item, item.textContent ?? '')).join(' '), 160)
  }
  const label = element.closest('label')
  return boundedText(label ? redactCandidateValues(label, label.textContent ?? '') : '', 160)
}

function structuralHint(element: HTMLElement, index: number) {
  const group = element.closest('fieldset, [role="group"], section, form')
  const heading = group?.querySelector('h1, h2, h3, h4, legend')?.textContent ?? ''
  return boundedText([boundedText(heading, 120), element.parentElement?.tagName.toLowerCase() ?? '', `field ${index + 1}`].filter(Boolean).join(' / '), 160)
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
  const checkVisibility = (element as HTMLElement & { checkVisibility?: (options: object) => boolean }).checkVisibility
  if (checkVisibility && !checkVisibility.call(element, { checkOpacity: true, checkVisibilityCSS: true })) return false
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
}

function isContentEditable(element: HTMLElement) {
  const value = element.getAttribute('contenteditable')
  return element.isContentEditable || value === 'true' || value === 'plaintext-only'
}

function currentValue(element: HTMLElement) {
  return isContentEditable(element) ? element.innerText : (element as HTMLInputElement | HTMLTextAreaElement).value
}

function isCandidateOrRelated(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement
  return Boolean(element && (matchesCandidate(element) || element.closest('label, fieldset, [role="group"]')))
}

function matchesCandidate(element: Element) { return element.matches(candidateSelector()) }
function candidateSelector() { return 'input, textarea, [contenteditable], [role="textbox"]' }
function boundedText(value: string, max: number) { return value.replace(/\s+/gu, ' ').trim().slice(0, max) }
function boundedUrl() { return `${location.origin}${location.pathname}`.slice(0, 2048) }

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}
