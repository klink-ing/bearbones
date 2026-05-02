import { marker } from "../styled-system/css";

// Module-level marker declarations. The `@bearbones/vite` parser:before hook
// rewrites each `marker(...)` call to a synthesized object literal at build
// time, so this file ships zero runtime code beyond a frozen literal.
export const cardMarker = marker("card");
export const rowMarker = marker("row");
export const outerMarker = marker("outer");
export const innerMarker = marker("inner");
