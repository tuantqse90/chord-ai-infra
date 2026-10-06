// The answer while it is being written (docs/ask-harness-plan.md, phase 1). The final answer still arrives whole — it is
// the one that went through the address filter, the table normaliser and the number check. What streams before it is a
// DRAFT the page shows in place and replaces when the answer lands, and even the draft never shows an address a tool did
// not return: only COMPLETE lines are released (an address split across chunks cannot leak half-way), each through the
// same address rule, and nothing from "FOLLOW-UPS:" on (those become chips, not prose). A round that turns out to be a
// tool round clears whatever draft it started ("Let me check…").

import { expandSci } from "./shrink";
import { humanizeInternals } from "./humanize";

const ADDR = /0x[a-fA-F0-9]{40}\b/g;
const DSML = /<\s*[｜|]{1,2}\s*DSML/;

export class AnswerDraft {
  private raw = "";
  private shown = "";
  private stopped = false;
  private lastSent = 0;
  constructor(
    private readonly send: (text: string) => void,
    private readonly allowed: Set<string>,
    private readonly minGapMs = 200,
  ) {}

  /** A chunk of model content. */
  push(chunk: string): void {
    if (this.stopped) return;
    this.raw += chunk;
    this.flush(false);
  }

  /** The round called tools: whatever it wrote was a preamble, clear it. */
  reset(): void {
    this.raw = "";
    this.stopped = false;
    if (this.shown) { this.shown = ""; this.send(""); }
  }

  /** Release complete lines (or everything, at the end of a round). */
  flush(final: boolean): void {
    if (this.stopped) return;
    const upto = final ? this.raw.length : this.raw.lastIndexOf("\n") + 1;
    if (upto <= 0) return;
    let text = this.raw.slice(0, upto);
    const fu = text.search(/^\s*FOLLOW-UPS:/m);
    if (fu >= 0) { text = text.slice(0, fu); this.stopped = true; }
    const dsml = text.search(DSML);
    if (dsml >= 0) { text = text.slice(0, dsml); this.stopped = true; }
    const ok = new Set([...this.allowed].map((a) => a.toLowerCase()));
    text = humanizeInternals(expandSci(text.replace(ADDR, (m) => (ok.has(m.toLowerCase()) ? m : "(unverified address)")))).trimEnd();
    if (text === this.shown) return;
    const now = Date.now();
    if (!final && !this.stopped && now - this.lastSent < this.minGapMs) return;
    this.lastSent = now;
    this.shown = text;
    this.send(text);
  }
}
