"use client";

import { useEffect, useRef } from "react";

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  reset: (widget_id: string) => void;
  remove: (widget_id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileWidgetProps {
  site_key: string;
  /** Increment to discard the current token and request a new challenge. */
  reset_signal: number;
  on_token: (token: string | null) => void;
}

/** Loads Cloudflare Turnstile once and reports the current token (null when expired/errored). */
export default function TurnstileWidget({ site_key, reset_signal, on_token }: TurnstileWidgetProps) {
  const container_ref = useRef<HTMLDivElement>(null);
  const widget_id_ref = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    function render_widget(): void {
      if (cancelled || !container_ref.current || !window.turnstile || widget_id_ref.current) return;
      widget_id_ref.current = window.turnstile.render(container_ref.current, {
        sitekey: site_key,
        callback: (token) => on_token(token),
        "expired-callback": () => on_token(null),
        "error-callback": () => on_token(null),
      });
    }

    if (window.turnstile) {
      render_widget();
    } else {
      let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement("script");
        script.id = SCRIPT_ID;
        script.src = SCRIPT_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render_widget);
    }

    return () => {
      cancelled = true;
      if (widget_id_ref.current && window.turnstile) {
        window.turnstile.remove(widget_id_ref.current);
      }
      widget_id_ref.current = null;
      on_token(null);
    };
  }, [site_key, on_token]);

  useEffect(() => {
    if (reset_signal > 0 && widget_id_ref.current && window.turnstile) {
      window.turnstile.reset(widget_id_ref.current);
    }
  }, [reset_signal]);

  return <div ref={container_ref} className="min-h-[65px]" />;
}
