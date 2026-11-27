---
name: notibuddy-setup
description: Connect and verify a paired iPhone, iPad, or Apple Watch with the bundled NotiBuddy MCP connector over OAuth. Use when setting up or troubleshooting NotiBuddy in Claude.
---

# NotiBuddy Setup & Diagnostics

Help the user connect NotiBuddy to Claude safely through the bundled hosted MCP connector (`https://mcp.notibuddy.app/mcp`) without exposing pairing codes in chat transcripts.

## Privacy Rules

- **Never ask the user to paste an `nbpair1...` setup code into chat.** The setup code belongs only on the NotiBuddy OAuth authorization screen (`https://mcp.notibuddy.app/oauth/authorize`).
- Keep any personal notification or approval content concise and mark lock-screen-sensitive prompts with `sensitive: true`.

## Step-by-Step Verification

1. **Check current pairing status:** Call `notibuddy_list_destinations`. If a paired device is returned, skip to step 3.
2. **If no destination is paired yet:**
   Guide the user through pairing via the bundled NotiBuddy connector:
   - Install the **NotiBuddy** app on iPhone or iPad ([App Store](https://apps.apple.com/app/id6823749991)) and allow notifications when prompted.
   - In NotiBuddy on iPhone/iPad, open **Connect → Add a connection → Create setup code → Share Setup** to copy an `nbpair1...` setup code (keep NotiBuddy open while completing OAuth).
   - Connect the bundled **NotiBuddy** MCP server from the plugin's **Connectors** tab in Claude and paste the `nbpair1...` code on `https://mcp.notibuddy.app/oauth/authorize`.
3. **Confirm two-way delivery:**
   Call `notibuddy_notify` with `{ "title": "NotiBuddy connected", "message": "Tap OK to confirm two-way replies.", "options": ["OK"] }`. Confirm setup only after receiving a verified `status: "resolved"` reply.
4. **Troubleshooting:**
   - If notifications do not arrive, confirm NotiBuddy has notification permissions enabled in iOS Settings and an active internet connection.
   - To switch devices or re-pair cleanly, disconnect **NotiBuddy** in Claude connector settings (revoking the OAuth token) and connect again via OAuth.
