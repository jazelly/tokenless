# Security Boundary

Core protocol messages carry only bounded semantic identifiers, content digests, finalized visible text, citations, lifecycle, and stable errors. Each reference has a required kind prefix (`request:`, `provider:`, `binding:`, `conversation:`, `turn:`, or `attachment:`) and exactly 32 lowercase hexadecimal characters; bare values, slashes, and filesystem paths are invalid.

The schemas and parsers reject unknown fields and reject fields named for secrets, tokens, profiles, paths, job stores or job ids, and browsers. They do not contain credentials, authentication headers, cookies, local paths, browser profiles, provider DOM, daemon job identifiers, MCP, AgentRun, tool calls, or Harness control envelopes. Skill attachments expose only opaque references, bounded display names, byte lengths, and digests; their contents remain in the authenticated local upload transport.

Citation URLs are limited to `http` and `https`. Evidence, provider metadata, and transport authentication are outside this V0 core slice.
