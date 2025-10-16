import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";

try {
  const app = await createApp();
  await app.listen({ host, port });
  app.log.info({ port }, "API listening");
} catch (error) {
  console.error(error);
  process.exit(1);
}
