# Tokenless Domain Context

## Page Ref

A **Page Ref** is a caller-controlled logical identity for one provider page.
It is independent from a Task ID, Playwright `Page`, and Chromium target ID.

- A caller reuses a Page Ref when later work must continue in the same tab.
- Independent work uses distinct Page Refs even when it targets the same provider.
- A new managed job gets an independent Page Ref unless the caller supplies one.
- Legacy v3 jobs without a Page Ref use a job-scoped compatibility Ref.

## Page Binding

A **Page Binding** is the runtime association between one Page Ref and one live Playwright `Page`.
The binding is scoped by managed profile and provider.

```text
profile + provider + Page Ref  <->  live Playwright Page
```

Page Bindings are runtime state, not a durable page inventory.
The job request persists only the Page Ref; live pages, leases, generations, and close events remain in memory.

## Provider Page

A **Provider Page** is a live tab owned by or navigable to one visible provider.
The browser context's current pages are the source of truth for whether it still exists.

## Relationships and lifecycle

1. Acquire queries the current `BrowserContext.pages()` and reconciles any stale binding.
2. The same live Page Ref reuses its Page Binding; a concurrently leased Ref is busy.
3. A different Page Ref never takes over another Ref's idle binding.
4. Release makes the binding idle without transferring ownership.
5. A user-closed or crashed page invalidates only that binding.
6. Closing a tab never closes the managed profile, and no eager replacement is created.
7. The next explicit acquire may adopt an unclaimed matching tab or create a new tab.
8. Automatic idle cleanup closes only Tokenless-owned pages and never removes the last live page for a provider.

## Example

```text
pageRef=case-a              -> tab A
pageRef=case-b              -> tab B
pageRef=conversation-c      -> tab C (turn 1)
pageRef=conversation-c      -> tab C (turn 2)
```
