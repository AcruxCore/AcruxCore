import type { NextFunction, Request, Response } from 'express';
import { createAcruxCoreMcpServer } from '@acruxcoreai/mcp-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { UnauthorizedError, ValidationError } from '../shared/errors';
import { hostedConfig } from './mcp-hosted-config';
import { HostedMcpQuerySchema } from './mcp.types';

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
   * Query parameters carry the same options as the local server's CLI flags (see
   * `HOSTED_OPTIONS`), so one URL can ask for a read-only or narrowed tool list.
   *
   * Every failure — a missing key, a bad option, or the MCP server or transport rejecting —
   * is passed to `next()`, so the error middleware answers it. Express 4 does not catch a
   * rejected promise from a handler: a throw left to escape would hang the request, and on
   * Node 22 an unhandled rejection can end the process. An error after the transport
   * started writing is forwarded too; the error middleware logs it and ends the response.
   *
   * Errors forwarded to `next()`: `ValidationError` for an unknown or invalid query
   * option, and `UnauthorizedError` if the Authorization header is absent — which
   * `requireApiKey` should already have prevented, so that one guards against the
   * middleware being unmounted rather than an expected path.
   */
  handle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        throw new UnauthorizedError('API key required.');
      }
      const apiKey = header.slice(7).trim();
      const query = HostedMcpQuerySchema.safeParse(req.query);
      if (!query.success) throw new ValidationError(query.error.issues[0].message);
      const { server } = createAcruxCoreMcpServer(hostedConfig(apiKey, query.data));

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
    } catch (err) {
      next(err);
    }
  };
}
