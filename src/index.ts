import { handle } from "./handle";
import { sendNewItemsMail } from "./new-items";
import { sendWishReport } from "./wish-report";

export { MeritLink } from "./merit-link";

// Each cron in wrangler.jsonc runs one job.
const JOBS: Record<string, (env: Env, now: number) => Promise<number>> = {
  "0 12 * * *": sendWishReport,
  "0 13 * * *": sendNewItemsMail,
};

export default {
  async fetch(request, env): Promise<Response> {
    return handle(request, env);
  },
  async scheduled(controller, env, ctx): Promise<void> {
    const job = JOBS[controller.cron];
    if (job) ctx.waitUntil(job(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
