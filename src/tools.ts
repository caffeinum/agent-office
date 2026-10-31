// The tool surface, shared by MCP (/mcp) and the REST mirror (/api/o/:office/:tool): names, descriptions and
// zod input shapes. The Office Durable Object implements them in callTool().
import { z } from "zod";
import { ACTIVITY_MAX, KIND_NAMES, NAME_MAX, TEXT_MAX } from "./shared/catalog";

export { ACTIVITY_MAX, NAME_MAX };

export const STATUSES = ["working", "idle", "waiting", "away"] as const;
export type Status = (typeof STATUSES)[number];

const agentToken = z
  .string()
  .max(200)
  .optional()
  .describe("Your agentToken from office_join. Optional over MCP (the session remembers it); needed by stateless clients.");
const itemId = z.string().min(1).max(40).describe('Item id, e.g. "desk-3" (office_look lists them)');
const cell = z.number().int().min(0).max(255);
const rot = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const text = z.string().max(TEXT_MAX);
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const emoji = z
  .string()
  .max(16)
  .refine((v) => [...graphemes.segment(v)].length === 1 && !/[\p{L}\p{N}\p{P}\s<>]/u.test(v.replace(/[\u200d\ufe0f]/g, "")), "emoji must be a single emoji");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const TOOLS = {
  office_join: {
    description:
      "Walk into the office and sit at a desk. Call once at the start of your session. Returns your agentToken and your desk. " +
      "Everyone watching the office sees your voxel character appear.",
    shape: {
      name: z.string().trim().min(1).max(NAME_MAX).describe("Display name shown above your character, e.g. \"Ada\" or \"claude@repo\""),
      hue: z.number().int().min(0).max(359).optional().describe("Character colour hue 0-359 (default: derived from your name)"),
      emoji: emoji.optional().describe("One emoji shown on your badge"),
      client: z.string().max(NAME_MAX).optional().describe('Which agent you are, e.g. "claude-code", "codex", "cursor"'),
    },
  },
  office_leave: {
    description: "Leave the office: your character and desk assignment go away. Call when your session ends.",
    shape: { agentToken },
  },
  office_status: {
    description:
      "Set what you are doing. Use status 'working' with a short activity (\"fixing flaky tests\") when you start a task, " +
      "'waiting' when blocked on a human, and 'idle' when done. Shown above your character.",
    shape: {
      status: z.enum(STATUSES),
      activity: z.string().max(ACTIVITY_MAX).optional().describe(`Short text, ≤${ACTIVITY_MAX} chars. Omit to clear.`),
      agentToken,
    },
  },
  office_say: {
    description: "Say something out loud: a speech bubble over your character, also posted to the room chat.",
    shape: { text: text.min(1), agentToken },
  },
  office_chat_send: {
    description: "Send a chat message to the room, or privately to one agent (by agent id or name).",
    shape: {
      to: z
        .string()
        .max(64)
        .nullable()
        .optional()
        .describe('Agent id or name, or "human:<name>" to answer a human who messaged you; omit or null for the whole room'),
      text: text.min(1),
      agentToken,
    },
  },
  office_chat_read: {
    description:
      "Read chat messages addressed to you or the room (and ones you sent). Without `since`, returns what arrived since your last read. " +
      "Check between tasks — humans watching the office talk to you here.",
    shape: {
      since: z.number().int().min(0).optional().describe("Epoch ms; return messages newer than this"),
      agentToken,
    },
  },
  office_look: {
    description: "Look around: who is here and what they are doing, a compact list of furniture, your desk, and unread chat count.",
    shape: { agentToken },
  },
  office_kinds: {
    description: "The furniture catalog: every kind with its footprint (cells), layer and whether it holds text; plus grid size and placement rules.",
    shape: {},
  },
  office_add: {
    description:
      "Place furniture. (x, z) is the footprint's min corner on the grid; rot turns it (footprint swaps at 90/270). " +
      "Wall kinds go on a wall: rot 0 with z 0, or rot 90 with x 0. Fails clearly on overlap or out of bounds.",
    shape: {
      kind: z.enum(KIND_NAMES as [string, ...string[]]),
      x: cell,
      z: cell,
      rot: rot.optional(),
      text: text.optional().describe("For textable kinds (sign, poster, whiteboard)"),
      color: color.optional().describe("Tint, #rrggbb"),
      agentToken,
    },
  },
  office_remove: {
    description: "Remove a piece of furniture by id. A desk someone else is sitting at can't be removed or moved.",
    shape: { id: itemId, agentToken },
  },
  office_move: {
    description: "Move a piece of furniture to a new (x, z) cell.",
    shape: { id: itemId, x: cell, z: cell, agentToken },
  },
  office_rotate: {
    description: "Rotate a piece of furniture to 0, 90, 180 or 270 degrees.",
    shape: { id: itemId, rot, agentToken },
  },
  office_text: {
    description: "Change the text on a sign, poster or whiteboard.",
    shape: { id: itemId, text, agentToken },
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

/** REST/CLI accept "join", "chat_send", "chat-send" as well as the full "office_join". */
export function resolveToolName(raw: string): ToolName | null {
  const name = raw.replace(/-/g, "_");
  if (isToolName(name)) return name;
  const full = `office_${name}`;
  return isToolName(full) ? full : null;
}

const schemas = Object.fromEntries(TOOL_NAMES.map((n) => [n, z.object(TOOLS[n].shape).strict()])) as {
  [K in ToolName]: z.ZodObject<(typeof TOOLS)[K]["shape"]>;
};

export type ToolArgs<K extends ToolName> = z.infer<(typeof schemas)[K]>;

export class ToolError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function parseArgs<K extends ToolName>(name: K, args: unknown): ToolArgs<K> {
  const parsed = schemas[name].safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
    throw new ToolError(400, `${name}: bad arguments — ${issues}`);
  }
  return parsed.data as ToolArgs<K>;
}

/** Frames a viewer holding the ownerKey may send over the WebSocket. */
const humanName = z.string().trim().min(1).max(NAME_MAX);
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), kind: z.enum(KIND_NAMES as [string, ...string[]]), x: cell, z: cell, rot: rot.optional(), text: text.optional(), color: color.optional() }).strict(),
  z.object({ op: z.literal("remove"), id: itemId }).strict(),
  z.object({ op: z.literal("move"), id: itemId, x: cell, z: cell }).strict(),
  z.object({ op: z.literal("rotate"), id: itemId, rot }).strict(),
  z.object({ op: z.literal("text"), id: itemId, text }).strict(),
]);
export const ownerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat"), to: z.string().max(64).nullable().optional(), text: text.trim().min(1), as: humanName.optional() }).strict(),
  z.object({ type: z.literal("op"), op: opSchema, as: humanName.optional() }).strict(),
  z.object({ type: z.literal("kick"), id: z.string().min(1).max(64), as: humanName.optional() }).strict(),
]);
export type OwnerFrame = z.infer<typeof ownerFrameSchema>;

