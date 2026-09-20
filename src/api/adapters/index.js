import { KarlancerClient } from '../client.js';
import { createRoomsAdapter } from './rooms.js';
import { createMessagesAdapter } from './messages.js';
import { createProjectsAdapter } from './projects.js';
import { createBidsAdapter } from './bids.js';
import { createUserAdapter } from './user.js';

/**
 * @param {import('../client.js').KarlancerClientOptions & { client?: KarlancerClient }} [opts]
 */
export function createKarlancerApi(opts = {}) {
  const client = opts.client || new KarlancerClient(opts);
  return {
    client,
    rooms: createRoomsAdapter(client),
    messages: createMessagesAdapter(client),
    projects: createProjectsAdapter(client),
    bids: createBidsAdapter(client),
    user: createUserAdapter(client),
  };
}

export { KarlancerClient };
