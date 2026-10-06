// Stateless MCP endpoint at POST /mcp.
//
// The robot already holds an hb_ token. That token was minted after a
// human signed in with GitHub at /verify. This route checks the same
// Bearer header the REST API checks, then calls those routes. It does
// not start a browser login and it does not speak to GitHub itself.
//
// No OAuth discovery metadata. A 401 that points at an authorization
// server makes MCP clients open a browser instead of sending the header
// the caller already configured.

import type { Context } from "hono";
import type { Bindings, Variables } from "./types";
import { hashToken } from "./crypto";
import { getUserByTokenHash, touchToken } from "./db";

type App = {
  request: (
    input: string,
    init: RequestInit,
    env: Bindings,
    executionCtx?: ExecutionContext
  ) => Response | Promise<Response>;
};

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown; protocolVersion?: string };
};

const PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];

const SERVER_INFO = { name: "htmlbin", version: "0.1.0" };

const INSTRUCTIONS =
  "Tools act as the htmlbin user bound to the Bearer hb_ token on this request. " +
  "That token was issued after a human signed in with GitHub. " +
  "Send the same Authorization header on every request, including initialize.";

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const STRING = { type: "string" };
const METADATA = {
  type: "object",
  additionalProperties: { type: "string" },
  description: "Flat string-to-string tag bag. At most 10 keys.",
};

const TOOLS: ToolSpec[] = [
  {
    name: "whoami",
    description: "Return the user and token bound to the Bearer hb_ token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_drop",
    description:
      "Publish a new drop (version 1). Returns the full drop, including its public URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "html"],
      properties: {
        title: { ...STRING, description: "Required. At most 200 characters." },
        html: { ...STRING, description: "Required. Full HTML document, at most 2 MB." },
        description: { ...STRING, description: "Optional. At most 500 characters." },
        passcode: { ...STRING, description: "Optional share gate. At least 4 characters." },
        context: { ...STRING, description: "Optional reasoning trace. At most 64 KB. Include only with the human's agreement." },
        metadata: METADATA,
      },
    },
  },
  {
    name: "get_drop",
    description: "Fetch one drop you own.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: STRING },
    },
  },
  {
    name: "list_drops",
    description:
      "List your drops. metadata filters are AND across pairs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        page: { type: "integer", minimum: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 200 },
        sort_by: { type: "string", enum: ["created_at", "updated_at", "view_count"] },
        sort_order: { type: "string", enum: ["asc", "desc"] },
        metadata: METADATA,
      },
    },
  },
  {
    name: "update_drop",
    description:
      "Mint a new version of a drop. The public URL stays the same. html is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "html"],
      properties: {
        slug: STRING,
        html: STRING,
        title: STRING,
        description: STRING,
        context: STRING,
        metadata: METADATA,
      },
    },
  },
  {
    name: "patch_drop",
    description:
      "Change title, description, or metadata without minting a version. Do not send html.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: {
        slug: STRING,
        title: STRING,
        description: STRING,
        metadata: METADATA,
      },
    },
  },
  {
    name: "delete_drop",
    description: "Delete a drop and every version. Returns no drop body.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: STRING },
    },
  },
  {
    name: "list_versions",
    description: "List versions of a drop you own.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: STRING },
    },
  },
  {
    name: "get_version",
    description: "Fetch one version, including its context when one was stored.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "version"],
      properties: {
        slug: STRING,
        version: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    name: "delete_version",
    description:
      "Delete one version. Refused when it is the only version left.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "version"],
      properties: {
        slug: STRING,
        version: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    name: "set_passcode",
    description:
      "Set, change, or clear the share-gate passcode. Pass an empty string to clear it. This is not encryption.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "passcode"],
      properties: {
        slug: STRING,
        passcode: { ...STRING, description: "At least 4 characters, or empty to remove." },
      },
    },
  },
];

