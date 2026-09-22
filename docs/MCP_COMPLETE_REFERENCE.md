# MCP Complete Reference

## Tools (read / plan)

### Health & ops
- `health.get`

### Conversations
- `rooms.list` / `conversations.list`
- `conversations.list_archived`
- `room.messages` / `conversations.messages`

### Projects
- `project.get`
- `project.list_invites` (async scan job)
- `projects.search`
- `projects.suggest`
- `project.analyze_plan`
- `proposal.draft_plan`

### Bids
- `bids.check`
- `bids.submit_plan` → approval; execution gated by VerifiedMutationContract

### Messaging
- `messages.send_plan` → approval; execution gated

### Notifications / user / dashboard / bookmarks / plans / files
- `notifications.list`
- `user.profile`
- `dashboard.get`
- `bookmarks.projects`
- `bookmarks.freelancers`
- `plans.list`
- `files.seo_meta`

### Jobs / memory / pricing / approvals / audit / intelligence
- `job.create`, `job.get_status`, `job.cancel`
- `memory.search`, `memory.append_event`
- `pricing.get_recommendation`, `pricing.record_decision`
- `approvals.list`, `approvals.get`, `approvals.decide`
- `audit.search`
- `intelligence.get_insight`, `intelligence.record_feedback`

All tool responses are **normalized JSON** (no raw Laravel dumps; `raw` stripped).

## Resources
| URI | Description |
|-----|-------------|
| `karlancer://handoff` | AGENT_HANDOFF.md |
| `karlancer://project-state` | PROJECT_STATE.md |
| `karlancer://api-audit` | IMPLEMENTATION_AUDIT.md |
| `karlancer://api-catalog` | API map/catalog |
| `karlancer://profile` | Live profile/dashboard (tenant-tagged) |
| `karlancer://conversations` | Live rooms page 1 |
| `karlancer://notifications` | Live notifications page 1 |
| `karlancer://projects` | Guidance resource (use tools; no bulk scrape) |

## Permissions
Tools use `read` / `write` / `approve` scopes. Tenant isolation enforced for jobs/approvals/audit.

## Mutations
See MUTATION_CONTRACTS.md — fail-closed without local contract registration.
