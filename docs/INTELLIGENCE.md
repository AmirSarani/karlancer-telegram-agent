# INTELLIGENCE

Layers (honest):

1. **Rules** — versioned `PRICING_RULES_VERSION` deterministic pricing  
2. **Memory/RAG** — SQLite `memory_items` + feedback table  
3. **Features** — explainable extractFeatures()  
4. **Recommendation** — economy/standard/premium + confidence + `requiresApproval`  
5. **Feedback** — `intelligence_feedback` + `intelligence.record_feedback` tool  

If samples < 3 → status `insufficient_data` (no fake high confidence).  
**No ML model training in production** without versioned dataset, PII redaction, eval set, drift detection, rollback, and human approval.
