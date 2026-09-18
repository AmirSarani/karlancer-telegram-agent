import { loadConfig } from './config.js';
import { createBot } from './telegram/bot.js';
import { RoomMemory } from './agent/memory.js';
// Browser is optional at startup — import when ready:
// import { KarlancerBrowser } from './browser/karlancer.js';

async function main() {
  // Allow first run without owner id so /start can reveal chat id
  let config;
  try {
    config = loadConfig({ requireOwner: true });
  } catch (err) {
    if (String(err.message || err).includes('TELEGRAM_OWNER_CHAT_ID')) {
      console.warn(err.message);
      config = loadConfig({ requireOwner: false });
    } else {
      throw err;
    }
  }

  const memory = new RoomMemory(config.memoryDir);
  await memory.ensureDir();

  const { bot, start, runtime } = createBot({
    token: config.telegramBotToken,
    ownerChatId: config.telegramOwnerChatId,
    hooks: {
      onStatus: async () => {
        return `memoryDir: ${config.memoryDir}\nopenai: ${config.openaiApiKey ? 'key set' : 'no key'}`;
      },
    },
  });

  // Optional later:
  // const browser = new KarlancerBrowser({
  //   storageStatePath: config.karlancerStorageStatePath,
  //   headless: config.headless,
  // });
  // await browser.launch();

  const shutdown = async (signal) => {
    console.log(`[main] ${signal} — stopping…`);
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[main] karlancer-telegram-agent MVP');
  console.log(`[main] runtime state=${runtime.state} owner=${config.telegramOwnerChatId ?? 'unset'}`);
  await start();
}

main().catch((err) => {
  console.error('[main] fatal', err);
  process.exit(1);
});
