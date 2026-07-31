# Frontend

## Directory Structure

- `./src/` - Frontend code
  - `./src/app/` - Legacy Angular modules/components
  - `./src/common/` - Framework-agnostic modules (the `core-common` alias), importable from both Angular and Stimulus. Code belongs here when it depends on neither framework and both sides need it; a helper only Stimulus controllers use belongs in `./src/stimulus/helpers/` instead.
  - `./src/stimulus/` - Stimulus controllers
  - `./src/turbo/` - Turbo integration
- `sortable-lists` batch selection is opt-in: a root enables it with a `selectionEnabled` value, and no other consumer's behavior changes. A root also sets `announcementScope`, so the shared controller's announcements speak the consumer's vocabulary instead of "item", and `selectionDescriptionId`, pointing at one shared element every selected card references via `aria-describedby`. Items declare `movable`, which gates dragging, selection eligibility, and positional moves alike. The pure selection model lives in `./src/common/batch-selection.ts` (framework-agnostic, so Angular consumers can adopt it); the DOM-facing adapter is `sortable-lists/selection.ts`. Batch movement is not implemented: a drag still moves one card and collapses any wider selection onto it — that's a later work package.
- `data-batch-selected` is written on the sortable item element — the row, in Backlogs — while `aria-current` is written on the card inside it. A stylesheet assuming both live on the same element will silently paint nothing while attribute assertions stay green.

## Configuration Files

- `eslint.config.mjs` - JavaScript/TypeScript linting
- `../package.json` / `./frontend/package.json` - Node.js dependencies

## Version Requirements

- Node: `^24.15.0` (see `package.json` engines)

## Setup

```bash
npm ci && cd ..   # Install Node packages
```

## Code Style

### JavaScript/TypeScript
- **New development**: Use Hotwire (Turbo + Stimulus) with server-rendered HTML
- **Legacy code**: Follow ESLint rules
- Prefer TypeScript over JavaScript
- Use [Primer Design System](https://primer.style/product/) via ViewComponent

## Linting

```bash
# JavaScript/TypeScript
npx eslint src/ && cd ..
```

## Testing

```bash
# Frontend (Jasmine/Karma)
npm test && cd ..
```
