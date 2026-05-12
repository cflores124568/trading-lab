# Frontend Claude Notes

This is the SolidJS UI for Trading Lab. Keep routing in `src/routes/`, shared
UI in `src/components/`, and API calls in `src/services/` so the app stays easy
to follow.

The charts and replay flows are the sensitive parts. Try not to make the UI
state harder to reason about just to shave a few lines off the code.

UI/UX bias:
- preserve the current visual language unless the task is clearly a redesign
- favor clear, intentional layouts over generic dashboard blocks
- make chart and replay screens feel fast, readable, and a little premium
- keep important actions obvious and avoid hiding controls behind extra clicks
- if a screen feels crowded, simplify the hierarchy before adding more chrome
- small polish passes are good, but don't trade away usability for visual flair

Font gotcha:
The default sans font (`--font-sans` in `src/index.css`) is **Major Mono
Display**. It renders text in wide display-caps, so headings, kickers, and
uppercase labels eat ~40% more horizontal space than a normal sans would.
When something feels cramped or wraps weirdly, the cause is usually copy
length or a missing `whitespace-nowrap` / `shrink-0`, not the grid math.
Prefer shortening the copy over restructuring the layout.

Important conventions:
- use the existing SolidJS patterns, not React-style patterns
- keep chart code lean, because these views update a lot
- update `src/services/api.ts` and any callers together when API shapes change
- keep replay/backtest state persistence aligned with the backend contracts
- use the current Tailwind v4 setup instead of adding a new styling system

If you change chart behavior, replay session behavior, or the compare views,
run the relevant frontend checks and verify the UI still feels snappy.

Good checks:
- `npm run build`
- `npm run test:replay` for replay simulator/state changes

The `frontend/dist/` and `frontend/node_modules/` directories are generated.
Leave them alone unless you are specifically debugging build output.
