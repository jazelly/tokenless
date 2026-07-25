import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixtureRoot = path.join(root, 'test', 'fixtures', 'provider-dom')
const observedOn = '2026-07-25'
const source = 'authenticated-user-visible-chrome-session'
const redactions = [
  'account identity',
  'chat titles',
  'message content',
  'uploaded file names',
  'generated asset URLs',
  'private route identifiers',
  'scripts',
  'styles',
]

const plans = Object.freeze({
  chatgpt: { status: 'observed', label: 'Pro' },
  claude: { status: 'observed', label: 'Free' },
  gemini: { status: 'unknown', label: null },
  grok: { status: 'observed', label: 'Free' },
})

const states = Object.freeze({
  chatgpt: 'signed-in-paid',
  claude: 'signed-in-free',
  gemini: 'signed-in-unknown',
  grok: 'signed-in-free',
})

const fixtures = [
  fixture({
    provider: 'chatgpt',
    scenario: 'conversation-existing',
    routeClass: 'conversation',
    sanitizedUrl: 'https://chatgpt.com/c/[redacted]',
    title: 'ChatGPT existing conversation',
    body: `
      <header><button aria-label="Share">Share</button><button aria-label="Open conversation options">More</button></header>
      <main>
        <article data-message-author-role="user"><h2>You said:</h2><p>[redacted message]</p></article>
        <article data-message-author-role="assistant"><h2>ChatGPT said:</h2><p>[redacted response]</p></article>
        <div id="prompt-textarea" role="textbox" contenteditable="true" aria-label="Chat with ChatGPT"></div>
      </main>`,
    evidenceSelectors: [
      evidence('job.existing', 'main article[data-message-author-role]', 2),
      evidence('job.continue', 'main [role="textbox"][aria-label="Chat with ChatGPT"]', 1),
      evidence('job.share', 'button[aria-label="Share"]', 1),
    ],
  }),
  fixture({
    provider: 'chatgpt',
    scenario: 'upload-tools-menu-open',
    routeClass: 'new-chat',
    sanitizedUrl: 'https://chatgpt.com/',
    title: 'ChatGPT upload and tools menu',
    body: `
      <main>
        <div id="prompt-textarea" role="textbox" contenteditable="true" aria-label="Chat with ChatGPT"></div>
        <button data-testid="composer-plus-btn" aria-label="Add files and more" aria-expanded="true">Add</button>
      </main>
      <div role="menu" aria-label="Add files and more">
        <div role="menuitem">Upload from computer</div>
        <div role="menuitem">Create image</div>
        <div role="menuitem">Web search</div>
        <div role="menuitem">Deep research</div>
        <div role="menuitem">Connect an app</div>
      </div>`,
    evidenceSelectors: [
      evidence('upload.open', 'button[data-testid="composer-plus-btn"][aria-expanded="true"]', 1),
      evidence('tools.enumerate', '[role="menu"] [role="menuitem"]', 5),
    ],
  }),
  fixture({
    provider: 'chatgpt',
    scenario: 'library-files',
    routeClass: 'library',
    sanitizedUrl: 'https://chatgpt.com/library',
    title: 'ChatGPT library',
    body: `
      <main>
        <h1>Library</h1>
        <button aria-label="Upload">Upload</button>
        <input type="search" aria-label="Search">
        <div role="tablist" aria-label="Library filters">
          <button role="tab" aria-selected="true">All</button>
          <button role="tab">Images</button>
          <button role="tab">Documents</button>
        </div>
        <div role="grid" aria-label="Files"><div role="row">[redacted file]</div></div>
      </main>`,
    evidenceSelectors: [
      evidence('library.open', 'main h1', 1),
      evidence('library.upload', 'button[aria-label="Upload"]', 1),
      evidence('library.filter', '[role="tablist"] [role="tab"]', 3),
    ],
  }),
  fixture({
    provider: 'chatgpt',
    scenario: 'connectors-directory',
    routeClass: 'connectors-directory',
    sanitizedUrl: 'https://chatgpt.com/plugins',
    title: 'ChatGPT connectors directory',
    body: `
      <main>
        <div role="tablist" aria-label="Directory type"><button role="tab" aria-selected="true">Plugins</button><button role="tab">Skills</button></div>
        <h1>Plugins</h1>
        <input type="search" aria-label="Search plugins">
        <section aria-label="Connector results">
          <article><h2>Figma</h2><button>Connect</button></article>
          <article><h2>GitHub</h2><button>Connect</button></article>
          <article><h2>Gmail</h2><button>Connect</button></article>
        </section>
      </main>`,
    evidenceSelectors: [
      evidence('connector.search', 'input[aria-label="Search plugins"]', 1),
      evidence('connector.list', 'section[aria-label="Connector results"] article', 3),
    ],
  }),
  fixture({
    provider: 'chatgpt',
    scenario: 'scheduled-jobs',
    routeClass: 'scheduled-jobs',
    sanitizedUrl: 'https://chatgpt.com/scheduled',
    title: 'ChatGPT scheduled jobs',
    body: `
      <main>
        <h1>Scheduled</h1>
        <div role="radiogroup" aria-label="Select chat surface"><label><input type="radio" checked>Chat</label><label><input type="radio">Work</label></div>
        <button aria-label="Filter tasks">Active</button>
        <textarea aria-label="Schedule a task"></textarea>
        <article data-testid="scheduled-task"><h2>[redacted task]</h2><button>Edit</button><button>Pause</button><button>More</button></article>
      </main>`,
    evidenceSelectors: [
      evidence('job.schedule', 'textarea[aria-label="Schedule a task"]', 1),
      evidence('job.existing', 'article[data-testid="scheduled-task"]', 1),
      evidence('job.control', 'article[data-testid="scheduled-task"] button', 3),
    ],
  }),
  fixture({
    provider: 'chatgpt',
    scenario: 'settings-general',
    routeClass: 'settings-overlay',
    sanitizedUrl: 'https://chatgpt.com/scheduled',
    title: 'ChatGPT settings',
    body: `
      <div role="dialog" aria-label="Settings">
        <nav aria-label="Settings sections">
          <button aria-current="page">General</button><button>Notifications</button><button>Personalization</button>
          <button>Plugins</button><button>Billing</button><button>Usage</button><button>Data controls</button>
          <button>Cloud browser</button><button>Storage</button><button>Security and login</button>
        </nav>
        <main><h2>General</h2><label>Appearance<select><option>System</option></select></label><label>Language<select><option>English</option></select></label></main>
      </div>`,
    evidenceSelectors: [
      evidence('settings.open', '[role="dialog"][aria-label="Settings"]', 1),
      evidence('settings.sections', 'nav[aria-label="Settings sections"] button', 10),
    ],
  }),
  fixture({
    provider: 'chatgpt',
    scenario: 'image-result',
    routeClass: 'conversation-image-result',
    sanitizedUrl: 'https://chatgpt.com/c/[redacted]',
    title: 'ChatGPT generated image result',
    body: `
      <main>
        <article data-message-author-role="assistant">
          <button aria-label="Generated image: [redacted description]"><img alt="Generated image: [redacted description]"></button>
          <button aria-label="Edit image">Edit image</button>
          <button aria-label="Share this image">Share this image</button>
          <div role="group" aria-label="Response actions"><button>Copy</button><button>Like</button><button>Dislike</button><button>More</button></div>
        </article>
      </main>`,
    evidenceSelectors: [
      evidence('image.result', 'button[aria-label^="Generated image:"] img', 1),
      evidence('image.edit', 'button[aria-label="Edit image"]', 1),
      evidence('image.share', 'button[aria-label="Share this image"]', 1),
    ],
  }),

  fixture({
    provider: 'claude',
    scenario: 'conversation-existing',
    routeClass: 'conversation',
    sanitizedUrl: 'https://claude.ai/chat/[redacted]',
    title: 'Claude existing conversation',
    body: `
      <main>
        <button aria-label="[redacted title], rename chat">[redacted title]</button>
        <div role="feed" aria-label="Chat messages">
          <article aria-label="Message 1"><h2>You said:</h2><p>[redacted message]</p></article>
          <article aria-label="Message 2"><h2>Claude responded:</h2><p>[redacted response]</p></article>
        </div>
        <div data-testid="chat-input" role="textbox" contenteditable="true" aria-label="Write your prompt to Claude"></div>
        <button aria-label="Add files, connectors, and more">Add</button>
      </main>`,
    evidenceSelectors: [
      evidence('job.existing', '[role="feed"][aria-label="Chat messages"] article', 2),
      evidence('job.continue', '[data-testid="chat-input"][role="textbox"]', 1),
    ],
  }),
  fixture({
    provider: 'claude',
    scenario: 'upload-connectors-menu-open',
    routeClass: 'new-chat',
    sanitizedUrl: 'https://claude.ai/new',
    title: 'Claude upload and connectors menu',
    body: `
      <main><button aria-label="Add files, connectors, and more" aria-expanded="true">Add</button></main>
      <div role="menu" aria-label="Add files, connectors, and more">
        <div role="menuitem">Add files or photos</div><div role="menuitem">Take a screenshot</div>
        <div role="menuitem">Add to project</div><div role="menuitem">Skills</div>
        <div role="menuitem">Add connector</div><div role="menuitem">Add plugins...</div>
        <div role="menuitemcheckbox" aria-checked="true">Web search</div>
      </div>`,
    evidenceSelectors: [
      evidence('upload.open', 'button[aria-label="Add files, connectors, and more"][aria-expanded="true"]', 1),
      evidence('tools.enumerate', '[role="menu"] [role^="menuitem"]', 7),
    ],
  }),
  fixture({
    provider: 'claude',
    scenario: 'settings-general',
    routeClass: 'settings-overlay',
    sanitizedUrl: 'https://claude.ai/new',
    title: 'Claude settings',
    body: `
      <div role="dialog" aria-label="Settings">
        <nav aria-label="Settings sections">
          <button aria-current="page">General</button><button>Account</button><button>Privacy</button><button>Billing</button>
          <button>Capabilities</button><button>Reflect</button><button>Time and focus</button><button>Claude Code</button>
          <button>Skills</button><button>Connectors</button><button>Plugins</button><button>Memory</button>
        </nav>
        <main><h2>Profile</h2><label>Full name<input value="[redacted account identity]"></label><label>Display name<input value="[redacted account identity]"></label></main>
      </div>`,
    evidenceSelectors: [
      evidence('settings.open', '[role="dialog"][aria-label="Settings"]', 1),
      evidence('settings.sections', 'nav[aria-label="Settings sections"] button', 12),
    ],
  }),
  fixture({
    provider: 'claude',
    scenario: 'connectors-settings',
    routeClass: 'connectors-settings-overlay',
    sanitizedUrl: 'https://claude.ai/new',
    title: 'Claude connectors settings',
    body: `
      <div role="dialog" aria-label="Settings">
        <button aria-current="page">Connectors</button>
        <main>
          <h2>Connectors</h2><input type="search" aria-label="Search connectors"><button>Add connector</button>
          <div role="radiogroup" aria-label="Connector status"><button role="radio" aria-checked="true">All</button><button role="radio">Connected</button><button role="radio">Not connected</button></div>
          <table><thead><tr><th>Connector</th><th>Type</th><th>Status</th></tr></thead><tbody><tr><td>GitHub</td><td>Integration</td><td><button>Connect</button></td></tr><tr><td>Notion</td><td>Integration</td><td><button>Connect</button></td></tr></tbody></table>
        </main>
      </div>`,
    evidenceSelectors: [
      evidence('connector.search', 'input[aria-label="Search connectors"]', 1),
      evidence('connector.list', 'table tbody tr', 2),
      evidence('connector.connect', 'table button', 2),
    ],
  }),
  fixture({
    provider: 'claude',
    scenario: 'projects-list',
    routeClass: 'projects',
    sanitizedUrl: 'https://claude.ai/projects',
    title: 'Claude projects',
    body: `
      <main>
        <h1>Projects</h1><button aria-label="Search projects">Search projects</button><button aria-label="Sort projects">Sort projects</button><button>New project</button>
        <ul aria-label="Projects"><li><a href="/project/[redacted]"><h2>[redacted project]</h2></a><button aria-label="Project options">More</button></li></ul>
      </main>`,
    evidenceSelectors: [
      evidence('project.list', 'ul[aria-label="Projects"] li', 1),
      evidence('project.create', 'button', 4),
    ],
  }),
  fixture({
    provider: 'claude',
    scenario: 'artifacts-list',
    routeClass: 'artifacts',
    sanitizedUrl: 'https://claude.ai/artifacts',
    title: 'Claude artifacts',
    body: `
      <main>
        <h1>Artifacts</h1><button aria-label="Search your artifacts">Search</button><button>New artifact</button>
        <ul aria-label="Artifacts"><li><a href="/chat/[redacted]"><h2>[redacted artifact]</h2></a><span>Edited</span><button aria-label="More options">More</button></li></ul>
      </main>`,
    evidenceSelectors: [
      evidence('artifact.list', 'ul[aria-label="Artifacts"] li', 1),
      evidence('artifact.create', 'button', 3),
    ],
  }),

  fixture({
    provider: 'gemini',
    scenario: 'conversation-existing',
    routeClass: 'conversation',
    sanitizedUrl: 'https://gemini.google.com/app/[redacted]',
    title: 'Gemini existing conversation',
    body: `
      <main>
        <button aria-label="Open menu for conversation actions.">More</button>
        <h1>Conversation with Gemini</h1>
        <section aria-label="Conversation turns"><article><h2>You said</h2><p>[redacted message]</p></article><article><h2>Gemini said</h2><p>[redacted response]</p><button aria-label="Good response">Good</button><button aria-label="Copy">Copy</button></article></section>
        <div role="textbox" contenteditable="true" aria-label="Enter a prompt for Gemini"></div>
      </main>`,
    evidenceSelectors: [
      evidence('job.existing', 'section[aria-label="Conversation turns"] article', 2),
      evidence('job.continue', '[role="textbox"][aria-label="Enter a prompt for Gemini"]', 1),
    ],
  }),
  fixture({
    provider: 'gemini',
    scenario: 'search-chats',
    routeClass: 'chat-search',
    sanitizedUrl: 'https://gemini.google.com/search',
    title: 'Gemini chat search',
    body: `
      <main>
        <input role="textbox" aria-label="Search chats"><h3>Recent</h3>
        <div role="listbox" aria-label="Recent"><div role="option">[redacted conversation]<span>[redacted date]</span></div><div role="option">[redacted conversation]<span>[redacted date]</span></div></div>
      </main>`,
    evidenceSelectors: [
      evidence('job.search', '[role="textbox"][aria-label="Search chats"]', 1),
      evidence('job.history', '[role="listbox"][aria-label="Recent"] [role="option"]', 2),
    ],
  }),
  fixture({
    provider: 'gemini',
    scenario: 'upload-tools-menu-open',
    routeClass: 'new-chat',
    sanitizedUrl: 'https://gemini.google.com/app',
    title: 'Gemini upload and tools menu',
    body: `
      <main><button aria-label="Upload and tools" aria-expanded="true">Add</button></main>
      <div role="menu" aria-label="Menu options">
        <div role="menuitem" aria-label="Upload files. Documents, data, code files">Upload files</div><div role="menuitem" aria-label="Add from Drive. Sheets, Docs, Slides">Add from Drive</div>
        <button aria-label="More uploads">More uploads</button><div role="menuitemcheckbox">Create image</div><div role="menuitemcheckbox">Canvas</div><div role="menuitemcheckbox">Deep Research</div>
      </div>`,
    evidenceSelectors: [
      evidence('upload.open', 'button[aria-label="Upload and tools"][aria-expanded="true"]', 1),
      evidence('tools.enumerate', '[role="menu"] [role^="menuitem"]', 5),
    ],
  }),
  fixture({
    provider: 'gemini',
    scenario: 'upload-sources-open',
    routeClass: 'new-chat',
    sanitizedUrl: 'https://gemini.google.com/app',
    title: 'Gemini upload sources',
    body: `
      <div role="menu" aria-label="Menu options"><button aria-label="More uploads" aria-expanded="true">More uploads</button></div>
      <div role="group" aria-label="More upload options"><div role="menuitem">Google Photos</div><div role="menuitem">Avatar</div><div role="menuitem">Notebooks</div></div>`,
    evidenceSelectors: [
      evidence('upload.sources', '[role="group"][aria-label="More upload options"] [role="menuitem"]', 3),
      evidence('upload.expand', 'button[aria-label="More uploads"][aria-expanded="true"]', 1),
    ],
  }),
  fixture({
    provider: 'gemini',
    scenario: 'settings-menu-open',
    routeClass: 'settings-menu',
    sanitizedUrl: 'https://gemini.google.com/app',
    title: 'Gemini settings menu',
    body: `
      <button aria-label="Settings" aria-expanded="true">Settings</button>
      <div role="menu" aria-label="Settings">
        <div role="menuitem">Activity</div><div role="menuitem">Personal Intelligence</div><div role="menuitem">Import memory to Gemini</div>
        <div role="menuitem">Usage limits</div><div role="menuitem">Gems</div><div role="menuitem">Your public links</div>
        <div role="menuitem">Theme</div><div role="menuitem">View subscriptions</div><div role="menuitem">Gemini Notebook</div>
      </div>`,
    evidenceSelectors: [
      evidence('settings.open', 'button[aria-label="Settings"][aria-expanded="true"]', 1),
      evidence('settings.sections', '[role="menu"][aria-label="Settings"] [role="menuitem"]', 9),
    ],
  }),
  fixture({
    provider: 'gemini',
    scenario: 'image-workspace',
    routeClass: 'images',
    sanitizedUrl: 'https://gemini.google.com/images',
    title: 'Gemini image workspace',
    body: `
      <main>
        <div role="textbox" contenteditable="true" aria-label="Enter a prompt for Gemini" data-placeholder="Describe your image"></div>
        <div role="dialog" aria-label="Create images"><h2>Create images</h2><p>with Nano Banana 2</p><section><h3>Try a template</h3><p>Just add an image to get started</p></section><section><h3>Visualise anything</h3><p>Describe an idea in chat</p></section><button>Try it</button></div>
      </main>`,
    evidenceSelectors: [
      evidence('image.create', '[role="dialog"][aria-label="Create images"]', 1),
      evidence('image.prompt', '[role="textbox"][data-placeholder="Describe your image"]', 1),
    ],
  }),
  fixture({
    provider: 'gemini',
    scenario: 'library-media',
    routeClass: 'library',
    sanitizedUrl: 'https://gemini.google.com/library',
    title: 'Gemini library',
    body: `
      <main>
        <h1>Library</h1><section aria-label="Documents"><h2>Documents</h2><p>Documents that you create will appear here</p></section>
        <section aria-label="Media"><h2>Media</h2><button aria-label="Preview or open"><img alt="[redacted media]"></button><button aria-label="Delete media">Delete</button></section>
      </main>`,
    evidenceSelectors: [
      evidence('library.sections', 'main section', 2),
      evidence('image.retrieve', 'button[aria-label="Preview or open"] img', 1),
    ],
  }),

  fixture({
    provider: 'grok',
    scenario: 'attach-menu-open',
    routeClass: 'new-chat',
    sanitizedUrl: 'https://grok.com/',
    title: 'Grok attachment menu',
    body: `
      <main><button data-testid="attach-button" aria-label="Attach" aria-expanded="true">Attach</button></main>
      <div role="menu" aria-label="Attach"><div role="menuitem">Upload a file</div><div role="menuitem">Recent</div><div role="menuitem">Skills</div><div role="menuitem">Add connector</div></div>`,
    evidenceSelectors: [
      evidence('upload.open', 'button[data-testid="attach-button"][aria-expanded="true"]', 1),
      evidence('tools.enumerate', '[role="menu"][aria-label="Attach"] [role="menuitem"]', 4),
    ],
  }),
  fixture({
    provider: 'grok',
    scenario: 'skills-list',
    routeClass: 'skills',
    sanitizedUrl: 'https://grok.com/skills-and-connectors',
    title: 'Grok skills',
    body: `
      <main>
        <h1>Skills and Connectors</h1><button>New Skill</button><div role="tablist"><button role="tab" aria-selected="true">Skills</button><button role="tab">Connectors</button></div><input type="search" aria-label="Search">
        <section aria-label="Personal skills"><button>Word Documents</button><button>PDFs</button><button>Presentations</button><button>Spreadsheets</button><button>Skill Creator</button></section>
      </main>`,
    evidenceSelectors: [
      evidence('skill.list', 'section[aria-label="Personal skills"] button', 5),
      evidence('skill.create', 'main > button', 1),
    ],
  }),
  fixture({
    provider: 'grok',
    scenario: 'connectors-list',
    routeClass: 'connectors',
    sanitizedUrl: 'https://grok.com/connectors',
    title: 'Grok connectors',
    body: `
      <main>
        <h1>Skills and Connectors</h1><button>New Connector</button><div role="tablist"><button role="tab">Skills</button><button role="tab" aria-selected="true">Connectors</button></div><input type="search" aria-label="Search">
        <section aria-label="Featured connectors"><button>Gmail</button><button>Google Calendar</button><button>Google Drive</button><button>GitHub</button><button>Box</button><button>Canva</button><button>Notion</button><button>Stripe</button><button>Vercel</button></section>
      </main>`,
    evidenceSelectors: [
      evidence('connector.list', 'section[aria-label="Featured connectors"] button', 9),
      evidence('connector.create', 'main > button', 1),
    ],
  }),
  fixture({
    provider: 'grok',
    scenario: 'imagine-workspace',
    routeClass: 'imagine',
    sanitizedUrl: 'https://grok.com/imagine',
    title: 'Grok Imagine workspace',
    body: `
      <main>
        <h1>Featured Templates</h1><section aria-label="Featured templates"><button>Glossy Product Shot</button><button>Chibi</button><button>Object Remover</button><button>Professional Headshot</button></section>
        <div role="textbox" contenteditable="true" aria-label="Ask Grok anything" data-placeholder="Type to imagine"></div><button aria-label="Upload">Upload</button>
        <div role="radiogroup" aria-label="Generation mode"><label><input type="radio" checked>Image</label><label><input type="radio">Video</label><label><input type="radio">Agent</label></div>
        <button aria-label="Image Count">Auto</button><button aria-label="Aspect Ratio">2:3</button>
      </main>`,
    evidenceSelectors: [
      evidence('image.prompt', '[role="textbox"][data-placeholder="Type to imagine"]', 1),
      evidence('image.mode', '[role="radiogroup"][aria-label="Generation mode"] input', 3),
      evidence('image.upload', 'button[aria-label="Upload"]', 1),
    ],
  }),
  fixture({
    provider: 'grok',
    scenario: 'automations-list',
    routeClass: 'automations',
    sanitizedUrl: 'https://grok.com/automations',
    title: 'Grok automations',
    body: `
      <main>
        <h1>Automations</h1><button aria-label="New Automation">New Automation</button><h2>Suggested</h2>
        <section aria-label="Suggested automations"><article><h3>Email Auto-Responder</h3><button>Add</button></article><article><h3>Daily Stock Tracker</h3><button>Add</button></article><article><h3>Task Extractor</h3><button>Add</button></article></section>
      </main>`,
    evidenceSelectors: [
      evidence('automation.list', 'section[aria-label="Suggested automations"] article', 3),
      evidence('automation.create', 'button[aria-label="New Automation"]', 1),
    ],
  }),
  fixture({
    provider: 'grok',
    scenario: 'automation-new',
    routeClass: 'automation-create-overlay',
    sanitizedUrl: 'https://grok.com/automations',
    title: 'Grok new automation',
    body: `
      <div role="dialog" aria-label="New Automation">
        <button aria-label="Close">Close</button><input aria-label="Automation Name" value="My Automation"><h3>Triggers</h3><button>Add Trigger</button>
        <h3>Instructions</h3><div role="textbox" contenteditable="true" aria-label="Ask Grok anything"></div><button aria-label="Attach">Attach</button>
        <button aria-label="Connectors">Connectors 0</button><button aria-label="Skills">Skills 0</button><button aria-label="Model select">Fast</button>
        <button>Cancel</button><button disabled>Save</button>
      </div>`,
    evidenceSelectors: [
      evidence('automation.form', '[role="dialog"][aria-label="New Automation"]', 1),
      evidence('automation.trigger', 'button:not([disabled])', 7),
      evidence('automation.save-guard', 'button[disabled]', 1),
    ],
  }),
  fixture({
    provider: 'grok',
    scenario: 'settings-account',
    routeClass: 'settings-overlay',
    sanitizedUrl: 'https://grok.com/',
    title: 'Grok account settings',
    body: `
      <div role="dialog" aria-label="Settings">
        <nav aria-label="Settings sections"><button aria-current="page">Account</button><button>Appearance</button><button>Behavior</button><button>Customize</button><button>Data Controls</button></nav>
        <main><h2>Account</h2><p>[redacted account identity]</p><section aria-label="Plan"><span>Basic</span><p>Get SuperGrok</p><button>Upgrade</button></section><button aria-label="Language">Change</button><button aria-label="Birth Year">Change</button></main>
      </div>`,
    evidenceSelectors: [
      evidence('settings.open', '[role="dialog"][aria-label="Settings"]', 1),
      evidence('plan.visible', 'section[aria-label="Plan"]', 1),
      evidence('plan.upgrade', 'section[aria-label="Plan"] button', 1),
    ],
    notes: ['The account panel exposes Basic and an upgrade action; runtime plan inference still uses model entitlement availability.'],
  }),
  fixture({
    provider: 'grok',
    scenario: 'search-history-empty',
    routeClass: 'chat-search-overlay',
    sanitizedUrl: 'https://grok.com/',
    title: 'Grok empty chat history',
    body: `
      <div role="dialog" aria-label="Command Menu">
        <input role="combobox" aria-label="Command Menu" aria-expanded="true"><div role="listbox" aria-label="Suggestions">
          <div role="group" aria-label="Actions"><div role="option" aria-selected="true">Create New Private Chat</div></div>
          <div role="group" aria-label="History"><p>History is empty</p></div>
        </div><button aria-label="Hide Conversation Previews">Hide previews</button>
      </div>`,
    evidenceSelectors: [
      evidence('job.search', '[role="combobox"][aria-label="Command Menu"]', 1),
      evidence('job.history-empty', '[role="group"][aria-label="History"] p', 1),
    ],
    absenceSelectors: [
      absence('no-observed-existing-conversations', '[role="group"][aria-label="History"] [role="option"]', 0),
    ],
  }),
  fixture({
    provider: 'grok',
    scenario: 'project-new',
    routeClass: 'project-create-overlay',
    sanitizedUrl: 'https://grok.com/',
    title: 'Grok new project',
    body: `
      <div role="dialog" aria-label="New Project">
        <button aria-label="Close">Close</button><input aria-label="Project name"><label>Project Instructions<textarea aria-label="Project Instructions" placeholder="Add instructions about the tone, style, and persona you want Grok to adopt."></textarea></label>
        <button>Cancel</button><button>Next</button>
      </div>`,
    evidenceSelectors: [
      evidence('project.form', '[role="dialog"][aria-label="New Project"]', 1),
      evidence('project.name', 'input[aria-label="Project name"]', 1),
      evidence('project.instructions', 'textarea[aria-label="Project Instructions"]', 1),
    ],
  }),
]

