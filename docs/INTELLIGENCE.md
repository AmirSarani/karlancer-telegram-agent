# Intelligence layers (current)

1. **Rules** — `src/intelligence/pricing.js` stage-based IRR ranges; cannot be overridden by LLM for policy.
2. **Memory** — SQLite `memory_items` + search tool.
3. **Router / TokenBudget** — deterministic intents skip LLM.
4. **Pricing recommendation** — confidence + assumptions + requiresApproval.
5. **Feedback** — `pricing.record_decision` / memory kinds; no online training.

Full RAG/ML evaluation harness is stubbed as future work (honest gap).