export async function handleMcp(c: Ctx, app: App): Promise<Response> {
  if (c.req.method !== "POST") {
    return jsonRpc(null, { code: -32601, message: "MCP is POST only." }, 405, {
      Allow: "POST",
    });
  }

  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(hb_[A-Za-z0-9]+)$/.exec(header);
  const token = match?.[1];
  if (!token) return unauthorized("Missing or malformed Authorization: Bearer hb_… header.");

  const tokenHash = await hashToken(token, c.env.TOKEN_PEPPER);
  const user = await getUserByTokenHash(c.env.DB, tokenHash);
  if (!user) return unauthorized("Token not recognized or revoked.");
  c.executionCtx.waitUntil(touchToken(c.env.DB, tokenHash));

  let message: JsonRpc;
  try {
    message = (await c.req.json()) as JsonRpc;
  } catch {
    return jsonRpc(null, { code: -32700, message: "Parse error." }, 400);
  }
  if (Array.isArray(message) || !message || message.jsonrpc !== "2.0" || !message.method) {
    return jsonRpc(message?.id ?? null, { code: -32600, message: "Invalid request." }, 400);
  }

  // initialize negotiates from params.protocolVersion. Every later request
  // carries the agreed version in the MCP-Protocol-Version header.
  const protocol =
    message.method === "initialize"
      ? negotiate(message.params?.protocolVersion)
      : fromHeader(c.req.header("MCP-Protocol-Version"));

  if (message.id === undefined || message.id === null) {
    return new Response(null, { status: 202, headers: protocolHeader(protocol) });
  }

  if (message.method === "initialize") {
    return jsonRpc(
      message.id,
      {
        protocolVersion: protocol,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
      200,
      protocolHeader(protocol)
    );
  }

  if (message.method === "ping") {
    return jsonRpc(message.id, {}, 200, protocolHeader(protocol));
  }

  if (message.method === "tools/list") {
    return jsonRpc(message.id, { tools: TOOLS }, 200, protocolHeader(protocol));
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return jsonRpc(
        message.id,
        toolError(`Unknown tool: ${name ?? ""}`),
        200,
        protocolHeader(protocol)
      );
    }
    const args = asArgs(message.params?.arguments);
    if (!args) {
      return jsonRpc(
        message.id,
        toolError("Tool arguments must be an object."),
        200,
        protocolHeader(protocol)
      );
    }
    const result = await callTool(app, c, tool.name, args);
    return jsonRpc(message.id, result, 200, protocolHeader(protocol));
  }

  return jsonRpc(
    message.id,
    { code: -32601, message: `Method not found: ${message.method}` },
    200,
    protocolHeader(protocol)
  );
}

