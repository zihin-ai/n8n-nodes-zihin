# Changelog

## 1.0.0 — 2026-11

**Breaking:** the deprecated **Zihin Chat Model** sub-node (`lmChatZihin`) is removed, as announced in 0.7.0. It called the direct LLM gateway, outside the agent's RBAC, quotas, human approvals and audit. Replace it with the **Zihin Agent** node.

- The package no longer declares `@langchain/core` as a peer dependency; `n8n-workflow` is the only peer.
- Zero runtime dependencies: the Zihin agent client is bundled at build time.
- Published from this repository by GitHub Actions with npm provenance.
- No behaviour change in **Zihin Agent** or **Zihin** (media) compared with 0.12.0.

## 0.12.0 and earlier

Published from Zihin's internal integrations monorepo. The versions remain available on npm; see the [npm version history](https://www.npmjs.com/package/n8n-nodes-zihin?activeTab=versions).
