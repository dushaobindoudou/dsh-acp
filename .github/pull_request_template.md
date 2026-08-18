## What

One paragraph: the capability or fix this PR delivers.

## Why

The problem or request it addresses (issue link if any).

## How

Key design decisions reviewers should weigh in on. Protocol changes must state
their wire shape and interop impact (standard clients must never see vendor
traffic unless opted in).

## Verification

- [ ] `pnpm test` green
- [ ] affected e2e suite(s) green (`pnpm run test:e2e` or the specific suite)
- [ ] docs updated (README.md + README.zh.md + CHANGELOG unreleased entry)
