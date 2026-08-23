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
# against the bundle the test recipe just rebuilt.
verify: lint test bundle-fresh

# Fail when the tracked skill bundle differs from the fresh build `test`
# produced — a stale committed bundle is otherwise invisible unless someone
# notices the diff. Scoped to the bundle path so unrelated working-tree
# changes never fail here.
bundle-fresh:
    git diff --stat --exit-code -- skills/ensemble-workflow/Base/scripts/ensemble.mjs || { echo "Tracked skill bundle is stale: commit the rebuilt skills/ensemble-workflow/Base/scripts/ensemble.mjs with the change that caused it." >&2; exit 1; }

# Alias for `verify`, kept for muscle memory.
ci: verify

# ESLint across the repo.
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

# The live tests, which reach real engines. Not part of the gate.
test-live:
    npm run test:live
