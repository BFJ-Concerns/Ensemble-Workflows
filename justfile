# Ensemble-Workflows task runner.
#
# `just` is the front door — run `just` (or `just --list`) to see every recipe.
# The recipes are thin: npm scripts in package.json do the real work.

# List available recipes.
default:
    @just --list

# CI runs this same recipe, so the local gate and CI cannot drift apart.
# The gate: lint, then the test suite (which builds first).
verify: lint test

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
