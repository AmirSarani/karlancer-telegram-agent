# MCP Tools

| Tool | Permission | Side effects |
|------|------------|--------------|
| `health.get` | read | none |
| `project.get` | read | HTTP publics |
| `project.list_invites` | read | enqueues `rooms.scan` |
| `room.messages` | read | HTTP |
| `bids.check` | read | HTTP |
| `bids.submit_plan` | write | creates approval-gated job |
| `messages.send_plan` | write | creates approval-gated job |
| `job.create` | write | queue (safe goals only) |
| `job.get_status` | read | none |
| `job.cancel` | write | cancel if allowed |
| `memory.search` / `memory.append_event` | read/write | SQLite |
| `pricing.get_recommendation` / `pricing.record_decision` | read/write | rules / memory |
| `approvals.list` / `approvals.decide` | read/approve | HITL |
| `audit.search` | read | none |
| `intelligence.get_insight` | read | memory |

Resources: `karlancer://handoff`, `karlancer://project-state`, `karlancer://api-audit`, `karlancer://api-catalog`.
