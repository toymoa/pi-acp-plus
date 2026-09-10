/**
 * pi-acp-plus — ACP `session/new.mcpServers` → pi 세션 주입 확장.
 *
 * pi-acp가 `-e <이 파일>`과 함께 pi를 띄우고, 서버 목록은 환경변수
 * PI_ACP_PLUS_MCP_SERVERS(JSON, ACP McpServer[] 형태: {name, command, args, env:[{name,value}]})로 건넨다.
 * stdio 서버만 다룬다(devteam이 주입하는 형태). 각 도구는 `<서버>_<도구>` 이름으로 pi에 등록된다.
 * pi가 jiti로 이 파일을 직접 로드하므로 빌드는 없다. 타입 표기는 쓰지 않는다(순수 JS).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Type from "typebox";

const REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000; // wait_tasks 같은 블록형 도구가 오래 서 있어도 끊지 않는다

function toTypebox(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 10) return Type.Any();
  const s = schema;
  const opts = typeof s.description === "string" ? { description: s.description } : {};
  if (Array.isArray(s.enum)) {
    const members = s.enum.map((v) => Type.Literal(v));
    return members.length === 1 ? members[0] : Type.Union(members, opts);
  }
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const members = (s.anyOf ?? s.oneOf).map((m) => toTypebox(m, depth + 1));
    return members.length === 1 ? members[0] : Type.Union(members, opts);
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") ?? "any" : s.type;
  switch (type) {
    case "string": return Type.String(opts);
    case "number": return Type.Number(opts);
    case "integer": return Type.Integer(opts);
    case "boolean": return Type.Boolean(opts);
    case "array": return Type.Array(toTypebox(s.items, depth + 1), opts);
    case "object": {
      const props = {};
      const required = new Set(Array.isArray(s.required) ? s.required : []);
      for (const [key, value] of Object.entries(s.properties ?? {})) {
        const inner = toTypebox(value, depth + 1);
        props[key] = required.has(key) ? inner : Type.Optional(inner);
      }
      return Type.Object(props, opts);
    }
    default: return Type.Any(opts);
  }
}

function contentToText(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || typeof item !== "object") return { type: "text", text: String(item) };
    if (item.type === "text") return { type: "text", text: String(item.text ?? "") };
    if (item.type === "resource" && item.resource?.text) return { type: "text", text: String(item.resource.text) };
    return { type: "text", text: JSON.stringify(item) };
  });
}

function safeName(text) {
  return String(text).replace(/[^A-Za-z0-9_-]/g, "_");
}

export default async function (pi) {
  const raw = process.env.PI_ACP_PLUS_MCP_SERVERS;
  if (!raw) return;
  let servers;
  try {
    servers = JSON.parse(raw);
  } catch (err) {
    console.error(`[pi-acp-plus] PI_ACP_PLUS_MCP_SERVERS is not JSON: ${err}`);
    return;
  }
  if (!Array.isArray(servers)) return;

  const clients = [];
  for (const server of servers) {
    if (!server || typeof server.command !== "string" || typeof server.name !== "string") continue;
    // SDK 의 화이트리스트(HOME·PATH·SHELL·TERM·USER…)에서 시작한다 — 워커 환경 전체
    // (API 키·PI_ACP_PLUS_MCP_SERVERS 자신)를 MCP 자식에 물려주지 않는다. ACP 엔트리의
    // env 가 그 위를 덮는다.
    const env = { ...getDefaultEnvironment() };
    for (const entry of Array.isArray(server.env) ? server.env : []) {
      if (entry && typeof entry.name === "string") env[entry.name] = String(entry.value ?? "");
    }
    const transport = new StdioClientTransport({
      command: server.command,
      args: Array.isArray(server.args) ? server.args.map(String) : [],
      env,
      cwd: process.cwd(),
    });
    const client = new Client({ name: "pi-acp-plus", version: "0.0.33-plus" }, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (err) {
      console.error(`[pi-acp-plus] MCP server "${server.name}" failed to start: ${err}`);
      continue;
    }
    let tools = [];
    try {
      const listed = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      tools = listed.tools ?? [];
    } catch (err) {
      console.error(`[pi-acp-plus] MCP server "${server.name}" tools/list failed: ${err}`);
      await client.close().catch(() => {});
      continue;
    }
    for (const tool of tools) {
      const name = safeName(`${server.name}_${tool.name}`);
      const description = tool.description ?? `MCP tool ${tool.name} (server ${server.name})`;
      pi.registerTool({
        name,
        label: tool.name,
        description,
        promptSnippet: description.slice(0, 120),
        parameters: toTypebox(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], details: {} };
          const result = await client.request(
            { method: "tools/call", params: { name: tool.name, arguments: params ?? {} } },
            CallToolResultSchema,
            { timeout: REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) },
          );
          const content = contentToText(result.content);
          if (result.isError) throw new Error(content.map((c) => c.text).join("\n") || `${tool.name} reported an error`);
          return { content, details: {} };
        },
      });
    }
    console.error(`[pi-acp-plus] MCP server "${server.name}": ${tools.length} tool(s) registered`);
    clients.push(client);
  }

  pi.on("session_shutdown", async () => {
    for (const client of clients) await client.close().catch(() => {});
  });
}
