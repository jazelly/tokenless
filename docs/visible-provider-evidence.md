# Visible provider evidence

Tokenless visible-session adapters operate only through provider UI that a user
can see and authorize in the browser. They do not read provider cookies,
`localStorage` or `sessionStorage` credentials, hidden authorization headers,
or private provider APIs.

Provider products and DOM can change. Runtime code treats the current visible
UI as authoritative and fails closed when a required control or state cannot be
verified.

## Evidence states

Three states must not be conflated:

- **Observed DOM** means a control was visible in a user-authorized browser
  session and its adapter-relevant markup was reduced into a redacted fixture.
  Observation alone does not enable an action.
- **Implemented** means an extension content path can inspect or operate that
  control. Implementation alone does not prove the provider accepted the
  resulting action.
- **Accepted** means the named implementation boundary has a focused automated
  proof. A reduced-DOM selector test, a full extension/native-host fixture E2E,
  and a live provider mutation are different acceptance boundaries and are
  described separately.

The unified visible-provider capability manifest is the runtime source of
truth. An action is exposed only when its manifest state is `verified`;
`pending_evidence` and `unsupported` actions fail closed. Adding an observed
fixture never changes that state by itself.

## Published Free access baseline

Provider documentation confirms that all four products have a Free web entry
point, but published availability is not proof of the current browser account,
its remaining quota, or a particular visible control:

