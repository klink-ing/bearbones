import { group } from "bearbones";

// Module-level group declarations. The `@bearbones/vite` parser:before hook
// rewrites each `group(...)` call to a synthesized object literal at build
// time, so this file ships zero runtime code beyond a frozen literal.
export const cardGroup = group("card");
export const rowGroup = group("row");
