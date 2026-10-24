"use client";

import { useState } from "react";
import SubmissionPanel from "@/components/SubmissionPanel";

/** "Submit a tip" that opens the tip form in place. */
export default function TipButton({ className, children }: { className: string; children: React.ReactNode }) {
  const [is_open, set_is_open] = useState(false);
  return (
    <>
      <button type="button" onClick={() => set_is_open(true)} className={className}>
        {children}
      </button>
      <SubmissionPanel is_open={is_open} on_close={() => set_is_open(false)} />
    </>
  );
}
