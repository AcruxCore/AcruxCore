import { Router, type IRouter } from 'express';
import { requireAnyAuth } from '../../shared/middleware';
import { ViewsRepository } from './views.repository';
import { ViewsService } from './views.service';
import { ViewsController } from './views.controller';

const repo = new ViewsRepository();
const service = new ViewsService(repo);
const controller = new ViewsController(service);

/**
 * Saved views for the trace and feedback lists, mounted at `/api/v1/trace-views`
 * in app.ts.
 *
 * Deliberately NOT under `/api/v1/traces`: that path is followed by
 * `traceQueryRouter`'s `/traces/:id`, so a nested `/traces/views` would have to
 * win a route-ordering race for no benefit. A saved view is not a trace.
 *
 * Any authenticated member may create, rename and delete — see ViewsService for
 * why per-user ownership was rejected.
 */
export const viewsRouter: IRouter = Router();

viewsRouter.get('/trace-views', requireAnyAuth, controller.list);
viewsRouter.post('/trace-views', requireAnyAuth, controller.create);
viewsRouter.patch('/trace-views/:id', requireAnyAuth, controller.update);
viewsRouter.delete('/trace-views/:id', requireAnyAuth, controller.remove);
