/**
 * Express session lifetime. Rolling cookie + a short touch interval so an
 * active browser keeps the Mongo session alive instead of dying a fixed
 * number of days after sign-in.
 *
 * No mongoose / express imports — the session middleware reads these numbers.
 */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** connect-mongo touchAfter, seconds. Extends the server TTL at least hourly. */
export const SESSION_TOUCH_AFTER_SEC = 60 * 60;
export const SESSION_ROLLING = true;
