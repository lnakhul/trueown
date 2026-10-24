import type { ReactNode } from "react";

/** Readable long-form text for About, Privacy and Terms. */
export default function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4 text-[15px] leading-7 text-zinc-300 [&_a]:text-zinc-50 [&_a]:underline [&_a]:decoration-zinc-600 [&_a]:underline-offset-2 hover:[&_a]:decoration-zinc-300 [&_h2]:pt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-zinc-50 [&_h3]:pt-2 [&_h3]:font-semibold [&_h3]:text-zinc-100 [&_li]:pl-1 [&_strong]:text-zinc-100 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
      {children}
    </div>
  );
}
