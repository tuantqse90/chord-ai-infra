// Shared chats: what a link may carry. Everything comes from the visitor's own browser, so it is cut down to plain data
// before it is stored: strings capped, source links https only, at most 20 turns. The page renders it through the same
// escaping renderer as a live answer.
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const https = (v: unknown) => (typeof v === "string" && /^https:\/\/[^\s"'<>]+$/.test(v) ? v.slice(0, 600) : null);
const arr = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);

export function cleanShare(body: any): { title: string; turns: unknown[] } | null {
  const turns = arr(body?.turns, 20).map((t: any) => {
    const a = t?.a && typeof t.a === "object" ? t.a : null;
    return {
      q: str(t?.q, 2000),
      a: a ? {
        text: str(a.text, 30_000),
        elapsedMs: Number.isFinite(a.elapsedMs) ? a.elapsedMs : 0,
        sources: arr(a.sources, 16).map((s: any) => ({ kind: str(s?.kind, 20), label: str(s?.label, 120), id: str(s?.id, 200), url: https(s?.url) })),
        followUps: arr(a.followUps, 4).map((f: unknown) => str(f, 200)).filter(Boolean),
        steps: arr(a.steps, 20).map((s: any) => ({ round: Number(s?.round) || 0, tool: str(s?.tool, 60), label: str(s?.label, 120), via: str(s?.via, 60), detail: str(s?.detail, 100) || null, ms: Number(s?.ms) || 0, ok: s?.ok !== false, summary: str(s?.summary, 200) })),
        viz: arr(a.viz, 6),
        assets: arr(a.assets, 8),
      } : null,
    };
  }).filter((t) => t.q && t.a);
  if (!turns.length) return null;
  return { title: str(body?.title, 120) || turns[0].q.slice(0, 120), turns };
}