// Per the MCP lifecycle spec: echo the client's version when we support
// it, otherwise answer with the latest version we support.
function negotiate(requested: string | undefined): string {
  if (requested && PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSIONS[0]!;
}

// Post-initialize requests. A missing header means 2025-03-26 (the spec's
// backwards-compatibility default); an unknown one falls back the same way
// rather than failing the call.
function fromHeader(value: string | undefined): string {
  if (value && PROTOCOL_VERSIONS.includes(value)) return value;
  return "2025-03-26";
}

function protocolHeader(protocol: string): Record<string, string> {
  return { "MCP-Protocol-Version": protocol };
}

function unauthorized(message: string): Response {
  return jsonRpc(null, { code: -32001, message }, 401, {
    "WWW-Authenticate": 'Bearer realm="htmlbin"',
  });
}

function jsonRpc(
  id: string | number | null,
  payload: Record<string, unknown> | { code: number; message: string },
  status: number,
  extra: Record<string, string> = {}
): Response {
  const isError = "code" in payload && typeof payload.code === "number" && !("content" in payload);
  const body = isError
    ? { jsonrpc: "2.0", id, error: payload }
    : { jsonrpc: "2.0", id, result: payload };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

function toolOk(text: string) {
  return { content: [{ type: "text", text }], isError: false };
}

function asArgs(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function callTool(
  app: App,
  c: Ctx,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
  const missing = required(name, args);
  if (missing) return toolError(missing);

  let path = "";
  let method = "GET";
  let body: Record<string, unknown> | undefined;
  let search = "";

  switch (name) {
    case "whoami":
      path = "/api/me";
      break;
    case "create_drop":
      path = "/api/drops";
      method = "POST";
      body = pick(args, ["title", "html", "description", "passcode", "context", "metadata"]);
      break;
    case "get_drop":
      path = `/api/drops/${encodeURIComponent(String(args.slug))}`;
      break;
    case "list_drops":
      path = "/api/drops";
      search = listSearch(args);
      break;
    case "update_drop":
      path = `/api/drops/${encodeURIComponent(String(args.slug))}`;
      method = "PUT";
      body = pick(args, ["html", "title", "description", "context", "metadata"]);
      break;
    case "patch_drop":
      path = `/api/drops/${encodeURIComponent(String(args.slug))}`;
      method = "PATCH";
      body = pick(args, ["title", "description", "metadata"]);
      break;
    case "delete_drop":
      path = `/api/drops/${encodeURIComponent(String(args.slug))}`;
      method = "DELETE";
      break;
    case "list_versions":
      path = `/api/drops/${encodeURIComponent(String(args.slug))}/versions`;
      break;
    case "get_version":
      path = `/api/drops/${encodeURIComponent(String(args.slug))}/v/${encodeURIComponent(String(args.version))}`;
      break;
    case "delete_version":
      path = `/api/drops/${encodeURIComponent(String(args.slug))}/v/${encodeURIComponent(String(args.version))}`;
      method = "DELETE";
      break;
    case "set_passcode":
      path = `/api/drops/${encodeURIComponent(String(args.slug))}/passcode`;
      method = "POST";
      body = { passcode: args.passcode };
      break;
    default:
      return toolError(`Unknown tool: ${name}`);
  }

  const res = await callApi(app, c, path + search, method, body);
  if (res.status === 204) return toolOk("deleted");
  if (res.status >= 400) return toolError(res.body || `HTTP ${res.status}`);
  return toolOk(res.body);
}

function required(name: string, args: Record<string, unknown>): string | null {
  const need: Record<string, string[]> = {
    create_drop: ["title", "html"],
    get_drop: ["slug"],
    update_drop: ["slug", "html"],
    patch_drop: ["slug"],
    delete_drop: ["slug"],
    list_versions: ["slug"],
    get_version: ["slug", "version"],
    delete_version: ["slug", "version"],
    set_passcode: ["slug", "passcode"],
  };
  for (const key of need[name] ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      if (name === "set_passcode" && key === "passcode" && args.passcode === "") continue;
      return `Missing ${key}.`;
    }
  }
  return null;
}

function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

function listSearch(args: Record<string, unknown>): string {
  const q = new URLSearchParams();
  if (args.page !== undefined) q.set("page", String(args.page));
  if (args.page_size !== undefined) q.set("pageSize", String(args.page_size));
  if (args.sort_by !== undefined) q.set("sortBy", String(args.sort_by));
  if (args.sort_order !== undefined) q.set("sortOrder", String(args.sort_order));
  const meta = args.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      q.append(`metadata.${key}`, String(value));
    }
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function callApi(
  app: App,
  c: Ctx,
  path: string,
  method: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: string }> {
  const headers = new Headers();
  headers.set("Authorization", c.req.header("Authorization") ?? "");
  headers.set("Content-Type", "application/json");
  const ua = c.req.header("User-Agent");
  if (ua) headers.set("User-Agent", ua);
  const ip = c.req.header("CF-Connecting-IP");
  if (ip) headers.set("CF-Connecting-IP", ip);

  const res = await app.request(
    `https://htmlbin.internal${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    c.env,
    c.executionCtx
  );
  return { status: res.status, body: await res.text() };
}
