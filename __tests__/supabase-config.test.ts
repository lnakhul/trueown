import { get_supabase_config, is_admin_user } from "@/lib/supabase/config";

describe("supabase admin role check", () => {
  it("accepts only app_metadata.role === 'admin'", () => {
    expect(is_admin_user({ app_metadata: { role: "admin" } })).toBe(true);
    expect(is_admin_user({ app_metadata: { role: "user" } })).toBe(false);
    expect(is_admin_user({ app_metadata: null })).toBe(false);
    expect(is_admin_user(null)).toBe(false);
    expect(is_admin_user(undefined)).toBe(false);
  });

  it("ignores user-editable user_metadata", () => {
    const spoofed = { app_metadata: {}, user_metadata: { role: "admin" } };
    expect(is_admin_user(spoofed)).toBe(false);
  });
});

describe("get_supabase_config", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("is null unless both values are set and non-blank", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(get_supabase_config()).toBeNull();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "  ";
    expect(get_supabase_config()).toBeNull();
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "key";
    expect(get_supabase_config()).toEqual({ url: "https://x.supabase.co", anon_key: "key" });
  });
});