for (const entry of fixtures) {
  const accountRoot = path.join(fixtureRoot, entry.provider, entry.accountState)
  await fs.mkdir(accountRoot, { recursive: true })
  const html = document(entry.title, entry.body)
  const htmlPath = path.join(accountRoot, `${entry.scenario}.html`)
  const provenancePath = path.join(accountRoot, `${entry.scenario}.provenance.json`)
  await fs.writeFile(htmlPath, html)
  await fs.writeFile(provenancePath, `${JSON.stringify({
    schema: 'tokenless.provider-dom-provenance.v1',
    provider: entry.provider,
    accountState: entry.accountState,
    observedPlan: entry.observedPlan,
    scenario: entry.scenario,
    routeClass: entry.routeClass,
    operationPhase: entry.operationPhase,
    capabilityOutcome: entry.capabilityOutcome,
    observedOn,
    sanitizedUrl: entry.sanitizedUrl,
    source,
    artifactKind: 'redacted-reduced-dom',
    containsProviderJavaScript: false,
    containsSyntheticBehavior: false,
    contentSha256: sha256(html),
    evidenceSelectors: entry.evidenceSelectors,
    absenceSelectors: entry.absenceSelectors,
    redactions,
    notes: entry.notes,
  }, null, 2)}\n`)
}

