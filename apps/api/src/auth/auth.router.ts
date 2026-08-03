import express, { Router, IRouter } from 'express';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { requireAuth } from '../shared/middleware';
import { FirstRunController, FirstRunService } from './first-run';

/**
 * Express router for the auth endpoints this domain owns: identity read-back and
 * team switching. Instantiates the auth stack (repo → service → controller) here.
 * Mounting prefix (/api/v1) is applied in app.ts.
 *
 * Signup, login, sign-out, password reset, email verification, and the OAuth
 * callback are Better Auth's own endpoints, served by its handler under the same
 * `/api/v1/auth` prefix. **This router must be mounted first** — Better Auth's
 * handler answers everything else beneath that path, so a route registered after
 * it would never be reached. None of the names here (`me`, `teams`,
 * `switch-team`) collide with Better Auth's.
 */
const repo = new AuthRepository();
const service = new AuthService(repo);
const controller = new AuthController(service);
const firstRun = new FirstRunController(new FirstRunService(repo));

export const authRouter: IRouter = Router();

// Unauthenticated by design: it runs before any account exists. The claim token
// printed to the server's log is the entire credential.
authRouter.post('/auth/first-run/claim', express.json(), firstRun.claim);

// Also unauthenticated: the login and signup pages read it before a session can
// exist, to decide which sign-in methods to render.
authRouter.get('/auth/capabilities', controller.capabilities);

authRouter.get('/auth/me', requireAuth, controller.me);
authRouter.get('/auth/teams', requireAuth, controller.myTeams);
// JSON parsing is attached per-route rather than globally on this router. A
// router-level `express.json()` would run for every `/api/v1/*` request that
// reaches this mount — including the ones destined for Better Auth's handler,
// which is registered after it and needs an unread body stream. Parsing them
// here would leave that handler hanging on a stream nobody will ever emit.
authRouter.post('/auth/switch-team', express.json(), requireAuth, controller.switchTeam);
