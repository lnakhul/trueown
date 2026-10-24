"use client";

import { useState } from "react";
import CorrectionPanel, { type ReportedListing } from "@/components/CorrectionPanel";

/** "Report an error" for a listing, opening the existing report form. */
export default function ReportErrorButton({ listing, className }: { listing: ReportedListing; className: string }) {
  const [open_listing, set_open_listing] = useState<ReportedListing | null>(null);
  return (
    <>
      <button type="button" onClick={() => set_open_listing(listing)} className={className}>
        Report an error
      </button>
      <CorrectionPanel listing={open_listing} on_close={() => set_open_listing(null)} />
    </>
  );
}
