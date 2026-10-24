import type { MetadataRoute } from "next";
import { absolute_url } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api/", "/auth/"] }],
    sitemap: absolute_url("/sitemap.xml"),
  };
}
