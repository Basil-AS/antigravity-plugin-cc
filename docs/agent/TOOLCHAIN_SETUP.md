# Toolchain setup policy

The kit does not silently install third-party executables, plugins, hooks or
MCP servers.

## Detection

```text
python scripts/agent_doctor.py --write-local
```

## Default profile

- RTK: prefer when already installed.
- Superpowers: selected process skills only.
- Gortex: trigger-based, CLI-first.
- Ponytail: built-in lite policy, plugin optional.
- Caveman: off unless terse prose is useful.

## Adoption workflow

1. Verify the current official repository and release.
2. Download installer/release through `scripts/cache_fetch.py`.
3. Review manifest, hooks, scripts, permissions, telemetry and uninstall path.
4. Verify checksum/signature.
5. Install to the smallest useful scope.
6. Record exact version/ref/checksum in `.agents/tooling/LOCK.json`.
7. Run doctor and project verification.
8. Commit only project-owned configuration; never local secrets or caches.

Do not treat a marketing benchmark as proof for this project. Measure actual
tokens, time, defects and review effort before and after.
