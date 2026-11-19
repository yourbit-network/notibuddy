# NotiBuddy Tool Examples

## Face ID Deployment Approval
```json
{
  "title": "Deploy v2.4.1 to production?",
  "message": "12 integration tests passed · commit a1b2c3d",
  "options": ["Approve", "Reject"],
  "decline_option": "Reject",
  "requires_auth": true,
  "sensitive": true,
  "timeout_seconds": 600,
  "wait_seconds": 55
}
```

## Resume Pending Request
```json
{
  "resume_id": "req_...",
  "wait_seconds": 55
}
```

## Code Diff Review
```json
{
  "title": "Review auth timeout change",
  "diff": {
    "filename": "src/auth.ts",
    "language": "typescript",
    "original": "const ttl = 300;\n",
    "modified": "const ttl = 600;\n"
  },
  "requires_auth": true,
  "sensitive": true
}
```
Approved only when `status === "resolved"` and `answer.action === "approve"` (plus `answer.authenticated === true`).

## Live Activity Progress
```json
{
  "id": "build-release",
  "action": "start",
  "title": "Release Build",
  "status": "Running test suite",
  "step": 1,
  "total_steps": 4
}
```

## Collect iPhone Screenshot / File
```json
{ "action": "list" }
```
Then:
```json
{ "action": "receive", "id": "file_0123456789abcdef0123456789abcdef" }
```
