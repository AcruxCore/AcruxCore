import type { Request, Response } from 'express';
import { createAcruxCoreMcpServer } from '@acruxcoreai/mcp-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { UnauthorizedError } from '../shared/errors';
import { hostedConfig } from './mcp.types';

/**
 * Serves the Model Context Protocol over Streamable HTTP at `POST /api/v1/mcp`.
 *
 * Stateless: a fresh server and transport are built for every request and thrown away
 * when the response ends. The alternative — a session id and a server kept alive between
 * requests — would pin an MCP client to whichever API instance answered its
 * `initialize`, which is wrong behind a load balancer and wrong again the moment an
 * instance is replaced during a deploy. One object graph per request is cheap; a
 * connection that breaks on every deploy is not.
 */
export class McpController {
  /**
   * Handles one MCP request.
   *
   * The caller's bearer token is reused verbatim for the loopback calls the tools make,
   * so every operation still goes through the real router: the same Zod validation, the
   * same role gate, the same audit log. Reaching into the services directly would mean
   * re-implementing all three here, and drifting from them afterwards.
   *
   * @throws {UnauthorizedError} If the Authorization header is absent — which
   *   `requireApiKey` should already have prevented, so this is a guard against the
   *   middleware being unmounted rather than an expected path.
   */
  handle = async (req: Request, res: Response): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('API key required.');
    }
    const apiKey = header.slice(7).trim();

    const { server } = createAcruxCoreMcpServer(hostedConfig(apiKey));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON rather than an SSE frame per response. Nothing this server does
      // streams — the gateway tools wait for the whole completion — so a stream would
      // add framing without adding anything a client could use earlier.
      enableJsonResponse: true,
    });

    // Both are closed on response end, in this order, so a client that disconnects
    // mid-call cannot leave a server holding a dead transport.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
