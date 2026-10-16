## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one, e.g. "Fixes #22". -->

## How it was tested

<!-- npm test, and anything else: a manual check against a VSP 360 (without identifying details), the MCP Inspector, a package build. -->

## Checklist

- [ ] `npm test` passes (unit tests and the search evaluation).
- [ ] New behaviour has tests; a bug fix has a test that fails without it.
- [ ] No data from a real VSP 360 is included: names, serial numbers, WWNs, host names, IP addresses or user names. Files were staged by name, not with `git add -A`.
- [ ] Docs describing the change are updated (README, INSTALL.md, README.docker.md, README.plugin.md, SECURITY.md as relevant).
- [ ] A line is added under `## Unreleased` in `CHANGELOG.md`, if users would notice the change.
- [ ] If search scores improved, their thresholds in `tests/search-eval.mjs` are raised. No threshold is lowered.

## Safety

<!-- Does this change what Claude can do on its own: which operations count as reads, which secrets are gated, which files can be read or written, or where requests and credentials can go? If so, explain why it's safe, and point to the tests. See SECURITY.md and the wiki's Design page, section 10. Otherwise write "No change". -->
