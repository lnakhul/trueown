import { validate_correction_input, validate_reverify_input } from "@/lib/brand-review";
import { format_verified_month, provenance_status, source_type_label } from "@/lib/provenance";

const TODAY = new Date("2026-10-23T12:00:00Z");

describe("provenance status", () => {
  test("missing, current and stale claims", () => {
    expect(provenance_status(null, TODAY)).toBe("missing");
    expect(provenance_status({ source_type: "crunchbase", source_url: "https://x.io", verified_on: "bad" }, TODAY)).toBe("missing");
    expect(provenance_status({ source_type: "crunchbase", source_url: "https://x.io", verified_on: "2026-01-15" }, TODAY)).toBe("current");
    expect(provenance_status({ source_type: "crunchbase", source_url: "https://x.io", verified_on: "2025-10-01" }, TODAY)).toBe("stale");
  });

  test("calendar dates format the same in every timezone", () => {
    expect(format_verified_month("2026-10-01")).toBe("Oct 2026");
    expect(format_verified_month("2026-01-31")).toBe("Jan 2026");
    expect(source_type_label("reputable_news")).toBe("Major news outlet");
    expect(source_type_label("some_new_type")).toBe("some new type");
  });
});

describe("re-verification payload", () => {
  test("needs a known source type and a valid link", () => {
    expect(validate_reverify_input({ ownership_source_type: "crunchbase", ownership_source_url: "https://crunchbase.com/x" })).toMatchObject({
      valid: true,
    });
    expect(validate_reverify_input({ ownership_source_type: "blog", ownership_source_url: "https://x.io" })).toMatchObject({ valid: false });
    expect(validate_reverify_input({ ownership_source_type: "crunchbase", ownership_source_url: "javascript:alert(1)" })).toMatchObject({
      valid: false,
    });
    expect(validate_reverify_input("nope")).toMatchObject({ valid: false });
  });
});

describe("correction payload", () => {
  const base = {
    corporate_tier: 1,
    parent_entity: "New Capital",
    financial_backers: "Fund A; Fund B, Fund A",
    ownership_source_type: "sec_edgar",
    ownership_source_url: "https://www.sec.gov/x",
    review_note: "Acquired",
  };

  test("accepts a valid correction and dedupes backers", () => {
    const result = validate_correction_input(base);
    expect(result).toMatchObject({ valid: true, input: { financial_backers: ["Fund A", "Fund B"], parent_entity: "New Capital" } });
  });

  test("independents drop parent and backers", () => {
    const result = validate_correction_input({ ...base, corporate_tier: 3, ownership_source_type: "local_press" });
    expect(result).toMatchObject({ valid: true, input: { parent_entity: null, financial_backers: [] } });
  });

  test("rejects a missing reason, missing parent, a source that does not fit, and oversized backers", () => {
    expect(validate_correction_input({ ...base, review_note: " " })).toMatchObject({ valid: false });
    expect(validate_correction_input({ ...base, parent_entity: "" })).toMatchObject({ valid: false });
    expect(validate_correction_input({ ...base, ownership_source_type: "local_press" })).toMatchObject({ valid: false });
    expect(validate_correction_input({ ...base, financial_backers: Array.from({ length: 21 }, (_, i) => `F${i}`) })).toMatchObject({
      valid: false,
    });
    expect(validate_correction_input({ ...base, corporate_tier: 4 })).toMatchObject({ valid: false });
  });
});