| Provider | Current official Free-web baseline | Tokenless interpretation |
| --- | --- | --- |
| ChatGPT | The [Free Tier FAQ](https://help.openai.com/en/articles/9275245-using-chatgpt-s-free-tier) lists model access, web tools, and file/image uploads with tighter limits; [Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) are also available with Free-specific file limits. | Free sessions can be useful, but the captured authenticated session was Plus and the current visible menu/limit always wins. |
| Claude | Anthropic lists a [$0 Free plan](https://support.anthropic.com/en/articles/11049762-choosing-a-claude-ai-plan), and its [file-upload documentation](https://support.anthropic.com/en/articles/8241126-what-kinds-of-documents-can-i-upload-to-claude-ai) covers visible chat attachments. | The captured authenticated session visibly reported Free; model and effort availability is still read from that session's DOM. |
| Gemini | Google's [Gemini Apps limits](https://support.google.com/gemini/answer/16275805?hl=en-AG) document no-AI-plan access to multiple modes and Extended thinking; [file uploads](https://support.google.com/gemini/answer/14903178?hl=en-SG) require sign-in and apply stricter limits without Pro or Ultra. | The captured session was signed in but had no reliable plan label, so Tokenless reports its plan as unknown. |
| Grok | xAI lists a limited [$0 Free plan](https://x.ai/pricing), while the [Grok overview](https://docs.x.ai/grok/overview) documents visible file use and higher paid limits. | The captured session's plan remains unknown; visible Upgrade evidence makes unavailable model profiles fail closed. |

These sources answer whether a Free route exists. They do not authorize
Tokenless to infer authentication, plan, quota, model entitlement, or upload
acceptance without current visible DOM evidence.

## Authenticated fixture corpus

On 2026-07-17, four new, blank provider tabs were inspected through the user's
signed-in Chrome profile. No account name, email, chat title, message content,
or private route was retained. No prompt was submitted and no file was
uploaded. Temporary model or thinking selections used to inspect visible state
were restored.

The fixtures live under:

```text
test/fixtures/provider-dom/<provider>/<account-state>/<scenario>.html
```

Each HTML file has a same-basename `.provenance.json` sidecar containing the
provider, account state, observed plan or `unknown`, scenario, sanitized public
route, evidence selectors, redaction notes, and a SHA-256 of the HTML. The
authenticated fixtures are static reduced DOM: they contain no provider
JavaScript and no synthetic behavior.

Five priority scenarios are retained for every provider:

- `session-status`
- `model-menu-open`
- `thinking-effort-menu-open`
- `file-input-ready`
- `composer-idle`

The account and plan observations are deliberately narrow:

| Provider | Fixture account state | Visible plan evidence | What may be inferred |
| --- | --- | --- | --- |
| ChatGPT | `signed-in-paid` | Plus | These controls were visible on one Plus account. This is not authenticated Free-plan proof. |
| Claude | `signed-in-free` | Free plan | The retained auth, model, effort, file-input, and composer controls were visible on one Free account. Limits remain provider-controlled. |
| Gemini | `signed-in-unknown` | None | The account was signed in. A current model label does not establish the account's plan. |
| Grok | `signed-in-unknown` | None | The account was signed in. Published Free availability and visible upsells do not identify this account's plan. |

Existing unauthenticated, public-share, and deterministic harness fixtures are
preserved separately. Their provider DOM and their synthetic test transitions
must not be cited as authenticated provider acceptance.

## Unified visible action contract

The versioned action vocabulary covers:

- `auth.status`
- `model.inspect` and `model.select`
- `effort.inspect` and `effort.select`
- `file.upload` and `skill.upload`
- connector inspection and selection
- `prompt.input` and `prompt.submit`
- project inspection and opening
- history inspection and opening

The first implementation priority is authentication status, model selection,
thinking effort, file upload, and prompt input.

`tokenless provider-status` and its `provider-auth-status` alias inspect only
visible sign-in signals. The response may expose an allowlisted plan label such
as Free or Plus, but never account identity. Ambiguous or contradictory visible
signals return `unknown`.

Model and effort requests use complete visible labels after whitespace and case
normalization. `--effort` is an exact provider-visible label for every provider;
ChatGPT's chat-surface and trusted-debugger controls remain ChatGPT-specific.
Ordered model fallbacks are tried only when their exact rows are visibly
available, and the selected state must be verified after interaction.

Repeated `run --attach-file <path>` arguments use the existing visible
attachment transport. The CLI stages regular non-symlink files into a private
bundle and sends path-free size/SHA-256 descriptors. The native host streams
bounded bytes for the claimed job, and the content script reconstructs browser
`File` objects for one exact provider input. Submission requires new visible
filename evidence. The standalone unified `file.upload` action remains
capability-gated because a direct action request does not itself provide that
daemon/native byte context.

Project-isolated submission currently accepts an exact existing ChatGPT or
Claude Project URL and permits only the corresponding same-Project
conversation transition. Project discovery, creation, and picker automation
are separate actions and remain capability-gated.

## ChatGPT

The [ChatGPT Free Tier FAQ](https://help.openai.com/en/articles/9275245-using-chatgpt-s-free-tier-faq)
documents a Free offering, while the authenticated account inspected here
visibly reported Plus. Published Free availability is product documentation,
not evidence that the authenticated fixture came from a Free account.

### Observed DOM

The authenticated fixtures retain:

- `[data-testid="accounts-profile-button"][role="button"]` as the positive
  signed-in signal, with account identity redacted and only Plus retained;
- `div#prompt-textarea[contenteditable="true"][role="textbox"]` and its
  textarea fallback;
- `button[data-testid="composer-plus-btn"][aria-label="Add files and more"]`;
- `input#upload-files[type="file"][multiple]` as the generic file input;
- the composer Intelligence pill, `menuitemradio` effort rows, model submenu,
  and `aria-checked` selected state.

This account showed three current effort labels: Instant, Medium, and High.
That observation replaces any fixed five-level assumption but does not define
a provider-wide count or order. Model primary labels remain separate from
secondary lifecycle text.

### Implementation and acceptance

Authentication, exact model inspection/selection, exact effort
inspection/selection, and prompt input are implemented in the content adapter.
The ChatGPT/Claude focused control suite and extension build are green for the
captured dynamic menu structure. Unified action exposure still follows the
capability manifest and its bridge-level tests.

The existing attachment pipeline uses only `#upload-files` and requires visible
filename confirmation. Image-only inputs are not generic attachment fallbacks.
No real file was uploaded during the authenticated DOM observation.

An exact target such as
`https://chatgpt.com/g/<g-p-project-id>/project` may transition only to
`/g/<same-g-p-project-id>/c/<conversation-id>`. Tokenless does not yet create or
select a Project through the unified action API.

## Claude

[Claude pricing](https://claude.com/pricing) documents a Free web plan, and the
authenticated session inspected here also visibly displayed `Free plan`. This
is direct evidence that the retained controls were present on that Free
account; it is not a promise of fixed quotas or universal model availability.

### Observed DOM

The authenticated fixtures retain:

- `button[data-testid="user-menu-button"]` plus a separate visible Free-plan
  label;
- `button[data-testid="model-selector-dropdown"][aria-label^="Model: "]`;
- visible `menuitemradio` model rows, with `aria-checked` selection;
- `div[data-testid="chat-input"][contenteditable="true"][role="textbox"]`;
- `input#chat-input-file-upload-onpage[data-testid="file-upload"][aria-label="Upload files"][type="file"][multiple]`;
- exact Chats, Projects, and Customize navigation links.

Fable 5 and Opus 4.8 carried visible Upgrade evidence, while Sonnet 5 and Haiku
4.5 were enabled on the observed account. Availability therefore fails closed
on the visible Upgrade descendant rather than relying only on `aria-disabled`.

Effort is model-dependent. Haiku exposed an Extended switch. In a temporary
Sonnet state, the UI exposed Low, Medium, High, Extra, and Max effort rows plus
a Thinking switch. The session was restored to Haiku after inspection.

The Add menu also visibly contained Skills and Add connector entries, but menu
presence is only observed DOM; skill upload and connector actions are not
accepted by that observation.

### Implementation and acceptance

Claude authentication, exact model selection, model-dependent effort, and
prompt input are implemented. Focused authenticated-fixture control tests and
the extension build are green. The older full-chain fixture separately accepts
prompt submission, conversation navigation, streaming completion, stable-answer
selection, blocker detection, and selector-drift failure.

The attachment receiver is implemented for the exact input and accepted by
local extension/native-host fixture coverage, with visible filename evidence
required before submission. No provider-owned file upload was performed during
the authenticated capture.

An exact `https://claude.ai/project/<project-id>` target may transition only to
`/project/<same-project-id>/chat/<conversation-id>`. Native project discovery,
creation, and picker actions remain capability-gated.

## Gemini

[Gemini Apps availability](https://support.google.com/gemini/answer/13278668?hl=en)
documents that some web features can be used without signing in. The new
authenticated fixture proves a signed-in session through its visible Google
account SignOutOptions link, but no reliable plan label was present. The account
state is therefore `signed-in-unknown`, not Free or paid.

### Observed DOM

The authenticated fixtures retain:

- `rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Enter a prompt for Gemini"]`;
- `button[data-test-id="bard-mode-menu-button"][aria-haspopup]`;
- `gem-menu-item[role="menuitem"][data-mode-id]` and each primary `.label`;
- `gem-menu-item-content.selected` as committed model state;
- the independent Extended thinking row;
- `button[aria-label="Upload and tools"]` and the exact local uploader item;
- the dynamically created `input[type="file"][name="Filedata"][multiple]`.

`data-active="true"` is keyboard highlight, not committed selection. Adapters
must use the nested `.selected` state. The exact file input appeared only after
the local upload item opened a file chooser; the chooser was intercepted and no
file was selected.

### Implementation and acceptance

Gemini prompt input, model inventory/selection, Extended thinking handling, and
dynamic file-input preparation have content-adapter implementations. Runtime
exposure remains action-specific: an authenticated selector fixture does not
substitute for a provider-owned upload or generation-completion proof.

The current authenticated sidebar exposed chat search but did not establish a
safe Project or Gem isolation workflow. Those actions remain capability-gated.

## Grok

[Grok pricing](https://x.ai/pricing) and the
[Grok overview](https://docs.x.ai/grok/overview) document a Free offering. The
authenticated account inspected here had no reliable visible plan label, so
its fixture remains `signed-in-unknown`. Tokenless does not infer this account's
plan from published pricing, a composer, or an upsell.

### Observed DOM

The authenticated fixtures retain:

- `a[href="/skills-and-connectors"]` as a positive signed-in signal;
- `div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]`;
- `button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]`;
- model rows as `[role="menuitem"][data-radix-collection-item]` with primary
  `span.font-semibold` labels;
- `button[data-testid="attach-button"][aria-label="Attach"][aria-haspopup="menu"]`;
- `input[type="file"][name="files"][multiple]`;
- visible Projects, History, Search, Skills, and connector entry points.

Fast was the selected executable model on this account. Auto, Expert, and Heavy
were visible rows and reported `aria-disabled="false"`, but the same menu showed
an Upgrade action and those rows led to the upsell. The adapter therefore treats
only the selected Fast row as available while that Upgrade prompt is visible.
This is account-specific entitlement evidence, not proof of a Free plan.

Expert and Heavy describe thinking depth as model profiles. No independent
effort control was observed, so a separate Grok effort request fails closed as
coupled to model selection.

### Implementation and acceptance

Grok authentication, prompt input, exact model inventory/selection, model-coupled
effort rejection, and the exact attachment input have content-adapter paths.
Availability uses the visible Upgrade evidence rather than trusting
`aria-disabled="false"` alone.

The signed-out harness still proves that an interactive anonymous composer may
end at the visible signup paywall. Authenticated generation completion remains
separate from the new static DOM evidence because no authenticated prompt was
submitted during capture.

Project creation UI and history controls were observed, including a New Project
dialog, but no project was created. Project, history, skill, and connector
actions remain capability-gated until their implementations and focused visible
state transitions are accepted.
