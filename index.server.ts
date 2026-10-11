import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGrokProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createGrokProvider());
  return () => {};
}
