## retina

- Spec of record: `docs/superpowers/specs/2026-04-21-retina-image-api-design.md` — the authoritative source for API shape, stack, error envelope, testing ladder. Read it before proposing design changes.
- Working charter: `.ralph/constitution.md` — mission, non-goals, 11 architecture invariants, code style, testing ladder, and the ralph-loop definition of done. If a task conflicts with the constitution, amend the constitution first (dedicated commit) — do not drift silently.
- Task backlog: `.ralph/fix_plan.md` — ralph-sized tasks `R01..R28`, each referencing specific files/paths. When executing, pick via `ralph --task Rxx` or follow the `Depends on:` chain.
- Build/test/run commands: `.ralph/AGENT.md` (pnpm scripts, Docker commands).
- Protected paths: `.ralph/` and `.ralphrc` — never modified except through dedicated governance tasks.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
