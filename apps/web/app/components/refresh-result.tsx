"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function RefreshResult({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [active, router]);
  return active ? <p className="live-note" role="status">This page updates automatically while validation or the AI explanation is in progress.</p> : null;
}
