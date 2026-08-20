declare namespace chrome {
  namespace runtime {
    const id: string
    function getManifest(): { version: string }
    function sendMessage<T = unknown>(message: unknown): Promise<T>
    const onMessage: {
      addListener(listener: (message: unknown, sender: unknown) => void | Promise<unknown>): void
    }
  }
  namespace storage {
    namespace local {
      function get<T extends object>(keys: string[] | object): Promise<Partial<T>>
      function set(values: object): Promise<void>
      function remove(keys: string[] | string): Promise<void>
    }
  }
  namespace tabs {
    type Tab = { id?: number; title?: string; url?: string; windowId?: number; active?: boolean }
    function query(queryInfo: object): Promise<Tab[]>
    function get(tabId: number): Promise<Tab>
    function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>
    function create(createProperties: { url: string }): Promise<Tab>
  }
  namespace sidePanel {
    function open(options: { windowId: number }): Promise<void>
    function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
  }
  namespace scripting {
    function executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown[]>
  }
  namespace action {
    const onClicked: { addListener(listener: (tab: tabs.Tab) => void | Promise<void>): void }
  }
}
