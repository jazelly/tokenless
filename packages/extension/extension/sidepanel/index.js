import { capabilitiesPayload } from '../shared/bridge-protocol.js'

const status = document.querySelector('#status')
const providers = document.querySelector('#providers')
const capabilities = capabilitiesPayload()

status.textContent = 'Ready'

providers.replaceChildren(...capabilities.providers.map((provider) => {
  const row = document.createElement('div')
  row.className = 'provider'

  const label = document.createElement('strong')
  label.textContent = provider.label

  const meta = document.createElement('span')
  meta.textContent = new URL(provider.homeUrl).hostname

  row.append(label, meta)
  return row
}))
