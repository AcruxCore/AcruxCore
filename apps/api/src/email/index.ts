export * from './email.types';
export * from './email.config';
export * from './email.transport';
export * from './memory.transport';
export * from './ses.transport';
export * from './smtp.transport';
export * from './email.repository';
export * from './templates';
export * from './email.queue';
export * from './email.service';
export * from './email.processor';
// Only the token helpers, not `./unsubscribe`'s barrel: the router and controller
// there import the notifications domain, which imports this barrel back through
// `notify.ts`. Re-exporting them would make that a genuine import cycle. `app.ts`
// imports the router from its own barrel directly.
export * from './unsubscribe/unsubscribe.token';
