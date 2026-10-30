import { getApp, config as handlerConfig } from "./_handler.js";

export const config = handlerConfig;

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
