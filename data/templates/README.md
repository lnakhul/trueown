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
| `ownership_source_type` | yes | Tier 1-2: `sec_edgar`, `investor_press_release`, `pitchbook`, `crunchbase`, `mergr`, `reputable_news` (a major outlet reporting the deal). Tier 3: `state_business_registry` (e.g. NYS DOS, Texas SOS, Illinois SOS), `local_press` (a local outlet such as Eater), `community_consensus`. The older NYC-only `nys_dos_corporations` and `eater_ny` are still accepted. |
| `ownership_source_url` | yes | Public `http(s)` link to the evidence. |
| `ownership_verified_on` | yes | Date you checked the source, `YYYY-MM-DD`, not in the future. |
| `address` | yes | Full street address. A brand cannot have the same address twice. |
| `neighborhood` | no | Blank = derived from the NYC neighborhood polygon containing the point (recommended). |
| `market` | no | Market slug (`nyc`, `austin`, `chicago`, see `data/markets/`). The market always comes from the coordinates (within 50 miles of a market's center); if you fill this column it must match, which catches rows with the wrong city's coordinates. A `coming_soon` market is stored but not served. |
| `city` | no (legacy) | Older files may keep this column. If filled it must equal the market's city label (`New York`, `Austin`, `Chicago`); the stored city always comes from the market. |
| `latitude` / `longitude` | yes | Decimal degrees (e.g. `40.7324`, `-74.0021`). For cities with loaded neighborhood boundaries (NYC) the point must fall inside one (100 m shoreline tolerance), which catches swapped values. |

## Notes

- Any `industry_vertical` can be loaded (`restaurant`, `bar_nightlife`, `retail_boutique`, `fitness_wellness`, ...). Discovery only pairs a corporate storefront with independents of the **same** vertical.
- **Multi-market files are fine.** Tier 1/2 brands are national: the same name in NYC and Chicago is one brand with storefronts in both. Tier 3 independents are local: two unrelated independents with the same name in different markets stay two separate brands. A Tier 3 name that matches a national Tier 1/2 brand in the same vertical (or in the same market with another tier) stops the import.
- Existing brands are updated (parent, source, verification date), but a **tier change is never applied silently**: the import stops so it can be resolved by hand.
- Re-running the same file is safe: storefronts that already exist are skipped.
- Quote any cell containing a comma, e.g. `"186 W 4th St, New York, NY 10014"`.
- Example row (fictional):

```csv
Example Roasters,coffee_bakery,3,,Family-run roaster since 1987,state_business_registry,https://apps.dos.ny.gov/publicInquiry/,2026-10-01,"1 Example St, New York, NY 10001",,nyc,40.7506,-73.9972
```

## Address-only files (geocoding)

You can leave `latitude` and `longitude` blank and let the geocoder fill them from the street address:

```bash
npm run db:geocode:venues -- data/markets/nyc/venues.csv
# -> data/markets/nyc/venues.geocoded.csv         (the same rows, with coordinates filled where safe)
# -> data/markets/nyc/venues.geocode-report.csv   (one line per row: filled / needs_review / not_found / error)
npm run db:import:venues -- data/markets/nyc/venues.geocoded.csv --dry-run
```

- Only **exact house-number matches** inside the row's market are filled. A street-level guess, a match in another city, or an address without a house number is left blank and listed in the report for you to fix by hand.
- Rows that already have coordinates are never changed.
- It uses OpenStreetMap's Nominatim: about one address per second, cached in `.cache/geocode-venues.json` so re-runs are fast. Set `GEOCODER_USER_AGENT` to include your contact email, as their usage policy asks.
- Check a few filled rows on a map before importing; the import itself still checks every point against the neighborhood boundaries.

## Brand-only file

`brands_template.csv` is the header for `npm run db:import:brands`: one row per brand, no storefronts. `financial_backers` is a comma- or semicolon-separated list of named investors (commas inside parentheses are kept; `none` means empty; Tier 3 rows are stored as none) and is shown on the Tier 1/2 alert banner, so only list investors you can cite. An optional trailing `market` column sets a Tier 3 brand's home market (blank = taken from its first storefront). Keep unsourced working files out of git (`data/**/vetted_*.csv` and `*_draft.csv` are ignored).

## Adding a market

Each market has a folder in `data/markets/<slug>/`:

- `market.json`: name, canonical city label, center, status (`active` or `coming_soon`) and where its official neighborhood polygons come from (dataset URL and which GeoJSON properties hold the code, name and borough).
- `venues.csv`: an empty file with the template header, ready for vetted rows.

```bash
npm run db:import:markets                                   # create/refresh markets (keeps live status)
npm run db:import:boundaries -- --market chicago --download # fetch + save + load polygons
npm run db:import:venues -- data/markets/chicago/venues.csv --dry-run
```

Austin and Chicago ship as `coming_soon` with their boundary sources configured and no brand data. Switch a market on with `"status": "active"` and `npm run db:import:markets -- --apply-status` once it has vetted data.
