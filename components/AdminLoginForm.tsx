"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { create_browser_client } from "@/lib/supabase/browser";

/** Email + password sign-in. Admin authorization is enforced server-side, not here. */
export default function AdminLoginForm({ notice }: { notice: string | null }) {
  const router = useRouter();
  const [email, set_email] = useState("");
  const [password, set_password] = useState("");
  const [error_message, set_error_message] = useState<string | null>(notice);
  const [is_loading, set_is_loading] = useState(false);

  async function handle_submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    set_error_message(null);

    const supabase = create_browser_client();
    if (!supabase) {
      set_error_message("Supabase is not configured for this environment.");
      return;
    }

    set_is_loading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        set_error_message("Invalid email or password.");
        return;
      }
      // Middleware re-checks the admin role and bounces non-admins back here.
      router.replace("/admin");
      router.refresh();
    } catch {
      set_error_message("Sign-in failed. Please try again.");
    } finally {
      set_is_loading(false);
    }
  }

  return (
    <form onSubmit={handle_submit} className="w-full max-w-sm space-y-4 rounded-xl border border-hairline bg-surface-card p-6 shadow-hairline">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Admin sign in</h1>
      {error_message && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error_message}
        </p>
      )}
      <label className="block text-sm font-medium text-zinc-300">
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => set_email(event.target.value)}
          className="mt-1 w-full rounded-lg border border-hairline bg-surface-page px-3 py-2.5 text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />
      </label>
      <label className="block text-sm font-medium text-zinc-300">
        Password
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => set_password(event.target.value)}
          className="mt-1 w-full rounded-lg border border-hairline bg-surface-page px-3 py-2.5 text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={is_loading}
        className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 font-semibold text-zinc-950 transition hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
      >
        {is_loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
