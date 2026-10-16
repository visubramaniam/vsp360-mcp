# Contributing to vsp360-mcp

Thanks for helping. vsp360-mcp is a community project, not a Hitachi Vantara product, and contributions of every size are welcome: a better example question, a clearer error message, a bug report from a real VSP 360, or a new feature.

By taking part, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug.** Use the [bug report form](https://github.com/visubramaniam/vsp360-mcp/issues/new?template=bug_report.yml). It asks for the version, how you installed it, your MCP client and operating system, and the server's messages. **Remove secrets and anything that identifies your environment first** (see [No live data](#no-live-data)).
- **Report a security problem privately.** Don't open a public issue. Use the repository's **Security** tab → **Report a vulnerability**, as [SECURITY.md](SECURITY.md) describes.
- **Tell us where search goes wrong.** If Claude picked the wrong operation for a question, the [search problem form](https://github.com/visubramaniam/vsp360-mcp/issues/new?template=search_problem.yml) asks for the question and the operation that should have answered it. Search quality is measured, so each such case can become a test.
- **Improve the docs.** The README, INSTALL.md and the other files in the repository are the reference; the [wiki](https://github.com/visubramaniam/vsp360-mcp/wiki) is a guided tour of them.
- **Suggest a feature** with the [feature request form](https://github.com/visubramaniam/vsp360-mcp/issues/new?template=feature_request.yml).
- **Write code.** Start with an issue for anything bigger than a small fix, so we can agree on the approach before you spend time on it.

## Before you start

The [Design](https://github.com/visubramaniam/vsp360-mcp/wiki/Design) page on the wiki explains the architecture and why it's built the way it is. [SECURITY.md](SECURITY.md) explains the security model. The short version of the model: the person who configures the server is trusted, the model calling the tools is not fully trusted (text it reads from VSP 360 can steer it), and VSP 360's responses are untrusted input. Changes that weaken a safety control need a strong reason and a test.

## Setting up

You need Node.js 22 or later and git.

```bash
git clone https://github.com/visubramaniam/vsp360-mcp.git
```

```bash
cd vsp360-mcp && npm ci && npm test
```

`npm test` compiles `src/` to `dist/`, runs the unit tests in `tests/unit/`, then runs the search evaluation. None of it needs a VSP 360: the HTTP client is tested against a mock, and the end-to-end server tests point at an address that doesn't exist.

To try the server against a real VSP 360, set `VSP360_URL`, `VSP360_CLIENT_ID` and `VSP360_CLIENT_SECRET` in your shell and run `npm run inspect`, which opens the MCP Inspector. Leave `VSP360_ALLOW_WRITES` off unless you mean to change the system.

| Command | What it does |
|---|---|
| `npm run build` | Compile `src/` to `dist/` and write the pre-parsed spec |
| `npm test` | Build, unit tests, search evaluation |
| `npm run eval` | Search evaluation only, with detailed scores |
| `npm run inspect` | Open the MCP Inspector against the built server |
| `npm run package` | Build the release packages into `release/` |

## Making a change

1. **Branch from `main`.** `main` is protected, so every change goes through a pull request.
2. **Keep the change focused.** One pull request per fix or feature makes review and release notes easier.
3. **Add or update tests.** Bug fixes should come with a test that fails without the fix. Safety controls must each have a test; [Design § 10](https://github.com/visubramaniam/vsp360-mcp/wiki/Design#10-safety-controls-and-where-they-live) lists them.
4. **Run `npm test`** and make sure it passes.
5. **Update the docs** that describe what you changed: the README, INSTALL.md, README.docker.md, README.plugin.md or SECURITY.md as relevant.
6. **Add a line to `CHANGELOG.md`** under `## Unreleased` for anything a user would notice, in the existing style: a bold one-line summary, then what changed and why.
7. **Open a pull request.** Its template asks what changed and why, how you tested it, and whether it changes what Claude can do on its own.

CI runs the tests on Node.js 22 and 24, builds the npm package, the Claude Desktop extension and a Linux standalone package, smoke-tests that package, and runs CodeQL. A maintainer merges with **Rebase and merge** or **Squash and merge** to keep the history linear.

## No live data

This repository is public. **Never commit data from a real VSP 360**: system or array names, serial numbers, WWNs, host names, IP addresses, user names, or output copied from a live system. Use placeholders such as `ARRAY-A`, `410001` or `pool-01` in examples and tests.

Stage files by name rather than with `git add -A` or `git add .`. In particular, `reports/` holds local decision logs and batch answers that can contain live data; only `reports/decisions.jsonl` is tracked, and it holds no environment data.

If you're unsure whether something is safe to share, ask in the pull request before pushing it, or leave it out.

## Code style

- **TypeScript, strict mode,** ES modules. Match the surrounding code: its naming, its comment density, and its habit of explaining *why* in comments rather than *what*.
- **No new runtime dependencies** without discussion. The server has three, and every one is shipped to every user.
- **Errors are results, not crashes.** A bad call returns an error result with a message that says what to change; the server keeps running.
- **Gates run before requests.** Anything that refuses a call does so before a network request is made, and blocked operations get no direct tool.
- **Never log credentials,** argument values, or request and response bodies.

## Common changes

### Improving search

Search ranks operations with BM25 over their text plus the example questions in `spec/examples.json`.

1. Add example questions to the right operation in `spec/examples.json`, worded the way an operator would ask, not the way the spec describes it.
2. If the gap is vocabulary (users say "volume", the spec says "ldev"), add a synonym in `src/search.ts`.
3. Run `npm run eval`. Every score has a regression threshold in `tests/search-eval.mjs`. If your change improves a score, raise its threshold to the new value in the same pull request. **Never lower a threshold to make a change pass.**
4. Don't use the held-out questions in `tests/user-queries.md` or the held-out sets in `tests/cases.mjs` to guide your change; they exist to check that improvements generalise.

### Adding a read-only POST operation

If a `POST` operation only reads or validates and changes nothing:

1. Add its `operationId` to `READ_ONLY_POSTS` in `src/spec.ts`, with a comment if the reason isn't obvious.
2. Update the read-only list in the README and on the wiki's Safety and Security page.
3. Update the counts in `tests/unit/spec.test.mjs` and `tests/unit/server.test.mjs`.

Think about side effects beyond VSP 360's own state: an operation that makes VSP 360 connect somewhere, as `vsp360VerifyDirectory` does, is treated as a write.

### Marking an operation that returns a secret

Add its `operationId` to `SECRETS` in `src/spec.ts`, update the README's Safety section and SECURITY.md's controls table, and update the counts in the tests.

### Updating the OpenAPI spec

Replace `spec/Platform-vsp360-openapi.yaml`, run `npm run build`, and then:

- classify any new `POST` operations and secret-returning operations as above;
- add example questions for new operations (the evaluation lists operations without any);
- run `npm test` and review any score changes;
- update the operation and area counts in the README, the tests and the wiki.

### Changing the Claude Code plugin

The plugin in `plugin/` installs the server from a lockfile pinned to a version that's already on npm, so it trails the server by one release. Changes to its skills (`plugin/skills/`) are welcome at any time. Version moves happen in a follow-up pull request after each release.

## Releases

Maintainers cut releases; you don't need to bump versions in your pull request. The procedure is on the wiki's [Releasing](https://github.com/visubramaniam/vsp360-mcp/wiki/Releasing) page.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), like the rest of the code. The VSP 360 OpenAPI definition in `spec/` is Hitachi Vantara's and isn't covered by that licence; don't add other third-party material without checking its licence first.
