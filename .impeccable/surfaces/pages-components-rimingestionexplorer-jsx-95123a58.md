---
version: 1
slug: "pages-components-rimingestionexplorer-jsx-95123a58"
primary_target: "frontend/src/pages/components/RimIngestionExplorer.jsx"
related_targets: []
---

# Surface: RIMDocs Ingestion tab (Unstructured Explorer)

Mode: operate. Build path: code-led (operate surface; no image generation in this session).
Audience: data engineers fixing ingestion gaps and regulatory leads reporting coverage, equally.
Task: see overall coverage % for the picked source in seconds, then drill into lagging products and the missing documents.
Constraints: Johnson fonts and the J&J brand palette binding (no blue, violet or purple); CPU-only Cloud PCs (no blur); portal motion setting; standard controls; same data, filters, tabs, permissions.

## Direction contract

THESIS: Coverage is a trial-style flow, not a scoreboard. The page refuses the hero-metric template (big %, ring, four stat tiles) and draws the matching rule itself: source rows narrow to unique documents, filters branch off, documents split into ingested and not ingested, each box carrying its n.

OWN-WORLD: CONSORT diagram discipline in the J&J brand palette. Warm gray ground #f1efed, white work areas, charcoal #312c2a for text, toggle on-states and the flow's spine; a white floating command surface on a #f7f6f5 dot-grid canvas (the Fuzzy Match screen's language). Ingested: soft J&J green gradient #7fd493 to #3f9a26 (text #3b5a0d, wash #eaf5e6); not ingested: soft red tint #fbd8d2 with a J&J red stripe (text #9e0000, wash #fdeeec). J&J red #eb1700 also marks the primary action, focus and progress. Hairline 1px connectors, 10-12px radii, Johnson Text with tabular numerals, Johnson Display for counts.

STORY: The visitor reads the share ingested, sees exactly how many documents fell where and why, clicks Not ingested to land on the missing list, or narrows by product from the bars.

FIRST VIEWPORT: White floating command surface across the top (source table, products, toggles, sync state, Live, Refresh) with page filters below it. Then the flow panel full width: a left spine of three boxes (Source rows, Documents, after filters) feeding a split into a large Ingested box (share in Johnson Display ~48px, n=, chunks) and a Not ingested box with hatch and a "Show these documents" action. Below: By product and By approval year side by side.

FORM: CONSORT ingestion flow, candidate 3 of 7 (CTD dossier, microplate, CONSORT flow, blister pack, Basel pharma design, DataMatrix serialization, approval seal). seed:182c4471b3e564e8. Signature interaction: every flow box is a filter; clicking a split box applies that ingestion status and the flow re-draws with a 200ms count transition.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
