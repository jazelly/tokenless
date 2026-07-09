type RunnerRecord = Record<string, any>
type RunnerGlobal = typeof globalThis & {
  __TOKENLESS_DAEMON_RUN_RESPONSE__?: RunnerRecord
}

const statusNode = document.querySelector('#status')
const detailNode = document.querySelector('#detail')

run().catch((error) => {
  render('Failed', error?.message || 'Tokenless daemon runner failed.')
})

async function run() {
  const params = new URLSearchParams(location.search)
  render('Running', 'Claiming the next daemon job.')
  const response = await chrome.runtime.sendMessage({
    type: 'tokenless.daemon.run_next',
    daemonUrl: stringOrUndefined(params.get('daemonUrl')),
    provider: stringOrUndefined(params.get('provider')),
    action: stringOrUndefined(params.get('action')),
  })
  ;(globalThis as RunnerGlobal).__TOKENLESS_DAEMON_RUN_RESPONSE__ = response
  renderResponse(response)
}

function renderResponse(response: RunnerRecord) {
  if (response?.ok) {
    render(response.status === 'no_job' ? 'No Job' : 'Completed', response.result?.text || response.status || 'Done.')
    return
  }
  render('Failed', response?.error?.message || 'Daemon job failed.')
}

function render(status: string, detail: string) {
  if (statusNode) statusNode.textContent = status
  if (detailNode) detailNode.textContent = detail
}

function stringOrUndefined(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}
