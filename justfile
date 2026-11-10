# Ensemble-Workflows task runner.
#
# `just` is the front door — run `just` (or `just --list`) to see every recipe.
# The recipes are thin: npm scripts in package.json do the real work.

# List available recipes.
default:
    @just --list

# CI runs this same recipe, so the local gate and CI cannot drift apart.
# The gate: lint, then the test suite (which builds first), then the
# bundle-freshness check — after the tests deliberately, so a red gate on a
# stale bundle still reports the test results, and the check compares
# against the bundle the test recipe just rebuilt. Version checking also
# checks the lockfile metadata against the package and launcher reports.
verify: lint test bundle-fresh version-check

# Fail when the tracked skill bundle differs from the fresh build `test`
# produced — a stale committed bundle is otherwise invisible unless someone
# notices the diff. Scoped to the bundle path so unrelated working-tree
# changes never fail here.
bundle-fresh:
    git diff --stat --exit-code -- skills/ensemble-workflow/Base/scripts/ensemble.mjs || { echo "Tracked skill bundle is stale: commit the rebuilt skills/ensemble-workflow/Base/scripts/ensemble.mjs with the change that caused it." >&2; exit 1; }

# Alias for `verify`, kept for muscle memory.
ci: verify

# ESLint over the repo's own roots (src, test, scripts, the config itself) —
# enumerated rather than `.`, so a repo-shaped directory at the root (a
# registered comparison worktree, a nested checkout) is never walked and can
# never fail the gate on its own copied files.
lint:
    npm run lint

# Compile, rebuild the skill bundle, then run the built tests.
test:
    npm test

# Install dependencies exactly as the lockfile pins them.
install:
    npm ci

# Rebuild the standalone skill launcher (skills/…/Base/scripts/ensemble.mjs).
build:
    npm run build

# Print the agreed package, lockfile and launcher version without rebuilding.
version-check:
    node scripts/release-version.mjs check

# Write all version surfaces and rebuild the standalone launcher (needs npm ci).
version-bump version:
    node scripts/release-version.mjs bump {{quote(version)}}

# The live tests, which reach real engines. Not part of the gate. Legs that
# must name a model read it from ENSEMBLE_LIVE_CODEX_MODEL or
# ENSEMBLE_LIVE_OPENCODE_MODEL (a key from the machine config's
# opencode_models) and skip while it is unset. Every skip states its reason
# in TAP. Partial-output failure-evidence legs also require
# ENSEMBLE_LIVE_FAILURE_EVIDENCE=1: they terminate their own real workers.
# Run them with: ENSEMBLE_LIVE_FAILURE_EVIDENCE=1 just test-live
test-live:
    npm run test:live