const manifestEntries = []
for (const provider of Object.keys(states)) {
  const providerRoot = path.join(fixtureRoot, provider)
  const accountStates = await fs.readdir(providerRoot, { withFileTypes: true })
  for (const accountState of accountStates.filter((entry) => entry.isDirectory())) {
    const files = await fs.readdir(path.join(providerRoot, accountState.name))
    for (const file of files.filter((name) => name.endsWith('.provenance.json'))) {
      const provenance = JSON.parse(await fs.readFile(
        path.join(providerRoot, accountState.name, file),
        'utf8'
      ))
      manifestEntries.push({
        provider,
        accountState: accountState.name,
        scenario: provenance.scenario,
        routeClass: provenance.routeClass,
        operationPhase: provenance.operationPhase ?? fixtureWorkflowMetadata(provenance.scenario).operationPhase,
        capabilityOutcome: provenance.capabilityOutcome ?? fixtureWorkflowMetadata(provenance.scenario).capabilityOutcome,
        sanitizedUrl: provenance.sanitizedUrl,
        observedOn: provenance.observedOn,
        htmlPath: `${provider}/${accountState.name}/${provenance.scenario}.html`,
        provenancePath: `${provider}/${accountState.name}/${provenance.scenario}.provenance.json`,
      })
    }
  }
}

