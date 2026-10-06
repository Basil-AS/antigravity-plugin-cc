@/home/basil/System/GLOBAL_AGENT_RULES.md

# BEGIN UNIVERSAL AGENT KIT
## Universal Agent Kit

Before editing, read `.agents/reference/UNIVERSAL_AGENT_BOOTSTRAP.md`,
restore `.agents/state/CURRENT.md`, preserve unknown work, and keep
`TASK.md`, `JOURNAL.md` and `HANDOFF.md` current.
# END UNIVERSAL AGENT KIT

## Releasing this plugin (all agents)

Installed clients (CLI, Claude Desktop) only pick up a release when the
`version` in `plugins/antigravity/.claude-plugin/plugin.json` changes.

1. Any change under `plugins/` must bump the version in the same branch:
   `npm run version:bump -- patch|minor|major` (keeps `plugin.json`,
   `marketplace.json` and `package.json` identical). feat → minor, fix → patch.
2. `npm test` and `npm run release:check -- --base origin/main` must pass
   (CI enforces both).
3. After merge: `gh release create vX.Y.Z --target main --generate-notes`
   (the tag must equal the version; the release workflow checks it).
4. On a machine that installed the plugin: `claude plugin marketplace update
   google-antigravity && claude plugin update agy@google-antigravity`, then
   `/reload-plugins`.

