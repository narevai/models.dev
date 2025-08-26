# Agent Guidelines for models.dev

## Commands
- **Validate**: `bun validate` - Validates all provider/model configurations
- **Build web**: `cd packages/web && bun run build` - Builds the web interface
- **Dev server**: `cd packages/web && bun run dev` - Runs development server
- **No test framework** - No dedicated test commands found

## Code Style
- **Runtime**: Bun with TypeScript ESM modules
- **Imports**: Use `.js` extensions for local imports (e.g., `./schema.js`)
- **Types**: Strict Zod schemas for validation, inferred types with `z.infer<typeof Schema>`
- **Naming**: camelCase for variables/functions, PascalCase for types/schemas
- **Error handling**: Use Zod's `safeParse()` with structured error objects including `cause`
- **Async**: Use `async/await`, `for await` loops for file operations
- **File operations**: Use Bun's native APIs (`Bun.Glob`, `Bun.file`, `Bun.write`)

## Architecture
- **Monorepo**: Workspace packages in `packages/` (core, web, function)
- **Config**: TOML files for providers/models in `providers/` directory
- **Validation**: Core package validates all configurations via `generate()` function
- **Web**: Static site generation with Hono server and vanilla TypeScript
- **Deploy**: Cloudflare Workers for function, static assets for web

## Conventions
- Use `export interface` for API types, `export const Schema = z.object()` for validation
- Prefix unused variables with underscore or use `_` for ignored parameters
- Handle undefined values explicitly in comparisons and sorting
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safe property access