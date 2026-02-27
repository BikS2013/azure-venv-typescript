# azure-venv Project Overview

## Purpose
TypeScript library that syncs Azure Blob Storage files and environment variables to local filesystem on app startup, with watch mode and CLI.

## Tech Stack
- Language: TypeScript (strict mode, ESM)
- Runtime: Node.js >= 18
- Dependencies: @azure/storage-blob, commander, dotenv, zod
- Testing: vitest
- Linting: eslint
- Build: tsc

## Key Commands
- Build: `npm run build`
- Test: `npx vitest run`
- Type-check: `npx tsc --noEmit`
- Lint: `npm run lint`
- CLI sync: `npx azure-venv sync`
- CLI watch: `npx azure-venv watch`

## Project Structure
- src/ - Source code (config/, azure/, sync/, env/, watch/, cli/, errors/, logging/, types/)
- test_scripts/ - All tests
- docs/design/ - Plans and project design
- docs/reference/ - Research and analysis docs
- dist/ - Build output

## Conventions
- All code in TypeScript
- No fallback values for config (raise exceptions)
- Tests in test_scripts/ directory
- Plans in docs/design/plan-NNN-<desc>.md
- Tools documented in CLAUDE.md with XML format
- Singular table names for databases
