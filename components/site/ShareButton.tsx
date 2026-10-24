"use client";

import { useState } from "react";

/** The phone's share sheet when there is one; otherwise copies the link. */
export default function ShareButton({ url, title, text }: { url: string; title: string; text: string }) {
  const [copied, set_copied] = useState(false);

  async function share(): Promise<void> {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url, title, text });
        return;
      } catch (caught_error) {
        if (caught_error instanceof DOMException && caught_error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      set_copied(true);
      window.setTimeout(() => set_copied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void share()}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-hairline px-4 text-sm font-semibold text-zinc-100 transition-colors hover:border-zinc-500"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
      </svg>
      <span aria-live="polite">{copied ? "Link copied" : "Share"}</span>
    </button>
  );
}
