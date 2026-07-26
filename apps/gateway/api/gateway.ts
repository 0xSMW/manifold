// Vercel's standalone Web Request/Response entrypoint; no server listener is started here.
export * from "../src/vercel.js";
import { waitUntil } from "@vercel/functions";
import { createVercelGatewayHandler } from "../src/vercel.js";

const handler = createVercelGatewayHandler({ waitUntil });
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
export const HEAD = handler;
