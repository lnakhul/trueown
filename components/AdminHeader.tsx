import Link from "next/link";
import type { AdminIdentity } from "@/lib/auth/admin-session";

const ADMIN_SECTIONS = [
  { id: "queue", href: "/admin", label: "Vetting queue" },
  { id: "brands", href: "/admin/brands", label: "Brands" },
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number]["id"];

/** Signed-in identity, sign-out and section navigation shared by the admin pages. */
export default function AdminHeader({ admin, current }: { admin: AdminIdentity; current: AdminSection }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-400">
        <span>
          Signed in as <span className="font-medium text-zinc-50">{admin.email ?? admin.actor_id}</span>
          {admin.mode === "local_basic" && " (local development)"}
        </span>
        {admin.mode === "supabase" && (
          <form action="/auth/signout" method="post">
            <button type="submit" className="min-h-11 font-medium text-zinc-400 underline hover:text-zinc-50">
              Sign out
            </button>
          </form>
        )}
      </div>
      <nav aria-label="Admin sections" className="flex gap-1 border-b border-hairline">
        {ADMIN_SECTIONS.map((section) => (
          <Link
            key={section.id}
            href={section.href}
            aria-current={section.id === current ? "page" : undefined}
            className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium transition-colors ${
              section.id === current
                ? "border-zinc-100 text-zinc-50"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {section.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
