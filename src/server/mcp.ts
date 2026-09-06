// MCP over the streamable-HTTP transport, stateless: a fresh McpServer and
// transport per request, no session ids, and JSON responses rather than an SSE
// stream per call (the tools are synchronous, so there is nothing to stream).
// Nothing here knows about the six tools beyond TOOLS — the same registry the
// in-app chat will read.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, ToolError, type ToolContext } from "../tools";

export async function handleMcp(req: Request, ctx: ToolContext): Promise<Response> {
  if (req.method === "GET") {
    // No standalone stream: stateless, so there are no server-initiated
    // notifications to carry. Play updates go over /p/:id/events instead.
    return new Response("method not allowed\n", { status: 405, headers: { Allow: "POST, DELETE" } });
  }
  const server = new McpServer(
    { name: "pupper-theater", version: "0.2.0" },
    { instructions: "Stage wordless shadow-puppet plays. Every edit shows up live at the play's URL." },
  );
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, (args: unknown) =>
      call(tool.name, () => tool.run(ctx, args)),
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  // enableJsonResponse means the body is complete by now, so nothing is cut off.
  await server.close();
  return res;
}

function call(name: string, run: () => unknown): CallToolResult {
  try {
    return { content: [{ type: "text", text: JSON.stringify(run(), null, 2) }] };
  } catch (e) {
    const message = e instanceof ToolError ? e.message : `${name} failed: ${(e as Error).message}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
