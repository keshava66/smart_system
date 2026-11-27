# Design: RIMDocs Ingestion tab

Scope: `frontend/src/pages/components/RimIngestionExplorer.jsx` (Unstructured Explorer). The chrome follows the Fuzzy Match welcome screen (`frontend/src/pages/FuzzyMatch.css`) so the two read as one product.

## Palette (J&J brand, binding; no blue, violet or purple)

| Role | Value |
|---|---|
| Canvas | `#f7f6f5` with a 1px dot grid (22px) and a soft J&J red wash top-right |
| Surfaces | `#fff`, hairline `rgba(49,44,42,.10)`, lift shadow `0 1px 2px rgba(49,44,42,.06), 0 10px 28px -14px rgba(49,44,42,.22)` |
| Ink / muted | `#312c2a`, `#1d1a19` (headline) / `#6e6259` |
| Insets, inputs | `#f1efed`, hover `#e8e6e3` |
| Primary action, focus, progress | J&J red `#eb1700`, hover `#c41300` |
| Ingested | fill gradient `#7fd493 → #3f9a26`, text `#3b5a0d`, wash `#eaf5e6` / `#f3f9f0` |
| Not ingested | fill `#fbd8d2` + J&J red stripe (always), text `#9e0000`, wash `#fdeeec` / `#fdf5f3` |
| Toggle on, selected filters | charcoal `#312c2a` |

Status never rides on colour alone: not ingested always carries the stripe. Light gradient ends sit on the `#f1efed` track.

## Type

Johnson Display for counts and headings (semibold, tracking -0.03em); Johnson Text for everything else, tabular numerals throughout. Small uppercase caps (10.5px, 0.14em) only as row labels beside controls (SOURCE, FILTER), never above headings. Minimum text 11px.

## Components

- Command surface: one white floating card (radius 20px, 1.5px ring that turns red-to-peach on focus-within) holding the source row and the filter row.
- Live pill: white, uppercase, green dot that pings while Live is on.
- Refresh: J&J red, 12px radius, red glow shadow, periodic sheen.
- Cards: radius 18px, hairline border, lift shadow.
- Segmented control: `#e8e6e3` track, white selected pill with shadow.
- Signature: CONSORT ingestion flow. Source rows → Documents → In view across the top, dashed 1px links (they animate while matching or Live), a drop into the split bar, 1px ticks into Ingested / Not ingested boxes sized by their share. Clicking a box filters the charts and table; the split always counts both sides.

## Motion

Entrance rise once (0.7s, `cubic-bezier(.16,1,.3,1)`), count-ups ~260ms, bar growth 0.55s. All of it stops under the portal's `html.reduce-motion`; never the OS media query. No blur or backdrop filters (CPU-only Cloud PCs).

## Responsive

Below 1024px the flow becomes one scrollable steps row, then headline, bar and stacked boxes; documents become cards below 768px; filter menus open as bottom sheets below 640px.
