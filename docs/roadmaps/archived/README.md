# Archived Roadmaps

This directory contains roadmaps that are completed, superseded, cancelled, or no longer planned.

Archived roadmaps are retained as decision history and are not active product commitments. Each archived roadmap must state its disposition near the top:

- `completed`, including the completion date or release when known;
- `superseded`, with a link to the replacement roadmap;
- `cancelled`, with a concise reason; or
- `retired`, with a concise explanation of why the direction is no longer planned.

When archiving a roadmap:

- add it to the archive section of the parent [roadmap index](../README.md);
- update all repository links to its new path;
- add or update its disposition note; and
- preserve its historical content unless correcting an objective factual error.

An archived roadmap may return to the parent directory only when the direction is explicitly reactivated and its assumptions and acceptance criteria have been reviewed.

Archived roadmap filenames retain the `P0-` through `P3-` product-priority prefix declared in the document.

## Archived Roadmaps

| Roadmap | Disposition |
| --- | --- |
| [Browser Connection Mode Capability Evaluation](P0-browser-connection-mode-capability-evaluation.md) | Completed 2026-08-09 after native Playwright and CDP evidence supported consolidating browser control on CDP. |
| [Daemon Fastify HTTP API](P1-daemon-fastify-http-api.md) | Cancelled 2026-07-27 after the daemon v1 clean break kept the smaller built-in HTTP server and moved worker coordination in-process. |
| [Provider Architecture and Registry](P0-provider-architecture-and-registry.md) | Completed 2026-07-27 after the OOP provider seam, single registry, daemon negotiation, compatibility cleanup, and first new-provider proof were accepted. |
