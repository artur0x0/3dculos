/**
 * Entry for `node --test test/` on Node builds that execute a directory
 * argument as a package instead of walking it. Importing the suite runs it.
 *
 * Run: cd backend && npm install && node --test test/
 */
import './cart-order.test.js';