manifestEntries.sort((left, right) => (
  left.provider.localeCompare(right.provider)
  || left.accountState.localeCompare(right.accountState)
  || left.scenario.localeCompare(right.scenario)
))

await fs.writeFile(path.join(fixtureRoot, 'manifest.json'), `${JSON.stringify({
  schema: 'tokenless.provider-dom-manifest.v2',
  generatedBy: 'test/helpers/build-provider-workflow-fixtures.mjs',
  fixtures: manifestEntries,
}, null, 2)}\n`)

console.log(`Wrote ${fixtures.length} deep workflow fixtures and inventoried ${manifestEntries.length} total fixtures.`)

function fixture({
  provider,
  scenario,
  routeClass,
  sanitizedUrl,
  title,
  body,
  evidenceSelectors,
  absenceSelectors = [],
  notes = [],
}) {
  return {
    provider,
    accountState: states[provider],
    observedPlan: plans[provider],
    scenario,
    routeClass,
    ...fixtureWorkflowMetadata(scenario),
    sanitizedUrl,
    title,
    body,
    evidenceSelectors,
    absenceSelectors,
    notes,
  }
}

function fixtureWorkflowMetadata(scenario) {
  if (scenario === 'conversation-existing') {
    return { operationPhase: 'conversation-existing', capabilityOutcome: 'available' }
  }
  if (scenario === 'file-input-ready') {
    return { operationPhase: 'file-input-ready', capabilityOutcome: 'available' }
  }
  if (
    scenario === 'upload-tools-menu-open' ||
    scenario === 'upload-connectors-menu-open' ||
    scenario === 'upload-sources-open' ||
    scenario === 'attach-menu-open'
  ) {
    return { operationPhase: 'upload-menu-open', capabilityOutcome: 'available' }
  }
  if (scenario === 'projects-list') {
    return { operationPhase: 'workspace-list', capabilityOutcome: 'available' }
  }
  if (scenario === 'project-new') {
    return { operationPhase: 'workspace-create-form', capabilityOutcome: 'unknown' }
  }
  return { operationPhase: 'observed', capabilityOutcome: 'available' }
}

function evidence(capability, selector, expectedCount) {
  return { capability, selector, expectedCount }
}

function absence(purpose, selector, expectedCount) {
  return { purpose, selector, expectedCount }
}

function document(title, body) {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>${body}
  </body>
</html>
`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
