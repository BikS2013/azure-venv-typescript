# Suggested Commands

## Development
- `npm run build` - Compile TypeScript to dist/
- `npx tsc --noEmit` - Type-check without emitting
- `npm run lint` - Run ESLint on src/

## Testing
- `npx vitest run` - Run all tests
- `npx vitest` - Run tests in watch mode
- `npx vitest run --coverage` - Run with coverage

## CLI
- `npx azure-venv sync` - One-time blob sync
- `npx azure-venv watch` - Continuous watch mode

## Task Completion Checklist
1. Run `npx tsc --noEmit` to verify types
2. Run `npx vitest run` to verify tests pass
3. Run `npm run build` to verify build succeeds
