import { KarlancerClient } from '../client.js';
import { createRoomsAdapter } from './rooms.js';
import { createMessagesAdapter } from './messages.js';
import { createProjectsAdapter } from './projects.js';
import { createBidsAdapter } from './bids.js';
import { createUserAdapter } from './user.js';
import { createNotificationsAdapter } from './notifications.js';
import { createBookmarksAdapter } from './bookmarks.js';
import { createSearchAdapter } from './search.js';
import { createFilesAdapter } from './files.js';
import { createPlansAdapter } from './plans.js';
import { loadLocalVerifiedMutations } from '../contracts/load-local.js';

/**
 * @param {import('../client.js').KarlancerClientOptions & { client?: KarlancerClient }} [opts]
 */
export function createKarlancerApi(opts = {}) {
  loadLocalVerifiedMutations();
  const client = opts.client || new KarlancerClient(opts);
  return {
    client,
    rooms: createRoomsAdapter(client),
    messages: createMessagesAdapter(client),
    projects: createProjectsAdapter(client),
    bids: createBidsAdapter(client),
    user: createUserAdapter(client),
    notifications: createNotificationsAdapter(client),
    bookmarks: createBookmarksAdapter(client),
    search: createSearchAdapter(client),
    files: createFilesAdapter(client),
    plans: createPlansAdapter(client),
  };
}

export { KarlancerClient };
