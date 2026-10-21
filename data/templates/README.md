# Venue CSV template

`venues_template.csv` is the exact header the importer accepts. Fill in one row per **storefront**; a brand with several locations repeats its brand columns on every row (all rows of a brand must agree).

```bash
# 1. Validate everything without saving (also checks coordinates against the NYC boundaries)
npm run db:import:venues -- path/to/your_file.csv --dry-run

# 2. Import into the local Docker database
npm run db:import:venues -- path/to/your_file.csv

# Hosted Supabase: DATABASE_URL points at a non-local host, so confirm explicitly
npm run db:import:venues -- path/to/your_file.csv --yes
```

The import is **all-or-nothing**: any invalid row, tier conflict or database error rolls the whole file back, and every problem is listed with its line number.

## Columns

| Column | Required | Rules |
|---|---|---|
| `brand_name` | yes | Max 200 chars. Brands match case-insensitively on name + vertical. |
| `industry_vertical` | yes | `coffee_bakery`, `restaurant`, `bar_nightlife`, `retail_boutique` or `fitness_wellness`. |
| `corporate_tier` | yes | `1` PE / institutional, `2` VC / growth equity, `3` independent. |
| `parent_entity` | Tier 1-2 only | The owner or investor. **Must be blank for Tier 3.** |
| `unique_selling_proposition` | no | Max 300 chars. Shown on the recommendation cards. |
| `ownership_source_type` | yes | Tier 1-2: `sec_edgar`, `investor_press_release`, `pitchbook`, `crunchbase`, `mergr`, `reputable_news` (a major outlet reporting the deal). Tier 3: `nys_dos_corporations`, `eater_ny`, `community_consensus`. |
| `ownership_source_url` | yes | Public `http(s)` link to the evidence. |
| `ownership_verified_on` | yes | Date you checked the source, `YYYY-MM-DD`, not in the future. |
| `address` | yes | Full street address. A brand cannot have the same address twice. |
| `neighborhood` | no | Blank = derived from the NYC neighborhood polygon containing the point (recommended). |
| `city` | no | Defaults to `New York`. |
| `latitude` / `longitude` | yes | Decimal degrees (e.g. `40.7324`, `-74.0021`). Must fall inside a New York neighborhood boundary (100 m shoreline tolerance), which catches swapped values. |

## Notes

- Existing brands are updated (parent, source, verification date), but a **tier change is never applied silently**: the import stops so it can be resolved by hand.
- Re-running the same file is safe: storefronts that already exist are skipped.
- Quote any cell containing a comma, e.g. `"186 W 4th St, New York, NY 10014"`.
- Example row (fictional):

```csv
Example Roasters,coffee_bakery,3,,Family-run roaster since 1987,nys_dos_corporations,https://apps.dos.ny.gov/publicInquiry/,2026-10-01,"1 Example St, New York, NY 10001",,New York,40.7506,-73.9972
```