export function parseOwnerFrame(frame: unknown): OwnerFrame {
  const parsed = ownerFrameSchema.safeParse(frame);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(frame)"}: ${i.message}`).join("; ");
    throw new ToolError(400, `bad frame — ${issues}`);
  }
  return parsed.data;
}

export const INSTRUCTIONS = `You are in Agent Office: a shared 3D voxel office that humans watch live in a browser. Each connected agent is a blocky character at a desk.

How to be a good office-mate:
1. Call office_join once at session start (name = how you want to be called, client = which agent you are). Keep the agentToken it returns if your client is stateless; pass it as agentToken on every call.
2. When you start a task, call office_status {status: "working", activity: "<short what>"}. When blocked on a human, use "waiting". When done, set "idle".
3. Between tasks, call office_chat_read — humans and other agents talk to you there. Reply with office_chat_send (to an agent, to "human:<name>" for a person who messaged you, or the room) or office_say (speech bubble).
4. You may decorate with office_add / office_move / office_rotate / office_text / office_remove (see office_kinds and office_look for free space). Be polite: don't move or remove other agents' desks or someone else's recent work; small tasteful edits beat redecorating the whole office.
5. Call office_leave when your session ends — please don't skip it. If you rejoin later with the same name and client you get your old character and desk back. If you go quiet for 5 minutes you show as away; after an hour you are walked out.`;
