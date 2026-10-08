import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, getOrCreateSenderKeyPair } from './config.js';
import { NotiBuddyClient } from './client.js';
import type { PresentationHints } from './types.js';

const presentationSchema = {
  type: 'object',
  description: 'Optional concise display text, encrypted with the request. Keep full context in title/message. Complex decisions always open in the app.',
  properties: {
    shortTitle: { type: 'string', minLength: 1, maxLength: 40, description: 'Single-line title for the feed and Live Activity.' },
    summary: { type: 'string', minLength: 1, maxLength: 100, description: 'Single-line essential context. Include the target or environment.' },
  },
  additionalProperties: false,
};

export const ASK_TOOL_SCHEMA = {
  name: 'notibuddy_ask',
  description:
    'Ask the user for human-in-the-loop input on their iPhone via zero-knowledge end-to-end encryption. Supports approvals, choices, inline text replies, and dynamic forms.',
  inputSchema: {
    type: 'object',
    properties: {
      presentation: presentationSchema,
      sensitive: { type: 'boolean', description: 'Hide all request content and choices on notifications and Live Activities; review privately in the app. Use for confidential, personal, or credential-related requests.' },
      title: {
        type: 'string',
        description: 'Primary title displayed on the iOS notification and Lock Screen banner',
      },
      message: {
        type: 'string',
        description: 'Detailed explanation or prompt for the user',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Interactive button choices (e.g. ["Approve", "Deny"] or ["Deploy Staging", "Deploy Prod"])',
      },
      input_placeholder: {
        type: 'string',
        description:
          'If set, displays an inline text input field on the notification banner for quick text replies',
      },
      fields: {
        type: 'array',
        description:
          'If set, renders an in-app dynamic SwiftUI form with text fields, toggles, steppers, and pickers',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: {
              type: 'string',
              enum: ['text', 'email', 'url', 'toggle', 'stepper', 'picker', 'date'],
            },
            label: { type: 'string' },
            placeholder: { type: 'string' },
            required: { type: 'boolean' },
            default: { type: ['string', 'number', 'boolean'] },
            min: { type: 'number' },
            max: { type: 'number' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                },
                required: ['id', 'label'],
              },
            },
          },
          required: ['id', 'type', 'label'],
        },
      },
      requires_auth: {
        type: 'boolean',
        description: 'Require Face ID / Touch ID authentication to approve this action',
      },
      wait_seconds: {
        type: 'number',
        description:
          'Maximum seconds to wait for a human response before returning a pending handle (default: 25, max: 55)',
        default: 25,
      },
      resume_id: {
        type: 'string',
        description: 'If checking or resuming a previously pending request, pass its request_id here',
      },
    },
    anyOf: [{ required: ['title'] }, { required: ['resume_id'] }],
  },
};

export const ACTIVITY_TOOL_SCHEMA = {
  name: 'notibuddy_activity',
  description:
    'Use poll to read user timer controls. Control ambient Dynamic Island and Lock Screen Live Activities on the user\'s iPhone with zero-knowledge E2EE (start countdown timers, track multi-step progress, or end activities).',
  inputSchema: {
    type: 'object',
    properties: {
      presentation: presentationSchema,
      sensitive: { type: 'boolean', description: 'Hide all request content and choices on notifications and Live Activities; review privately in the app. Use for confidential, personal, or credential-related requests.' },
      id: {
        type: 'string',
        description: 'Unique session identifier for this activity (e.g. "ci-tests-42" or "sprint-timer")',
      },
      action: {
        type: 'string',
        enum: ['start', 'update', 'end', 'poll'],
        description: 'Activity lifecycle action to perform',
      },
      title: {
        type: 'string',
        description: 'Title displayed on the Dynamic Island pill and expanded banner',
      },
      controls: {type: 'array', items: {type: 'string', enum: ['pause','resume','cancel','add_5m']}},
      timer_minutes: {
        type: 'number',
        description: 'If set, starts a hardware countdown timer on the Dynamic Island',
      },
      step: {
        type: 'number',
        description: 'Current step number for multi-step progress (e.g. 3)',
      },
      total_steps: {
        type: 'number',
        description: 'Total number of steps in progress bar (e.g. 10)',
      },
      status: {
        type: 'string',
        description: 'Short real-time status label (e.g. "Running unit tests...")',
      },
    },
    required: ['id', 'action'],
  },
};

export async function createMcpServer(): Promise<Server> {
  const config = loadConfig();
  if (!config) {
    throw new Error(
      'NotiBuddy is not paired. Please run "nb pair <pairing_bundle>" first.'
    );
  }

  const senderKey = await getOrCreateSenderKeyPair();
  const client = new NotiBuddyClient(config, senderKey.signingKey);

  const server = new Server(
    {
      name: 'notibuddy',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [ASK_TOOL_SCHEMA, ACTIVITY_TOOL_SCHEMA],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'notibuddy_ask') {
        const result = await client.ask({
          title: args?.title as string,
          presentation: args?.presentation as PresentationHints | undefined,
          sensitive: args?.sensitive as boolean | undefined,
          message: args?.message as string | undefined,
          options: args?.options as string[] | undefined,
          inputPlaceholder: args?.input_placeholder as string | undefined,
          fields: args?.fields as any[] | undefined,
          requiresAuth: args?.requires_auth as boolean | undefined,
          waitSeconds: args?.wait_seconds as number | undefined,
          resumeId: args?.resume_id as string | undefined,
        });

        const safeResult = {
          status: result.status,
          requestId: result.requestId,
          answer: result.answer,
          errorCode: result.errorCode,
          message: result.message,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(safeResult, null, 2),
            },
          ],
        };
      }

      if (name === 'notibuddy_activity') {
        const result = await client.activity({
          activityId: args?.id as string,
          presentation: args?.presentation as PresentationHints | undefined,
          sensitive: args?.sensitive as boolean | undefined,
          action: args?.action as 'start' | 'update' | 'end' | 'poll',
          title: args?.title as string | undefined,
          status: args?.status as string | undefined,
          step: args?.step as number | undefined,
          totalSteps: args?.total_steps as number | undefined,
          timerMinutes: args?.timer_minutes as number | undefined,
          controls: args?.controls as ('pause'|'resume'|'cancel'|'add_5m')[] | undefined,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${err.message}`,
          },
        ],
      };
    }
  });

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
