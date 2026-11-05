# Changelog

## 1.0.2

- Repository layout follows the n8n node starter (`nodes/`, `credentials/` at the root) so the Creator Portal finds the sources.
- Source passes the verification scanner: `usableAsTool`, `NodeConnectionTypes.Main`, themed icons, credential icon, and the media node always throws `NodeOperationError`.

## 1.0.1

- Passes the official n8n community package scanner (verification requirement).
- Zihin (media): authenticates through the `zihinApi` credential (`httpRequestWithAuthentication`) instead of setting the `X-Api-Key` header by hand.
- Zihin Agent: uses `@zihin/agent-client/core` with n8n's `sleepWithAbort` for retry backoff and the call deadline; deprecation notices go to the n8n logger. No behavior change for workflows.

## 1.0.0 — 2026-11

**Breaking:** the deprecated **Zihin Chat Model** sub-node (`lmChatZihin`) is removed, as announced in 0.7.0. It called the direct LLM gateway, outside the agent's RBAC, quotas, human approvals and audit. Replace it with the **Zihin Agent** node.

- The package no longer declares `@langchain/core` as a peer dependency; `n8n-workflow` is the only peer.
- Zero runtime dependencies: the Zihin agent client is bundled at build time.
- Published from this repository by GitHub Actions with npm provenance.
- No behaviour change in **Zihin Agent** or **Zihin** (media) compared with 0.12.0.

## 0.12.0 and earlier

Published from Zihin's internal integrations monorepo. The versions remain available on npm; see the [npm version history](https://www.npmjs.com/package/n8n-nodes-zihin?activeTab=versions).
