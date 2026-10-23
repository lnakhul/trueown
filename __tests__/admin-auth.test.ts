import { validate_approval_input, validate_review_note } from "@/lib/approval";
import { check_basic_credentials } from "@/lib/auth/basic";
import {
  LOCAL_DEV_ADMIN_ID,
  authorize_admin,
  type AdminAuthContext,
  type VerifiedUser,
} from "@/lib/auth/admin-session";

const ADMIN_ID = "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1a90";
const basic_header = (password: string) => `Basic ${btoa(`anyone:${password}`)}`;

function supabase_context(get_verified_user: () => Promise<VerifiedUser | null>): AdminAuthContext {
  return {
    supabase_configured: true,
    node_env: "production",
    get_verified_user,
    authorization_header: basic_header("correct"),
    admin_password: "correct",
  };
}

function basic_context(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    supabase_configured: false,
    node_env: "development",
    get_verified_user: async () => null,
    authorization_header: basic_header("correct"),
    admin_password: "correct",
    ...overrides,
  };
}

describe("authorize_admin with Supabase Auth", () => {
  test("a verified user whose app_metadata.role is admin gets claims the database can check", async () => {
    const result = await authorize_admin(
      supabase_context(async () => ({ id: ADMIN_ID, email: "admin@example.com", app_metadata: { role: "admin" } })),
    );
    expect(result).toEqual({
      ok: true,
      identity: {
        actor_id: ADMIN_ID,
        email: "admin@example.com",
        mode: "supabase",
        claims: { role: "authenticated", sub: ADMIN_ID, email: "admin@example.com", app_metadata: { role: "admin" } },
      },
    });
  });

  test("a verified non-admin is forbidden", async () => {
    const result = await authorize_admin(supabase_context(async () => ({ id: ADMIN_ID, app_metadata: {} })));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  test("an admin claim in user-editable user_metadata is ignored", async () => {
    const forged = { id: ADMIN_ID, app_metadata: {}, user_metadata: { role: "admin" } } as VerifiedUser;
    expect(await authorize_admin(supabase_context(async () => forged))).toMatchObject({ ok: false, status: 403 });
  });

  test("no session, an auth error, or a malformed user id is unauthenticated", async () => {
    for (const get_user of [
      async () => null,
      async () => {
        throw new Error("network down");
      },
      async () => ({ id: "not-a-uuid", app_metadata: { role: "admin" } }),
    ]) {
      expect(await authorize_admin(supabase_context(get_user))).toMatchObject({ ok: false, status: 401 });
    }
  });

  test("Basic credentials never stand in for a Supabase session", async () => {
    const result = await authorize_admin(supabase_context(async () => null));
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});

describe("authorize_admin with the local Basic fallback", () => {
  test("the right password outside production maps to the fixed local identity", async () => {
    const result = await authorize_admin(basic_context());
    expect(result.ok && result.identity).toMatchObject({ actor_id: LOCAL_DEV_ADMIN_ID, mode: "local_basic" });
  });

  test("production without Supabase is closed even with the right password", async () => {
    expect(await authorize_admin(basic_context({ node_env: "production" }))).toMatchObject({ ok: false, status: 503 });
  });

  test("no configured password, a missing header, or a wrong password is refused", async () => {
    expect(await authorize_admin(basic_context({ admin_password: undefined }))).toMatchObject({ ok: false, status: 503 });
    expect(await authorize_admin(basic_context({ authorization_header: null }))).toMatchObject({ ok: false, status: 401 });
    expect(await authorize_admin(basic_context({ authorization_header: basic_header("wrong") }))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  test("credential parsing distinguishes missing, malformed and invalid headers", () => {
    expect(check_basic_credentials(null, "pw")).toBe("missing");
    expect(check_basic_credentials("Bearer token", "pw")).toBe("missing");
    expect(check_basic_credentials("Basic %%%", "pw")).toBe("malformed");
    expect(check_basic_credentials(basic_header("nope"), "pw")).toBe("invalid");
    expect(check_basic_credentials(basic_header("pw"), "pw")).toBe("valid");
    expect(check_basic_credentials(`Basic ${btoa("no-colon")}`, "pw")).toBe("invalid");
  });
});

describe("approval payload validation", () => {
  const base = { corporate_tier: 2, parent_entity: "Acme Capital", industry_vertical: "coffee_bakery", latitude: 40.73, longitude: -74 };

  test("requires a source type that fits the tier", () => {
    expect(validate_approval_input({ ...base, ownership_source_type: "crunchbase" })).toMatchObject({ valid: true });
    expect(validate_approval_input(base)).toMatchObject({ valid: false });
    expect(validate_approval_input({ ...base, ownership_source_type: "community_consensus" })).toMatchObject({ valid: false });
    expect(
      validate_approval_input({ ...base, corporate_tier: 3, parent_entity: null, ownership_source_type: "state_business_registry" }),
    ).toMatchObject({ valid: true });
    expect(
      validate_approval_input({ ...base, corporate_tier: 3, parent_entity: null, ownership_source_type: "sec_edgar" }),
    ).toMatchObject({ valid: false });
  });

  test("review notes are optional, trimmed and bounded", () => {
    expect(validate_review_note(null)).toEqual({ valid: true, review_note: null });
    expect(validate_review_note({ review_note: "  " })).toEqual({ valid: true, review_note: null });
    expect(validate_review_note({ review_note: " Wrong location " })).toEqual({ valid: true, review_note: "Wrong location" });
    expect(validate_review_note({ review_note: "x".repeat(501) })).toMatchObject({ valid: false });
    expect(validate_review_note({ review_note: 5 })).toMatchObject({ valid: false });
  });
});
