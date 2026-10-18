import { Router, type IRouter, type Request, type Response } from 'express';
import { requireApiKey } from '../shared/middleware';
import { McpController } from './mcp.controller';

const controller = new McpController();

/**
 * Answers the two verbs a stateless MCP endpoint cannot serve.
 *
 * GET opens the server-initiated SSE stream and DELETE tears a session down. Neither
 * exists here: every POST builds its own server and discards it, so nothing will ever
 * push a notification and there is no session to delete. Left to the transport, a GET
 * would hold an SSE connection open forever waiting for messages that cannot arrive.
 * The spec allows 405 for exactly this case, and clients fall back to POST-only.
 *
 * @param _req - Unused.
 * @param res - Response to write the JSON-RPC error to.
 */
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed. This MCP endpoint is stateless — use POST.',
    },
    id: null,
  });
}

/**
 * Router for the hosted MCP endpoint. Mounting prefix is applied in app.ts.
 *
 * `requireApiKey` rather than `requireAnyAuth`: an MCP client is a machine with a token,
 * never a browser carrying a session cookie, and accepting a cookie here would make the
 * endpoint reachable cross-site from any page the user has open.
 */
export const mcpRouter: IRouter = Router();

mcpRouter.post('/mcp', requireApiKey, controller.handle);
mcpRouter.get('/mcp', requireApiKey, methodNotAllowed);
mcpRouter.delete('/mcp', requireApiKey, methodNotAllowed);
