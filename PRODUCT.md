# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

GRA SmartHub is J&J Global Regulatory Affairs' internal data portal. The RIMDocs Ingestion tab of its Unstructured Explorer serves two groups equally:

- Data engineers who find documents missing from the doc_chunks tables and fix the ingestion pipeline.
- Regulatory leads who track ingestion coverage per product and report it.

## Product Purpose

Show which RIMDocs PALM/PAH documents (prd_raw_rimdocs_core.rimdocs_palm_pah_dt) made it into a chosen rimdocs_extracts_core.doc_chunks* table. A document counts as ingested when `<r_object_id>.pdf` is a file_name in that table. Success: within seconds, the visitor knows the overall coverage percentage for the source they picked, then can drill into lagging products and the exact missing documents.

## Operating Context

Used on Windows Cloud PCs with no GPU (every frame rendered on the CPU), in desktop browsers at work, and occasionally on phones. Visitors pick a chunks table, optional product codes, combined-code matching and latest-versions-only, then filter by ingestion status, approval status, object type and domain. Data is matched once per source and cached ten minutes; Refresh and a five-minute Live mode re-match.

## Capabilities and Constraints

- Views: Overview (coverage, by product, by approval year), Breakdown (8 dimensions), Documents (search, sort, page, detail, CSV).
- Access is per-permission (viewUnstructuredRimIngestion and its three sub-tabs; CSV needs downloadUnstructuredData). Every interaction is audit-logged.
- Motion follows the portal's own setting (`html.reduce-motion`), never the OS media query.
- Stack: React 19, Vite, Tailwind 3, lucide-react icons; no chart library.

## Brand Commitments

- Johnson Display / Johnson Text fonts are binding.
- The J&J brand palette is binding: charcoal, J&J red, the J&J warm grays, J&J green. No blue, violet or purple, and no generic AI palettes (user, 2026-11-27).
- The user asked for a polished, premium look whose flow reflects the real matching pipeline.

## Evidence on Hand

No real ingestion data in the development session; screens are verified against synthetic data only. Never present synthetic figures as real.

## Product Principles

1. Coverage first: the overall percentage leads, everything else drills from it.
2. Every number is traceable to the source table and match rule.
3. Status never rides on color alone.
4. Fast on CPU-only machines: no blur, no heavy compositing.
