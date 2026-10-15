# Changelog

## 0.1.15 — 2026-10-14

The server now uses the Platform OpenAPI spec, `spec/Platform-vsp360-openapi.yaml`, which replaces `spec/vsp360-openapi.yaml`. It still covers 264 operations.

### Changed

- **Data Protection paths.** The 25 Data Protection operations now use `/dataprotection/api/v1/protection` in the spec itself. The default `VSP360_PATH_REWRITES` rule stays, because the service's pagination (`next`) links still leave out the `/dataprotection` prefix.
- **Orchestration paths.** The 11 Orchestration operations moved to `/orchestration/api/v1/execute`. On the lab, the old paths returned the web UI instead of the API, so these workflow calls now work.
- **Search ranking.** The decision model was retrained on the new spec. On the user test set, 30 of 77 questions now meet the confidence thresholds (up from 23). On the held-out batch, 25 of 45 do (up from 17).

### Added

- `vsp360GetAuthenticationSettingsPasswordPolicy` reads the password policy, with example questions for search. On the lab's current build it returns 404.

### Removed

- `orchestrationExecuteNdm` (nondisruptive migration) is no longer in the API, so the server no longer offers it. As a result, the number of write operations drops from 125 to 124.
- The old `spec/vsp360-openapi.yaml` file.

### Upgrading

- If `VSP360_SPEC` points at the old bundled `spec/vsp360-openapi.yaml`, remove the setting or point it at `spec/Platform-vsp360-openapi.yaml`.
- Any prompts or automation that call `orchestrationExecuteNdm` need to change, because that operation no longer exists.
